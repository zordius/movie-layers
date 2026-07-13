/**
 * provider-gopro — the adapter that bridges gpx-from-gopro's neutral telemetry
 * export (see its docs/export-contract.md) into movie-layers data channels.
 *
 * Telemetry parsing lives here (in the provider), NOT in movie-layers core: the
 * engine stays format-agnostic and a GoPro MP4 becomes channels the dashboard
 * widgets already consume — `gps`, `speed`, `altitude`, and a derived `gradient`
 * — plus the GPS-derived `timezone`.
 *
 *   import { Engine } from 'movie-layers'
 *   import gopro from 'movie-layers/gopro'
 *   import dashboard from 'movie-layers/dashboard'
 *   new Engine({
 *     baseVideo: 'GH010042.MP4',
 *     providers: [gopro(), dashboard, datetime],
 *     layout: [{ type: 'speed', ... }, { type: 'latlon', ... }, ...],
 *   })
 *
 * `gopro()` reads telemetry from the same file as the base video by default; pass
 * `gopro({ file })` to read from a different source.
 */
// Telemetry extraction lives in the standalone `gpx-from-gopro` package (split out
// of `gpx-stabilizer` core, which is now zero-dep); see its docs/export-contract.md.
import { basename } from 'node:path'

import { readGoproTelemetry } from 'gpx-from-gopro'

import { gradientSamples, speedSamples } from '../gradient.js'

const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * Usable GPS fixes from a raw point list. Filter to a real lock (3d/2d) only when
 * the track actually HAS any — a clip that reports `fix:'none'` on every sample
 * (seen on some GPS5/Hero5 firmware) but carries valid coords is kept rather than
 * dropped to nothing (its GPS clock is then unverified). Stabilized points carry no
 * `fix` at all, so they're kept too. Requires finite lat/lon/time.
 */
function goodFixes(points) {
  const hasGoodFix = points.some((p) => p && (p.fix === '3d' || p.fix === '2d'))
  return points.filter(
    (p) =>
      p &&
      finite(p.lat) &&
      finite(p.lon) &&
      finite(p.time) &&
      (!hasGoodFix || p.fix === '3d' || p.fix === '2d'),
  )
}

/**
 * Append one segment's channel samples to the shared channel arrays, placing each
 * on the GLOBAL playback timeline: `t = offset + (time − anchorUtc)/1000`. The
 * caller passes the segment's wall-clock `anchorUtc` — the regression-verified
 * true start when available, else its first fix — and the engine's playback
 * `offset` (cumulative prior durations) merges segments onto one timeline (§4).
 * Anchoring to the GPS-derived start (not container creation_time) keeps each
 * segment self-consistent and independent of a wrong/missing creation_time.
 *
 * With a verified anchor the first fix lands `lockDelay` seconds into the segment
 * (gray pre-display before GPS lock); with the first-fix fallback it lands at the
 * segment start (pre-lock delay unknown, left out).
 */
function appendSegment(good, anchorUtc, offset, channels, dspeed, W, minSpan, speedWindowSec, ski, maxGap) {
  const ts = good.map((p) => offset + (p.time - anchorUtc) / 1000)
  for (let i = 0; i < good.length; i++) {
    const p = good[i]
    channels.gps.samples.push({ t: ts[i], value: { lat: p.lat, lon: p.lon } })
    if (finite(p.speed)) channels.speed.samples.push({ t: ts[i], value: p.speed * 3.6 }) // m/s → km/h
    if (finite(p.ele)) channels.altitude.samples.push({ t: ts[i], value: p.ele })
  }

  // Gradient (and a derived-speed fallback) via the shared helpers. Cumulative
  // distance is per-segment (segments may be spatially disjoint), so call them
  // here — per segment — not across the whole track. `gapSec: maxGap` makes an
  // elevation hole wide enough to freeze the gauge also RESTART the slope, so the
  // post-hole gradient is never measured against pre-hole points (ski mode drops
  // `ele` around lift boarding / run extremes — see gradient.js). Ski mode also
  // switches the gradient's distance metric to straight-line/chord (gradient.js).
  const pts = good.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: p.ele, t: ts[i] }))
  for (const s of gradientSamples(pts, { windowM: W, minSpan, direct: ski, gapSec: maxGap })) {
    channels.gradient.samples.push(s)
  }
  // derived speed is held aside; only used if the device reported none anywhere (below)
  for (const s of speedSamples(pts, { windowSec: speedWindowSec })) dspeed.push(s)
}

