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
import { readGoproTelemetry } from 'gpx-from-gopro'

import { gradientSamples } from '../gradient.js'

const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * Usable GPS fixes from a raw point list. Raw points carry `fix`; stabilized ones
 * don't (stabilize reduces a point to {lat,lon,ele,time}). Filter to a real lock
 * (3d/2d) when `fix` is present; otherwise trust stabilize to have dropped bad
 * samples. Requires finite lat/lon/time.
 */
function goodFixes(points) {
  const hasFix = points.some((p) => p && p.fix)
  return points.filter(
    (p) =>
      p &&
      finite(p.lat) &&
      finite(p.lon) &&
      finite(p.time) &&
      (!hasFix || p.fix === '3d' || p.fix === '2d'),
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
function appendSegment(good, anchorUtc, offset, channels, W, minSpan) {
  const ts = good.map((p) => offset + (p.time - anchorUtc) / 1000)
  for (let i = 0; i < good.length; i++) {
    const p = good[i]
    channels.gps.samples.push({ t: ts[i], value: { lat: p.lat, lon: p.lon } })
    if (finite(p.speed)) channels.speed.samples.push({ t: ts[i], value: p.speed * 3.6 }) // m/s → km/h
    if (finite(p.ele)) channels.altitude.samples.push({ t: ts[i], value: p.ele })
  }

  // Gradient via the shared helper. Cumulative distance is per-segment (segments
  // may be spatially disjoint), so call it here — per segment — not across the
  // whole track. Pass every good point (with its global `t`); the helper skips
  // non-finite `ele` in the output but still counts it toward distance.
  const pts = good.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: p.ele, t: ts[i] }))
  for (const s of gradientSamples(pts, { windowM: W, minSpan })) channels.gradient.samples.push(s)
}

/**
 * Build the GoPro data provider.
 *
 * @param {object} [opts]
 * @param {string} [opts.file]   telemetry source; defaults to the matching base-video source
 * @param {number} [opts.rate]   GPS resample rate in Hz (omit = native ~18 Hz)
 * @param {boolean|object} [opts.stabilize]  run gpx-stabilizer's noise removal
 *   first. NOTE: stabilize drops each point's `fix`, so fix-filtering is skipped
 *   when on — it trusts stabilize to have removed pre-lock/outlier points.
 * @param {number} [opts.maxGap=3]      seconds; a larger inter-sample gap reads as
 *   "signal lost" (channel goes invalid → widgets dim), e.g. mid-track fix loss
 * @param {number} [opts.gradeWindowM=20]  distance window (m) the gradient slope is
 *   measured over — wider = smoother, since GPS altitude is noisy per-sample
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
      const W = opts.gradeWindowM ?? 20
      const minSpan = 3 // m — below this, slope is dominated by GPS jitter
      const channels = {
        gps: { unit: 'deg', maxGap, samples: [] },
        speed: { unit: 'km/h', maxGap, samples: [] },
        altitude: { unit: 'm', maxGap, samples: [] },
        gradient: { unit: '%', maxGap, samples: [] },
      }
      const clocks = [] // per-segment GPS wall-clock candidates (§5)
      let timezone = null

      for (const target of targets) {
        const res = await readGoproTelemetry(target.path, {
          ...(opts.rate != null ? { rate: opts.rate } : {}),
          ...(opts.stabilize != null ? { stabilize: opts.stabilize } : {}),
        })
        if (timezone == null && res.timezone) timezone = res.timezone // first segment with a tz wins
        const good = goodFixes(res.points)
        if (good.length === 0) continue
        // Anchor on the contract's best start: the regression-verified true-start
        // (so the first fix sits lockDelay into playback, gray before it) when
        // available, else this segment's own first fix (good[0]).
        const verified = res.clock?.verified === true
        const anchor = verified && finite(res.startUtc) ? res.startUtc : good[0].time
        appendSegment(good, anchor, target.offset, channels, W, minSpan)
        clocks.push({ sourceIndex: target.sourceIndex, startUtc: anchor, confidence: 'gps', verified })
      }

      // drop channels that stayed empty (e.g. no altitude anywhere)
      const out = {}
      for (const [name, ch] of Object.entries(channels)) if (ch.samples.length) out[name] = ch

      // timezone + per-segment GPS clock candidates flow up to the engine; DataSet
      // captures them and the engine adjudicates per spec §5 (explicit > GPS >
      // creation_time; continue-time fills gaps; gap detection flags real breaks).
      return { channels: out, timezone, clocks }
    },
  }
}
