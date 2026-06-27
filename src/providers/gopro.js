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
      const path = opts.file ?? config.goproFile ?? sources[0]?.file
      if (!path) {
        throw new Error(
          'provider-gopro: no telemetry source — pass gopro({ file }) or set a baseVideo',
        )
      }

      const { points, timezone, startUtc } = await readGoproTelemetry(path, {
        ...(opts.rate != null ? { rate: opts.rate } : {}),
        ...(opts.stabilize != null ? { stabilize: opts.stabilize } : {}),
      })

      // Zero the channel clock to this segment's wall-clock anchor so channel `t`
      // lines up with the engine's playback `timeSec` (0 at video start). The
      // segment anchor is creation_time today; once the GPS clock-resolution lands
      // (spec §5 / item h) it becomes the GPS start, and this alignment sharpens
      // automatically. Fallbacks keep a telemetry-only (no base video) run working.
      const src = sources.find((s) => s && s.file === path) ?? sources[0] ?? null

      // raw points carry `fix`; stabilized points don't (stabilize reduces a point
      // to {lat,lon,ele,time}). Filter to a usable lock when we still have `fix`;
      // otherwise trust stabilize to have dropped the bad samples.
      const hasFix = points.some((p) => p && p.fix)
      const good = points.filter(
        (p) =>
          p &&
          finite(p.lat) &&
          finite(p.lon) &&
          finite(p.time) &&
          (!hasFix || p.fix === '3d' || p.fix === '2d'),
      )
      if (good.length === 0) {
        return { channels: {}, timezone: timezone ?? null }
      }

      const ref = src?.startUtc ?? startUtc ?? good[0].time
      const ts = good.map((p) => (p.time - ref) / 1000)

      const maxGap = opts.maxGap ?? 3
      const gps = { unit: 'deg', maxGap, samples: [] }
      const speed = { unit: 'km/h', maxGap, samples: [] }
      const altitude = { unit: 'm', maxGap, samples: [] }
      for (let i = 0; i < good.length; i++) {
        const p = good[i]
        gps.samples.push({ t: ts[i], value: { lat: p.lat, lon: p.lon } })
        if (finite(p.speed)) speed.samples.push({ t: ts[i], value: p.speed * 3.6 }) // m/s → km/h
        if (finite(p.ele)) altitude.samples.push({ t: ts[i], value: p.ele })
      }

      // Gradient = Δaltitude / horizontal-distance, measured over a ~gradeWindowM
      // baseline (not adjacent samples) to tame GPS vertical noise. The baseline is
      // the most-recent earlier point at least W behind — so dense samples smooth
      // over ~W m, while sparse samples (steps already > W apart) just use the
      // previous one. Cumulative distance + a monotonic pointer keeps it O(n).
      const gradient = { unit: '%', maxGap, samples: [] }
      const W = opts.gradeWindowM ?? 20
      const minSpan = 3 // m — below this, slope is dominated by GPS jitter
      const cum = [0]
      for (let i = 1; i < good.length; i++) {
        cum[i] = cum[i - 1] + haversineM(good[i - 1], good[i])
      }
      let lo = 0
      let prev = 0
      for (let i = 0; i < good.length; i++) {
        if (!finite(good[i].ele)) continue
        while (lo + 1 < i && cum[i] - cum[lo + 1] >= W) lo++ // most-recent point ≥ W behind
        const span = cum[i] - cum[lo]
        let g = prev
        if (span >= minSpan && finite(good[lo].ele)) {
          g = ((good[i].ele - good[lo].ele) / span) * 100
        }
        gradient.samples.push({ t: ts[i], value: g })
        prev = g
      }

      const channels = { gps }
      if (speed.samples.length) channels.speed = speed
      if (altitude.samples.length) channels.altitude = altitude
      if (gradient.samples.length) channels.gradient = gradient

      // timezone flows up to the engine (DataSet captures the first provider tz);
      // startUtc is returned for the forthcoming GPS clock resolution (item h) —
      // the engine ignores unknown fields today.
      return { channels, timezone: timezone ?? null, startUtc }
    },
  }
}
