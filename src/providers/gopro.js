/**
 * provider-gopro — the adapter that bridges gpx-stabilizer's neutral telemetry
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
// NOTE: gpx-stabilizer is mid-monorepo-split (its docs/monorepo-split.md). The
// telemetry surface (readGoproTelemetry et al.) moves OUT of core into the
// `gpx-from-gopro` package. Once that split lands, change this import — and the
// movie-layers dependency — from 'gpx-stabilizer' to 'gpx-from-gopro' (core
// becomes zero-dep and won't export telemetry).
import { readGoproTelemetry } from 'gpx-stabilizer'

/** Great-circle horizontal distance between two lat/lon points, in metres. */
function haversineM(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

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
 * on the GLOBAL playback timeline: `t = segment offset + seconds-since-this-
 * segment's-first-fix`. Zeroing within-segment to the first fix (good[0]) — not
 * to container creation_time — keeps each segment's GPS self-consistent and
 * independent of a wrong/missing creation_time; adding the engine's playback
 * `offset` (cumulative prior durations) merges segments onto one timeline (§4).
 *
 * NOTE (step 2a): first-fix is treated as the segment start, ignoring any pre-lock
 * delay; the regression-verified true-start refinement is a later step (§5). For
 * continuous GoPro chapters only chapter 1 has meaningful delay (the receiver
 * stays locked across the rollover), so later segments' first-fix ≈ true start.
 *
 * @returns {number|null} the segment's first-fix UTC (its wall-clock anchor), or
 *   null when the segment has no usable fix.
 */
function appendSegment(good, offset, channels, W, minSpan) {
  if (good.length === 0) return null
  const ref = good[0].time
  const ts = good.map((p) => offset + (p.time - ref) / 1000)
  for (let i = 0; i < good.length; i++) {
    const p = good[i]
    channels.gps.samples.push({ t: ts[i], value: { lat: p.lat, lon: p.lon } })
    if (finite(p.speed)) channels.speed.samples.push({ t: ts[i], value: p.speed * 3.6 }) // m/s → km/h
    if (finite(p.ele)) channels.altitude.samples.push({ t: ts[i], value: p.ele })
  }

  // Gradient = Δaltitude / horizontal-distance over a ~W-metre baseline (not
  // adjacent samples) to tame GPS vertical noise: the baseline is the most-recent
  // earlier point ≥ W behind — dense samples smooth over ~W m, sparse samples
  // (steps already > W apart) use the previous one. Cumulative distance is
  // per-segment (resets each segment, since segments may be spatially disjoint).
  const cum = [0]
  for (let i = 1; i < good.length; i++) cum[i] = cum[i - 1] + haversineM(good[i - 1], good[i])
  let lo = 0
  let prev = 0
  for (let i = 0; i < good.length; i++) {
    if (!finite(good[i].ele)) continue
    while (lo + 1 < i && cum[i] - cum[lo + 1] >= W) lo++ // most-recent point ≥ W behind
    const span = cum[i] - cum[lo]
    let g = prev
    if (span >= minSpan && finite(good[lo].ele)) g = ((good[i].ele - good[lo].ele) / span) * 100
    channels.gradient.samples.push({ t: ts[i], value: g })
    prev = g
  }
  return ref
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
        const ref = appendSegment(goodFixes(res.points), target.offset, channels, W, minSpan)
        if (ref != null) clocks.push({ sourceIndex: target.sourceIndex, startUtc: ref, confidence: 'gps' })
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
