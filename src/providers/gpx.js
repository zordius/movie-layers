/**
 * provider-gpx — a SIDECAR data provider: telemetry that lives in a separate
 * file (a Garmin/Strava `.gpx`), not embedded in the base video.
 *
 * The defining difference from an embedded provider (e.g. provider-gopro) is time
 * alignment (spec §3): a sidecar's samples carry an ABSOLUTE wall clock (UTC), so
 * the engine can't just add a segment offset — each sample is placed on the global
 * playback timeline by matching its UTC against the segments' `startUtc` anchors:
 *
 *     t_global = segment.offset + (sampleUtc − segment.startUtc) / 1000
 *
 * A sample whose UTC falls outside every segment's wall-clock window is dropped
 * (it was recorded before/after/between the rendered footage).
 *
 *   import { Engine } from 'movie-layers'
 *   import gpx from 'movie-layers/gpx'
 *   import dashboard from 'movie-layers/dashboard'
 *   new Engine({
 *     // a wall clock is required to align against — from a base video's clock,
 *     // explicit segments[].startUtc, or Engine startDateTime:
 *     startDateTime: '2026-01-16T13:54:39Z',
 *     durationSec: 8,
 *     providers: [gpx({ file: 'ride.gpx' }), dashboard],
 *     layout: [{ type: 'speed' }, { type: 'latlon' }, ...],
 *   })
 *
 * Multiple sidecars (`gpx({ files: [...] })`) merge into one point pool before
 * alignment — each point still resolves to its own segment purely by wall clock
 * (below), so this covers both "one .gpx per clip" and "one continuous track
 * that happens to be split across files" without any extra bookkeeping.
 *
 * Parsing is delegated to `gpx-stabilizer`'s render-agnostic `readGpx` (zero-dep),
 * keeping movie-layers core format-agnostic (spec §0). Channels produced: `gps`
 * ({lat,lon}); `speed` / `altitude` when the track carries them; and `gradient`
 * derived from lat/lon/ele via the shared helper (same as provider-gopro).
 *
 * NOTE (clock ordering, spec §5): this provider is marked `needsClock: true`, so
 * the engine loads it in the SECOND data round — after every clock-producing
 * provider (e.g. provider-gopro's per-segment GPS clocks) has loaded and
 * `_resolveClocks` has upgraded the segment anchors. A GoPro-video + GPX-merge
 * render therefore aligns the sidecar against the GPS-corrected start (true UTC),
 * not the container's `creation_time` (a camera clock — often LOCAL time stamped
 * with a `Z`). Without any GPS clock the anchors stay structural
 * (explicit > creation_time), and a wrong camera clock still needs the manual
 * `clockOffsetSec` — a sidecar has no `cts` link to the frames, so it can never
 * anchor the video by itself (spec §5 "wrong camera clock").
 */
import { readGpx } from 'gpx-stabilizer'

import { gradientSamples, speedSamples } from '../gradient.js'

const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * Usable points for UTC alignment: finite lat/lon AND a finite `time` (the wall
 * clock we align on). When the track carries `<fix>`, keep only a real lock
 * (3d/2d); otherwise trust the recording (most Garmin/Strava GPX omit `<fix>`).
 */
