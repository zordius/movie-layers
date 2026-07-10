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
 * m, sparse samples (already > windowM apart) use the previous one. The measuring
 * span (either direction) must be a FULL window — `max(minSpan, windowM)` — or the
 * previous value is held: over a shorter denominator the slope is dominated by GPS
 * jitter (a queue/standstill wobbles metres of `ele` over metres of travel, reading
 * as ±100%+ garbage).
 *
 * Elevation holes are HARD breaks, not bridges. Points with a non-finite `ele`
 * are unusable, and where the usable points around them end up > `gapSec` apart
 * in time (the stabilizer's ski mode drops `ele` across lift boarding / a run's
 * highest+lowest points, where the signal is worst) the slope RESTARTS: nothing
 * before the hole — no baseline, no cumulative distance, no held value — leaks
 * into the slope after it. Otherwise the first post-hole slopes are measured
 * against pre-hole points (i.e. across the entire skipped climb) and the gauge
 * lingers near its pre-freeze reading long after the signal returns. `gapSec`
 * should therefore match the channel's `maxGap` (the widget-freeze threshold),
 * so the slope restarts exactly where the gauge un-freezes; the default
 * (Infinity) never time-splits, and brief single-sample `ele` blips stay
 * bridged either way.
 *
 * At a restart (run head, nothing usable behind yet) the slope is measured
 * FORWARD — against the point ≥ `windowM` ahead in the same run — instead of
 * holding a stale/zero value. A run that never travels `windowM` (a standstill
 * blob) is unmeasurable and emits NOTHING: the gauge stays frozen there, which
 * is the honest reading — slope is undefined while not moving.
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
 *   degeneracy (chord → 0 while path grows) is inherent to the metric; the
 *   full-window floor holds the previous value through those instants.
 *
 * Cumulative distance is over the passed array, so the caller groups by
 * spatially-contiguous segment when segments may be disjoint (e.g. gopro calls it
 * per source segment).
 *
 * @param {{lat:number, lon:number, ele:number, t:number}[]} points sorted by t
 * @param {{windowM?:number, minSpan?:number, direct?:boolean, gapSec?:number}} [opts]
 * @returns {{t:number, value:number}[]}
 */
export function gradientSamples(points, { windowM = 20, minSpan = 3, direct = false, gapSec = Infinity } = {}) {
  const out = []
  for (const run of eleRuns(points, gapSec)) {
    if (direct) gradientRunDirect(run, windowM, minSpan, out)
    else gradientRunPath(run, windowM, minSpan, out)
  }
  return out
}

// Usable (finite-`ele`) points, split into runs wherever consecutive usable points
// sit > gapSec apart in time — i.e. across an elevation hole wide enough that the
// gradient channel would read invalid there anyway (see gradientSamples' doc).
function eleRuns(points, gapSec) {
  const runs = []
  let cur = null
  for (const p of points) {
    if (!finite(p.ele)) continue
    if (cur && p.t - cur[cur.length - 1].t > gapSec) cur = null
    if (!cur) runs.push((cur = []))
    cur.push(p)
  }
  return runs
}

// Path-distance variant over ONE run of finite-`ele` points (see gradientSamples' doc).
function gradientRunPath(points, windowM, minSpan, out) {
  const floor = Math.max(minSpan, windowM) // a slope needs a full-window denominator
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + haversineM(points[i - 1], points[i])
  let lo = 0
  let prev = null
  for (let i = 0; i < points.length; i++) {
    while (lo + 1 < i && cum[i] - cum[lo + 1] >= windowM) lo++ // most-recent point ≥ windowM behind
    let g
    if (cum[i] - cum[lo] >= floor) {
      g = ((points[i].ele - points[lo].ele) / (cum[i] - cum[lo])) * 100
    } else if (prev != null) {
      g = prev // not a full window behind yet: hold
    } else {
      // run head — measure forward, against the point ≥ windowM ahead
      let hi = i
      while (hi + 1 < points.length && cum[hi] - cum[i] < floor) hi++
      if (cum[hi] - cum[i] < floor) continue // whole run < windowM (standstill): unmeasurable
      g = ((points[hi].ele - points[i].ele) / (cum[hi] - cum[i])) * 100
    }
    out.push({ t: points[i].t, value: g })
    prev = g
  }
}

// The `direct: true` variant (see gradientSamples' doc), over ONE run of finite-`ele`
// points: baseline = the most-recent earlier point whose STRAIGHT-LINE distance is
// ≥ the full window, and the slope divides by that same chord. Chord distance isn't
// monotone in the index (a turn can bring the track back toward an old point), so
// this scans backward per point instead of keeping a sliding `lo`; the scan stops at
// the first hit, which on real moving data is a handful of samples.
function gradientRunDirect(points, windowM, minSpan, out) {
  const floor = Math.max(minSpan, windowM) // a slope needs a full-window denominator
  let prev = null
  for (let i = 0; i < points.length; i++) {
    let base = -1
    for (let j = i - 1; j >= 0; j--) {
      if (haversineM(points[j], points[i]) >= floor) {
        base = j
        break
      }
    }
    let g
    if (base >= 0) {
      g = ((points[i].ele - points[base].ele) / haversineM(points[base], points[i])) * 100
    } else if (prev != null) {
      g = prev // no full-window chord behind (hairpin / standstill): hold
    } else {
      // run head — measure forward, against the point ≥ windowM ahead
      let fwd = -1
      for (let j = i + 1; j < points.length; j++) {
        if (haversineM(points[i], points[j]) >= floor) {
          fwd = j
          break
        }
      }
      if (fwd < 0) continue // whole run < windowM (standstill): unmeasurable
      g = ((points[fwd].ele - points[i].ele) / haversineM(points[i], points[fwd])) * 100
    }
    out.push({ t: points[i].t, value: g })
    prev = g
  }
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
