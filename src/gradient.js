/**
 * src/gradient.js — shared kinematic derivations from a position track (slope +
 * speed).
 *
 * Used by provider-gopro (in-video GPS) and provider-gpx (sidecar) so both emit
 * `gradient` (and a derived `speed` fallback) without duplicating the algorithm.
 * Render-agnostic and dependency-free: any source with lat/lon/ele over time can
 * produce these from it.
 */

/** Great-circle horizontal distance between two lat/lon points, in metres. */
export function haversineM(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * Per-point slope (%) for a contiguous run of points already on the global
 * timeline. Gradient = Δaltitude / horizontal-distance over a ~`windowM`-metre
 * baseline (NOT adjacent samples) to tame GPS vertical noise: the baseline is the
 * most-recent earlier point ≥ `windowM` behind — dense samples smooth over ~windowM
 * m, sparse samples (already > windowM apart) use the previous one. Below `minSpan`
 * metres the slope is GPS jitter, so the previous value is held. Points with a
 * non-finite `ele` are skipped in the output but still count toward distance.
 *
 * Two distance metrics, `opts.direct` picks one — BOTH the baseline selection and the
 * slope's denominator use the same metric:
 * - default (path): cumulative along-track distance. The grade you actually ride —
 *   `d(ele)/d(distance travelled)` (a road sign's / bike computer's definition), and a
 *   monotone denominator (numerically stable through hairpins).
 * - `direct: true` (chord): straight-line distance between the two chosen points.
 *   The terrain's own pitch — a carving/traversing descent reads as the SLOPE's
 *   steepness instead of being diluted by the extra path length of every turn (a
 *   skier's definition; provider-gopro turns this on in ski mode). The hairpin
 *   degeneracy (chord → 0 while path grows) is inherent to the metric; `minSpan`
 *   holds the previous value through those instants.
 *
 * Cumulative distance is over the passed array, so the caller groups by
 * spatially-contiguous segment when segments may be disjoint (e.g. gopro calls it
 * per source segment).
 *
 * @param {{lat:number, lon:number, ele:number, t:number}[]} points sorted by t
 * @param {{windowM?:number, minSpan?:number, direct?:boolean}} [opts]
 * @returns {{t:number, value:number}[]}
 */
export function gradientSamples(points, { windowM = 20, minSpan = 3, direct = false } = {}) {
  if (direct) return gradientSamplesDirect(points, { windowM, minSpan })
  const out = []
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + haversineM(points[i - 1], points[i])
  let lo = 0
  let prev = 0
  for (let i = 0; i < points.length; i++) {
    if (!finite(points[i].ele)) continue
    while (lo + 1 < i && cum[i] - cum[lo + 1] >= windowM) lo++ // most-recent point ≥ windowM behind
    const span = cum[i] - cum[lo]
    let g = prev
    if (span >= minSpan && finite(points[lo].ele)) g = ((points[i].ele - points[lo].ele) / span) * 100
    out.push({ t: points[i].t, value: g })
    prev = g
  }
  return out
}

// The `direct: true` variant (see gradientSamples' doc): baseline = the most-recent
// earlier point whose STRAIGHT-LINE distance is ≥ windowM (falling back to the oldest
// point when none is that far, mirroring the path variant's short-window start), and
// the slope divides by that same chord. Chord distance isn't monotone in the index
// (a turn can bring the track back toward an old point), so this scans backward per
// point instead of keeping a sliding `lo`; the scan stops at the first hit, which on
// real moving data is a handful of samples.
function gradientSamplesDirect(points, { windowM, minSpan }) {
  const out = []
  let prev = 0
  for (let i = 0; i < points.length; i++) {
    if (!finite(points[i].ele)) continue
    let base = 0 // fallback: oldest point (short-window start / everything still nearby)
    for (let j = i - 1; j >= 0; j--) {
      if (haversineM(points[j], points[i]) >= windowM) {
        base = j
        break
      }
    }
    let g = prev
    if (base < i && finite(points[base].ele)) {
      const span = haversineM(points[base], points[i])
      if (span >= minSpan) g = ((points[i].ele - points[base].ele) / span) * 100
    }
    out.push({ t: points[i].t, value: g })
    prev = g
  }
  return out
}

/**
 * Per-point horizontal ground speed (km/h) for a contiguous run of points on the
 * global timeline — a **fallback** for when a source has no device-reported speed
 * (e.g. after `stabilize`, which drops it). Distance over a ~`windowSec`-second
 * trailing window (NOT adjacent samples) tames the per-sample GPS noise that
 * differentiating position amplifies; display smoothing (dashboard-spec §2) then
 * polishes the gauge. Caller groups by spatially-contiguous segment (as for slope).
 *
 * @param {{lat:number, lon:number, t:number}[]} points  sorted by t (seconds)
 * @param {{windowSec?:number}} [opts]
 * @returns {{t:number, value:number}[]}  value in km/h
 */
export function speedSamples(points, { windowSec = 1 } = {}) {
  const out = []
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + haversineM(points[i - 1], points[i])
  let lo = 0
  let prev = 0
  for (let i = 0; i < points.length; i++) {
    while (lo + 1 < i && points[i].t - points[lo + 1].t >= windowSec) lo++ // most-recent point ≥ windowSec behind
    const span = points[i].t - points[lo].t
    let v = prev
    if (span > 0) v = ((cum[i] - cum[lo]) / span) * 3.6 // m/s → km/h
    out.push({ t: points[i].t, value: v })
    prev = v
  }
  return out
}