function goodPoints(points) {
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
 * Build a sidecar GPX data provider.
 *
 * @param {object} [opts]
 * @param {string} [opts.file]   path to the `.gpx` sidecar (else `config.gpxFile`)
 * @param {string[]} [opts.files]  multiple sidecars, merged (else `config.gpxFiles`);
 *   takes precedence over `opts.file` if both are given
 * @param {string} [opts.name]   provider name for channel-merge precedence (default 'gpx')
 * @param {number} [opts.maxGap=3]  seconds; a larger inter-sample gap reads as
 *   "signal lost" (channel goes invalid → widgets dim)
 * @param {number} [opts.gradeWindowM=15]  distance window (m) the gradient slope is
 *   measured over — wider = smoother, since GPS altitude is noisy per-sample
 * @returns {{name, data}} a movie-layers data provider
 */
export default function gpx(opts = {}) {
  const name = opts.name ?? 'gpx'
  return {
    name,
    // sidecar alignment reads segment wall clocks → load AFTER clock resolution
    needsClock: true,
    async data({ segments = [], config = {} }) {
      const paths = opts.files ?? config.gpxFiles ?? (opts.file ?? config.gpxFile ? [opts.file ?? config.gpxFile] : null)
      if (!paths || paths.length === 0) {
        throw new Error(
          'provider-gpx: no sidecar file — pass gpx({ file }) / gpx({ files }) or set dataConfig.gpxFile/gpxFiles',
        )
      }
      for (const path of paths) {
        if (/\.fit$/i.test(path)) {
          // FIT is a binary format needing its own decoder; the UTC-alignment path
          // below is format-agnostic, so a FIT reader can drop in here later.
          throw new Error(
            `provider-gpx: '.fit' is not yet supported (binary format, decoder is a planned follow-up) — ` +
              `convert to .gpx for now (e.g. gpsbabel / a Garmin export): ${path}`,
          )
        }
      }

      // Segments that carry a wall clock are the only ones we can align against.
      const anchored = segments.filter((s) => s.startUtc != null)
      if (anchored.length === 0) {
        throw new Error(
          'provider-gpx: no segment has a wall-clock anchor (startUtc) to align the sidecar against — ' +
            'set Engine `startDateTime` / `segments[].startUtc`, or use a base video with a usable clock',
        )
      }

      // merge every sidecar's points into one pool — each point's own UTC (below)
      // decides which segment it belongs to, so multiple files resolve exactly
      // like a single one.
      const good = []
      for (const path of paths) {
        let trkSegs
        try {
          ;({ segments: trkSegs } = readGpx(path))
        } catch (e) {
          throw new Error(`provider-gpx: failed to read ${path} — ${e.message}`)
        }
        // plain loop, not `good.push(...points)` — a real-world GPX can carry tens of
        // thousands of points, and spreading that many into one call blows V8's argument
        // limit ("Maximum call stack size exceeded")
        for (const p of goodPoints(trkSegs.flat())) good.push(p)
      }
      // channel samples and the gradient/speed helpers below assume ascending time;
      // multiple files aren't guaranteed to be given in chronological order (e.g. one
      // per clip, listed in a different order than they were recorded).
      good.sort((a, b) => a.time - b.time)

      const maxGap = opts.maxGap ?? 3
      const channels = {
        gps: { unit: 'deg', maxGap, samples: [] },
        speed: { unit: 'km/h', maxGap, samples: [] },
        altitude: { unit: 'm', maxGap, samples: [] },
        gradient: { unit: '%', maxGap, samples: [] },
      }
      const placedPts = [] // {lat,lon,ele,t} of in-window points, for the gradient helper

      let placed = 0
      for (const p of good) {
        // first segment whose wall-clock window [startUtc, startUtc+duration) holds this sample
        const seg = anchored.find(
          (s) => p.time >= s.startUtc && p.time < s.startUtc + s.durationSec * 1000,
        )
        if (!seg) continue // recorded before / after / between the rendered footage
        const t = seg.offset + (p.time - seg.startUtc) / 1000
        channels.gps.samples.push({ t, value: { lat: p.lat, lon: p.lon } })
        if (finite(p.speed)) channels.speed.samples.push({ t, value: p.speed * 3.6 }) // m/s → km/h
        if (finite(p.ele)) channels.altitude.samples.push({ t, value: p.ele })
        placedPts.push({ lat: p.lat, lon: p.lon, ele: p.ele, t })
        placed++
      }

      if (placed === 0) {
        const iso = (ms) => new Date(ms).toISOString()
        const gpxRange = good.length
          ? `${iso(good[0].time)} … ${iso(good[good.length - 1].time)}`
          : '(no timestamped points)'
        const videoRange =
          `${iso(Math.min(...anchored.map((s) => s.startUtc)))} … ` +
          `${iso(Math.max(...anchored.map((s) => s.startUtc + s.durationSec * 1000)))}`
        throw new Error(
          `provider-gpx: parsed ${good.length} point(s) from ${paths.join(', ')} but none fall within the ` +
            `rendered timeline's wall clock — gpx range ${gpxRange}, video range ${videoRange} — ` +
            `check the sidecar(s) cover the same time window as the footage`,
        )
      }

      // Gradient from the placed points (shared helper). A single sidecar track is
      // spatially contiguous, so compute over the whole placed run — per-segment
      // reset (for a track split across disjoint video segments) is a refinement;
      // for the common N=1 case it is identical. `gapSec: maxGap` restarts the
      // slope across an elevation hole wide enough to freeze the gauge, so the
      // post-hole gradient never measures against pre-hole points (gradient.js).
      for (const s of gradientSamples(placedPts, { windowM: opts.gradeWindowM ?? 15, gapSec: maxGap })) {
        channels.gradient.samples.push(s)
      }

      // derived-speed fallback (§3): only when the sidecar carried no <speed> at all
      if (channels.speed.samples.length === 0 && placedPts.length > 1) {
        for (const s of speedSamples(placedPts, { windowSec: opts.speedWindowSec ?? 1 })) {
          channels.speed.samples.push(s)
        }
      }

      // drop channels that stayed empty (e.g. a track with no <ele>)
      const out = {}
      for (const [n, ch] of Object.entries(channels)) if (ch.samples.length) out[n] = ch
      return { channels: out }
    },
  }
}
