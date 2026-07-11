/**
 * Geo helpers shared by the track widget and the OSM basemap so they project a
 * GPS series the SAME way — which is what keeps the basemap and the track line
 * exactly to scale (尺度同步). The track map is a fixed, whole-track view; the
 * projection is a local equirectangular fit (longitude scaled by cos(midLat) so
 * px/metre is isotropic over the small track area).
 */

/**
 * Fit a GPS `series` into a logical box `{ x, y, w, h }` and return a projection.
 * Identical math to the old Track._project, extracted so the map layer reuses it
 * verbatim. `project(lat,lon) → [px,py]`; `unproject(px,py) → {lat,lon}` inverts
 * it (used to find the geographic extent at the box corners). Returns null when
 * the series has no usable points.
 */
export function projectTrack(series, box) {
  const { x, y, w, h } = box
  const pts = series.map((s) => s.value).filter((v) => v && v.lat != null)
  if (pts.length === 0) return null
  const lats = pts.map((p) => p.lat)
  const lons = pts.map((p) => p.lon)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const midLat = (minLat + maxLat) / 2
  const kx = Math.cos((midLat * Math.PI) / 180)
  const spanLat = maxLat - minLat || 1e-6
  const spanLon = (maxLon - minLon || 1e-6) * kx
  const sc = Math.min(w / spanLon, h / spanLat) * 0.9
  const drawW = spanLon * sc
  const drawH = spanLat * sc
  const offx = x + (w - drawW) / 2
  const offy = y + (h - drawH) / 2
  const project = (lat, lon) => [offx + (lon - minLon) * kx * sc, offy + drawH - (lat - minLat) * sc]
  // inverse of `project` (sc px per ° lat; kx makes longitude isotropic)
  const unproject = (px, py) => ({
    lat: minLat + (offy + drawH - py) / sc,
    lon: minLon + (px - offx) / (kx * sc),
  })
  // `sc` is px per ° latitude; kx makes longitude isotropic, so px/metre is the
  // same on both axes (1° lat ≈ 111320 m). (offx, offy+drawH) is world (0,0).
  return { project, unproject, ppm: sc / 111320, offx, offy, drawW, drawH, minLat, minLon, kx, sc }
}

// --- Track-map pan path (green-dot occlusion avoidance) ---------------------
//
// The big track map is a fixed whole-track fit, so the current-position dot can
// wander under the box's own chrome — the top-left inset mini-map, the
// bottom-right place-name label, the bottom-left scale readout — or hug the box
// edge. The fix is to PAN the whole projection (track line + basemap together,
// they share the projection) so the dot keeps clear of those zones.
//
// The pan path is PRECOMPUTED over the whole timeline (so panning is smooth and
// deterministic): sample the dot's projected position, run a forward
// "move-only-when-violated" pass against the safe region (box inset by
// `marginPx`, minus the chrome rects), then alternate centred box-filter
// smoothing with re-projection a few times — the centred window gives natural
// lookahead (the map starts drifting BEFORE the dot reaches a zone), and ending
// on a projection pass keeps the constraints exactly satisfied at the samples.
// Deterministic by construction, so every --jobs chunk child computes the
// identical path and pans stay continuous across chunk seams.

const panPathCache = new Map() // box key → PanPath (shared by track + map layers)

/** Minimal move of point `p` into the safe region (edge-inset box minus rects). */
function projectToSafe(p, safe) {
  let px = Math.min(Math.max(p.x, safe.x0), safe.x1)
  let py = Math.min(Math.max(p.y, safe.y0), safe.y1)
  for (const r of safe.rects) {
    if (px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1) {
      // push out along the axis needing the least movement, staying inside the box
      const moves = [
        { x: r.x0 - px, y: 0, ok: r.x0 >= safe.x0 },
        { x: r.x1 - px, y: 0, ok: r.x1 <= safe.x1 },
        { x: 0, y: r.y0 - py, ok: r.y0 >= safe.y0 },
        { x: 0, y: r.y1 - py, ok: r.y1 <= safe.y1 },
      ]
        .filter((m) => m.ok)
        .sort((a, b) => Math.abs(a.x + a.y) - Math.abs(b.x + b.y))
      if (moves.length) {
        px += moves[0].x
        py += moves[0].y
      }
    }
  }
  return { x: px, y: py }
}

/**
 * Compute (or return the cached) pan path for a track box. Both the track widget
 * and the basemap layer call this with the same `box` — whoever runs first
 * computes it, the other reuses it, so they pan in lockstep. `opts.label`
 * reserves the bottom-right place-name zone (pass true when a map label may
 * draw); the inset mini-map and scale readout zones are always reserved (they
 * are the track widget's defaults).
 *
 * Returns `{ at(tSec) → {dx,dy}, max: {dx0,dx1,dy0,dy1} }` — `max` is the
 * offsets' componentwise range, used by the basemap to render enough bleed.
 */