/**
 * Build the GoPro data provider.
 *
 * @param {object} [opts]
 * @param {string} [opts.file]   telemetry source; defaults to the matching base-video source
 * @param {number} [opts.rate]   GPS resample rate in Hz (omit = native ~18 Hz)
 * @param {boolean} [opts.smooth=true]  elevation smoothing → a slope-stable `gradient`.
 *   Default ON; implies cleaning; `stabilize:false` disables it. Implemented via
 *   gpx-stabilizer's `gradeBound` (despike + a 30 m distance-domain smoothing pass —
 *   the standalone `smooth` module was folded into it, 2026-07-10). Only consulted
 *   when NO `opts.mode` is set: a mode preset governs its own elevation handling
 *   (e.g. `MODES.ski` already bundles the same despike-then-smooth).
 * @param {boolean|object} [opts.stabilize]  gpx-stabilizer noise removal; `false`
 *   forces raw points (disables smoothing too). NOTE: cleaning drops each point's
 *   `fix`, so fix-filtering is skipped — it trusts the cleaner to have removed
 *   pre-lock/outlier points. `speed` is dropped too → the GPS-derived fallback fills it.
 * @param {string} [opts.mode]  gpx-stabilizer analysis mode (e.g. "ski" — lift/cable-car
 *   detection + a more aggressive elevation despike); passed straight through to
 *   `stabilize()`'s own `opts.mode` (gpx-stabilizer expands the preset itself). Ignored
 *   when `opts.stabilize === false` (raw — nothing runs `stabilize()` at all).
 * @param {number} [opts.maxGap=3]      seconds; a larger inter-sample gap reads as
 *   "signal lost" (channel goes invalid → widgets dim), e.g. mid-track fix loss
 * @param {number} [opts.gradeWindowM]  distance window (m) the gradient slope is
 *   measured over — wider = smoother, since GPS altitude is noisy per-sample.
 *   Default 15; ski mode (`opts.mode === 'ski'`) defaults to 50 instead — ski slope
 *   readings are about the run's pitch, not per-turn micro-relief, and carving
 *   swings the 15 m window's reading wildly even on a constant-pitch slope
 * @param {boolean} [opts.clockOnly=false]  report ONLY the per-segment GPS clock
 *   candidates + timezone, no telemetry channels — for a `--gpx` render where the
 *   sidecar supplies the telemetry but the embedded GPS supplies the true-UTC
 *   anchors the sidecar aligns against (spec §5 two-phase load; the container's
 *   `creation_time` is a camera clock, often local time stamped as UTC)
 * @param {string} [opts.channelPrefix]  publish channels under prefixed names
 *   (e.g. 'gopro:' → 'gopro:gps') so they never collide with another provider's —
 *   the engine's `channelFill` (gap splicing) reads them as a secondary source
 *   while the sidecar keeps owning the plain names
 * @param {(msg:string)=>void} [opts.onLog]  progress callback — extraction is
 *   sequential, one file at a time (each spawns its own ffmpeg dump + gpx-stabilizer
 *   analysis), so a multi-clip folder can otherwise sit silent for minutes; called
 *   once per file, before it starts
 * @returns {{name, data}} a movie-layers data provider
 */
