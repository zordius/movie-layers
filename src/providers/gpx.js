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
 * Parsing is delegated to `gpx-stabilizer`'s render-agnostic `readGpx` (zero-dep),
 * keeping movie-layers core format-agnostic (spec §0). Channels produced: `gps`
 * ({lat,lon}); `speed` / `altitude` when the track carries them; and `gradient`
 * derived from lat/lon/ele via the shared helper (same as provider-gopro).
 *
 * NOTE (best-clock-wins, spec §5): alignment uses the segment `startUtc` resolved
 * at data-load time (explicit > creation_time) — a GPS clock a video provider
 * derives is folded in LATER (engine `_resolveClocks`), so for a GoPro-video +
 * GPX-merge render the sidecar aligns to the video's container clock, not its
 * GPS-corrected start. Letting an authoritative sidecar clock override a weak
 * video clock is the separate "best-clock-wins" follow-up.
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
    async data({ segments = [], config = {} }) {
      const path = opts.file ?? config.gpxFile
      if (!path) {
        throw new Error('provider-gpx: no sidecar file — pass gpx({ file }) or set dataConfig.gpxFile')
      }
      if (/\.fit$/i.test(path)) {
        // FIT is a binary format needing its own decoder; the UTC-alignment path
        // below is format-agnostic, so a FIT reader can drop in here later.
        throw new Error(
          `provider-gpx: '.fit' is not yet supported (binary format, decoder is a planned follow-up) — ` +
            `convert to .gpx for now (e.g. gpsbabel / a Garmin export)`,
        )
      }

      // Segments that carry a wall clock are the only ones we can align against.
      const anchored = segments.filter((s) => s.startUtc != null)
      if (anchored.length === 0) {
        throw new Error(
          'provider-gpx: no segment has a wall-clock anchor (startUtc) to align the sidecar against — ' +
            'set Engine `startDateTime` / `segments[].startUtc`, or use a base video with a usable clock',
        )
      }

      const { segments: trkSegs } = readGpx(path)
      const good = goodPoints(trkSegs.flat())

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
        throw new Error(
          `provider-gpx: parsed ${good.length} point(s) from ${path} but none fall within the ` +
            `rendered timeline's wall clock — check the sidecar covers the same time window as the footage`,
        )
      }

      // Gradient from the placed points (shared helper). A single sidecar track is
      // spatially contiguous, so compute over the whole placed run — per-segment
      // reset (for a track split across disjoint video segments) is a refinement;
      // for the common N=1 case it is identical.
      for (const s of gradientSamples(placedPts, { windowM: opts.gradeWindowM ?? 15 })) {
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