export function ensurePanPath(series, box, { label = false, marginPx = 20 } = {}) {
  const key = `${box.x}_${box.y}_${box.w}_${box.h}`
  const hit = panPathCache.get(key)
  if (hit) return hit

  const zero = { at: () => ({ dx: 0, dy: 0 }), max: { dx0: 0, dx1: 0, dy0: 0, dy1: 0 } }
  const proj = projectTrack(series, box)
  if (!proj) {
    panPathCache.set(key, zero)
    return zero
  }

  // chrome rects (mirroring the widgets' own geometry), padded so the dot's
  // ring (r = 6, 2x while paused) clears them, not just its centre
  const PAD = 12
  const R = Math.round(Math.min(box.w, box.h) * 0.153) // inset mini-map radius (dashboard.js)
  const maxFont = Math.max(12, Math.round(box.h * 0.09)) // map-label font (map.js)
  const rects = [
    { x0: box.x + 10 - PAD, y0: box.y + 10 - PAD, x1: box.x + 10 + 2 * R + PAD, y1: box.y + 10 + 2 * R + PAD },
    { x0: box.x - PAD, y0: box.y + box.h - 26 - PAD, x1: box.x + 84 + PAD, y1: box.y + box.h + PAD }, // scale readout
    ...(label
      ? [{ x0: box.x + box.w * 0.4, y0: box.y + box.h - (8 + 2.3 * maxFont) - PAD, x1: box.x + box.w + PAD, y1: box.y + box.h + PAD }]
      : []),
  ]
  const safe = {
    x0: box.x + marginPx,
    x1: box.x + box.w - marginPx,
    y0: box.y + marginPx,
    y1: box.y + box.h - marginPx,
    rects,
  }

  // dot position over time — previous-sample HOLD across a >3 s gap (the
  // providers' default channel maxGap freezes the on-screen dot there too)
  const pts = series.filter((s) => s.value && s.value.lat != null)
  if (pts.length < 2) {
    panPathCache.set(key, zero)
    return zero
  }
  const STEP = 0.5
  const t0 = pts[0].t
  const t1 = pts[pts.length - 1].t
  const n = Math.max(1, Math.ceil((t1 - t0) / STEP))
  const dots = []
  let j = 0
  for (let i = 0; i <= n; i++) {
    const t = t0 + i * STEP
    while (j + 1 < pts.length && pts[j + 1].t <= t) j++
    const a = pts[j]
    const b = pts[Math.min(j + 1, pts.length - 1)]
    const span = b.t - a.t
    const f = span > 0 && span <= 3 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0
    const lat = a.value.lat + (b.value.lat - a.value.lat) * f
    const lon = a.value.lon + (b.value.lon - a.value.lon) * f
    const [px, py] = proj.project(lat, lon)
    dots.push({ x: px, y: py })
  }

  // forward pass: the offset moves only when the dot would enter a zone
  let off = { x: 0, y: 0 }
  const offs = dots.map((d) => {
    const p = projectToSafe({ x: d.x + off.x, y: d.y + off.y }, safe)
    off = { x: p.x - d.x, y: p.y - d.y }
    return { ...off }
  })

  // smooth (centred box filter ≈ 3 s) ⇄ re-project, ending on projection
  const W = Math.round(3 / STEP / 2) // half-window samples
  for (let iter = 0; iter < 4; iter++) {
    const sm = offs.map((_, i) => {
      let sx = 0
      let sy = 0
      let c = 0
      for (let k = Math.max(0, i - W); k <= Math.min(offs.length - 1, i + W); k++) {
        sx += offs[k].x
        sy += offs[k].y
        c++
      }
      return { x: sx / c, y: sy / c }
    })
    for (let i = 0; i < offs.length; i++) {
      const p = projectToSafe({ x: dots[i].x + sm[i].x, y: dots[i].y + sm[i].y }, safe)
      offs[i] = { x: p.x - dots[i].x, y: p.y - dots[i].y }
    }
  }

  const max = {
    dx0: Math.min(0, ...offs.map((o) => o.x)),
    dx1: Math.max(0, ...offs.map((o) => o.x)),
    dy0: Math.min(0, ...offs.map((o) => o.y)),
    dy1: Math.max(0, ...offs.map((o) => o.y)),
  }
  const path = {
    at(tSec) {
      const i = (tSec - t0) / STEP
      if (i <= 0) return { dx: offs[0].x, dy: offs[0].y }
      if (i >= offs.length - 1) return { dx: offs[offs.length - 1].x, dy: offs[offs.length - 1].y }
      const lo = Math.floor(i)
      const f = i - lo
      return {
        dx: offs[lo].x + (offs[lo + 1].x - offs[lo].x) * f,
        dy: offs[lo].y + (offs[lo + 1].y - offs[lo].y) * f,
      }
    },
    max,
  }
  panPathCache.set(key, path)
  return path
}

// --- Web Mercator slippy-map tile math (OSM/XYZ scheme) ---

export const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z
export const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}
export const tile2lon = (xt, z) => (xt / 2 ** z) * 360 - 180
export const tile2lat = (yt, z) => {
  const n = Math.PI - (2 * Math.PI * yt) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/**
 * Ray-casting point-in-polygon test — `ring` is an array of `{lat,lon}` forming a closed
 * (or auto-closing) loop. Used to check whether a GPS point falls inside an OSM polygon
 * (e.g. a `landuse=winter_sports` resort boundary fetched from Overpass).
 */
export function pointInRing(lat, lon, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon
    const yi = ring[i].lat
    const xj = ring[j].lon
    const yj = ring[j].lat
    if (yi === yj) continue
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Pick the slippy-map zoom whose tile resolution best matches our render
 * resolution at `lat`. We want physical metres-per-pixel ≈ 1/(ppm·scale), and
 * Mercator gives `156543·cos(lat)/2^z` m/px, so `z = log2(156543·cos·ppm·scale)`.
 * Rounded and clamped to `[min,max]` (OSM serves up to z19).
 */
export function chooseZoom(ppm, scale, lat, { min = 0, max = 19 } = {}) {
  const z = Math.log2(156543.03392 * Math.cos((lat * Math.PI) / 180) * ppm * scale)
  return Math.max(min, Math.min(max, Math.round(z)))
}