export default function gopro(opts = {}) {
  return {
    name: 'gopro',
    async data({ sources = [], config = {} }) {
      // Which sources to read telemetry from. An explicit file (factory opt /
      // config) pins ONE source; otherwise every file-bearing base-video segment is
      // read and offset-merged onto the global timeline (§4 multi-video).
      let targets
      const explicitPath = opts.file ?? config.goproFile
      if (explicitPath) {
        const idx = sources.findIndex((s) => s && s.file === explicitPath)
        targets = [
          { path: explicitPath, sourceIndex: idx >= 0 ? idx : 0, offset: idx >= 0 ? sources[idx].offset ?? 0 : 0 },
        ]
      } else {
        targets = sources
          .map((s, i) => (s && s.file ? { path: s.file, sourceIndex: i, offset: s.offset ?? 0 } : null))
          .filter(Boolean)
      }
      if (targets.length === 0) {
        throw new Error(
          'provider-gopro: no telemetry source — pass gopro({ file }) or set a baseVideo',
        )
      }

      const maxGap = opts.maxGap ?? 3
      const W = opts.gradeWindowM ?? (opts.mode === 'ski' ? 50 : 15) // see the gradeWindowM doc above
      // ski mode switches the gradient's distance metric to straight-line/chord
      // between the chosen points — a carving descent reads as the slope's own pitch
      // instead of being diluted by every turn's extra path length (gradient.js doc)
      const skiGrade = opts.mode === 'ski'
      const minSpan = 3 // m — below this, slope is dominated by GPS jitter
      const channels = {
        gps: { unit: 'deg', maxGap, samples: [] },
        speed: { unit: 'km/h', maxGap, samples: [] },
        altitude: { unit: 'm', maxGap, samples: [] },
        gradient: { unit: '%', maxGap, samples: [] },
      }
      const clocks = [] // per-segment GPS wall-clock candidates (§5)
      const dspeed = [] // GPS-derived speed, used only if the device reported none (dashboard-spec §3)
      const speedWindowSec = opts.speedWindowSec ?? 1
      const tzVotes = new Map() // per-file tz candidates → majority wins (below)
      const tzVotesVerified = new Map() // …but votes from regression-VERIFIED files outrank all others
      let hero10 = false // any target is a HERO10 — surfaced for a caller's own UI cue (e.g. --gpx backfill)

      // Elevation smoothing (default ON): gpx-stabilizer rewrites each survivor's `ele`
      // to a slope-stable value, so the derived `gradient` stops jittering (raw GPS
      // altitude is the noisiest axis). The lib's standalone `smooth` module is GONE
      // (folded into gradeBound's optional post-despike pass, 2026-07-10 — passing
      // `smooth: true` through would be a silent no-op now), so modeless smoothing maps
      // to `gradeBound` + the same 30 m window the old module used; a mode preset
      // governs its own elevation handling instead (MODES.ski bundles the identical
      // despike-then-smooth), so `smooth` isn't consulted there. `smooth` requires
      // cleaning, so it forces stabilize on; `stabilize: false` keeps raw points
      // (no clean, no smooth). See docs/gpx-smoothing-integration.md.
      const smooth = opts.smooth ?? true
      const stab =
        opts.stabilize === false
          ? false
          : {
              ...(typeof opts.stabilize === 'object' ? opts.stabilize : {}),
              ...(opts.mode
                ? { mode: opts.mode }
                : smooth
                  ? { gradeBound: { GRADE_SMOOTH_WIN_M: 30 } }
                  : {}),
            }

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        opts.onLog?.(`gopro: telemetry ${i + 1}/${targets.length} — ${basename(target.path)}`)
        const res = await readGoproTelemetry(target.path, {
          ...(opts.rate != null ? { rate: opts.rate } : {}),
          stabilize: stab,
        })
        if (res.meta?.model === 'HERO10') hero10 = true
        const good = goodFixes(res.points)
        if (good.length === 0) continue
        // Anchor on the contract's best start: the regression-verified true-start
        // (so the first fix sits lockDelay into playback, gray before it) when
        // available, else this segment's own first fix (good[0]).
        const verified = res.clock?.verified === true
        if (res.timezone) {
          tzVotes.set(res.timezone, (tzVotes.get(res.timezone) ?? 0) + 1)
          if (verified) tzVotesVerified.set(res.timezone, (tzVotesVerified.get(res.timezone) ?? 0) + 1)
        }
        const anchor = verified && finite(res.startUtc) ? res.startUtc : good[0].time
        if (!opts.clockOnly) {
          appendSegment(good, anchor, target.offset, channels, dspeed, W, minSpan, speedWindowSec, skiGrade, maxGap)
        }
        clocks.push({ sourceIndex: target.sourceIndex, startUtc: anchor, confidence: 'gps', verified })
      }

      // derived-speed fallback (§3): use it only when the device reported NO speed
      // anywhere (e.g. after stabilize). Intermittent device speed stays device-only
      // (the gaps are handled by maxGap hold, not per-point derivation).
      if (channels.speed.samples.length === 0 && dspeed.length) channels.speed.samples = dspeed

      // drop channels that stayed empty (e.g. no altitude anywhere); an
      // opts.channelPrefix namespaces the survivors (secondary-source mode)
      const out = {}
      for (const [name, ch] of Object.entries(channels)) {
        if (ch.samples.length) out[`${opts.channelPrefix ?? ''}${name}`] = ch
      }

      // timezone: MAJORITY vote across files (ties → first seen, Map preserves
      // insertion order) — "first file wins" let one clip with garbage pre-lock
      // GPS points steer the whole render's timezone. Votes from regression-
      // VERIFIED files (internally consistent GPS → trustworthy coordinates)
      // outrank the rest entirely; the full pool only decides when none verified.
      const pool = tzVotesVerified.size ? tzVotesVerified : tzVotes
      const timezone = [...pool.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

      // timezone + per-segment GPS clock candidates flow up to the engine; DataSet
      // captures them and the engine adjudicates per spec §5 (explicit > GPS >
      // creation_time; continue-time fills gaps; gap detection flags real breaks).
      return { channels: out, timezone, clocks, meta: { hero10 } }
    },
  }
}
