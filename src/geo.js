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
 * Pick the slippy-map zoom whose tile resolution best matches our render
 * resolution at `lat`. We want physical metres-per-pixel ≈ 1/(ppm·scale), and
 * Mercator gives `156543·cos(lat)/2^z` m/px, so `z = log2(156543·cos·ppm·scale)`.
 * Rounded and clamped to `[min,max]` (OSM serves up to z19).
 */
export function chooseZoom(ppm, scale, lat, { min = 0, max = 19 } = {}) {
  const z = Math.log2(156543.03392 * Math.cos((lat * Math.PI) / 180) * ppm * scale)
  return Math.max(min, Math.min(max, Math.round(z)))
}
