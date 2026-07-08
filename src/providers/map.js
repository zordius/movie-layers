/**
 * provider-map — an OpenStreetMap (slippy-map) basemap drawn UNDER the big track
 * widget, projected with the SAME fit as the track so it stays exactly to scale
 * (尺度同步). Optional, off by default: it renders only when a `map` layer is in
 * the layout. It targets the big, fixed whole-track view only — the track's small
 * follow-circle inset keeps its own look and is NOT given a basemap.
 *
 *   { type: 'map', x, y, width, height, cacheDir?, zoom?, opacity?, tileUrl?, userAgent? }
 *
 * The basemap is the same for every frame (the track box and projection are
 * fixed), so the tiles are fetched + composited ONCE in `prepare()` (an async
 * hook the engine awaits before the render loop); `draw()` just blits the result.
 *
 * NOTE: fetching tiles hits a third-party tile server (default tile.openstreetmap.org).
 * Tiles are cached on disk so a re-render reuses them. Respect the tile provider's
 * usage policy (a descriptive User-Agent, no bulk scraping).
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import canvasPkg from '@napi-rs/canvas'

import { Layer, defineProvider } from '../layer.js'
import { projectTrack, lon2tile, lat2tile, tile2lon, tile2lat, chooseZoom, pointInRing } from '../geo.js'

const { createCanvas, loadImage } = canvasPkg

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const DEFAULT_UA = 'movie-layers (OSM basemap overlay; https://github.com/zordius/movie-layers)'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

/** Default on-disk tile cache: `$XDG_CACHE_HOME|~/.cache/movie-layers/tiles`. */
export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'movie-layers', 'tiles')
}

/** Sibling cache dir for resort-name lookups: `$XDG_CACHE_HOME|~/.cache/movie-layers/resorts`. */
export function defaultResortCacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'movie-layers', 'resorts')
}

/**
 * Ski resort name(s) (JA + EN) whose OSM `landuse=winter_sports` boundary overlaps the
 * given bbox, via a single Overpass query — cached to disk per bbox (rounded to ~100m)
 * so a re-render of the same area never re-queries. Returns `[]` on any failure (no
 * network, Overpass rate-limited, etc.) — a missing resort name is never fatal, though
 * `onLog` (if given) reports it so a silent-empty result is diagnosable.
 *
 * Overpass's free shared instance can return HTTP 200 with an HTML "server busy" body
 * INSTEAD of an error status — `res.ok` alone doesn't catch that, so this also verifies
 * the body actually parses as the expected `{ elements: [...] }` shape, with one retry.
 */
async function fetchResortPolys({ north, south, east, west, cacheDir, userAgent, onLog }) {
  const key = `${south.toFixed(3)}_${west.toFixed(3)}_${north.toFixed(3)}_${east.toFixed(3)}`
  const file = join(cacheDir, `${key}.json`)
  if (existsSync(file)) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      /* corrupt cache entry — refetch below */
    }
  }
  const pad = 0.02 // ~2km — a resort boundary can extend slightly past the track's own bbox
  const s = south - pad
  const w = west - pad
  const n = north + pad
  const e = east + pad
  const query =
    `[out:json][timeout:25];` +
    `(way["landuse"="winter_sports"](${s},${w},${n},${e});` +
    `relation["landuse"="winter_sports"](${s},${w},${n},${e}););` +
    `out geom;`

  async function attempt() {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('non-JSON response (Overpass likely overloaded)')
    }
    if (!Array.isArray(data.elements)) throw new Error('unexpected response shape (no elements[])')
    return data
  }

  const polys = []
  let data = null
  try {
    data = await attempt()
  } catch (firstError) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      data = await attempt()
    } catch (secondError) {
      onLog?.(`map: resort lookup failed (${secondError.message}, retried once after "${firstError.message}") — no label`)
    }
  }
  if (!data) return polys // both attempts failed — DON'T cache a failure as "genuinely zero resorts";
  //                          a future re-render should retry fresh instead of being stuck on this forever
  for (const el of data.elements) {
    const ja = el.tags?.name
    if (!ja) continue
    const en = el.tags?.['name:en'] ?? el.tags?.['name:ja-Latn'] ?? ja
    if (el.type === 'way' && el.geometry) polys.push({ ja, en, ring: el.geometry })
    else if (el.type === 'relation' && el.members) {
      for (const m of el.members) if (m.role === 'outer' && m.geometry) polys.push({ ja, en, ring: m.geometry })
    }
  }
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(file, JSON.stringify(polys))
  } catch {
    /* best-effort cache write */
  }
  return polys
}

/** Tile bytes from the disk cache, else fetched and cached. */
async function getTile({ z, x, y, cacheDir, tileUrl, userAgent }) {
  const dir = join(cacheDir, String(z), String(x))
  const file = join(dir, `${y}.png`)
  if (existsSync(file)) return readFile(file)
  const url = tileUrl.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y)
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } })
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dir, { recursive: true })
  await writeFile(file, buf)
  return buf
}

// Resort name resolved by a `map` layer's prepare(), keyed by its box (x,y,w,h) so
// the sibling `map-label` layer (same box, placed LAST in the layout so its text
// always draws on top of the track widget — see cli.js's defaultLayout) can reuse
// it without a second Overpass round-trip. Layout order is map → track → map-label,
// and the engine awaits each layer's prepare() in that same sequential order, so
// `map`'s entry is always populated before `map-label` reads it.
const resortLabelCache = new Map()

/** Run `fn` over `items` with at most `n` in flight; failures resolve to {error}. */
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const idx = i++
      try {
        out[idx] = await fn(items[idx])
      } catch (error) {
        out[idx] = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

class MapLayer extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 0
    this.y = c.y ?? 0
    this.w = c.width ?? 360
    this.h = c.height ?? 360
    this.opacity = c.opacity ?? 1
    this.zoomOverride = c.zoom ?? null
    this.maxZoom = c.maxZoom ?? 19
    this.cacheDir = c.cacheDir ?? defaultCacheDir()
    this.tileUrl = c.tileUrl ?? DEFAULT_TILE_URL
    this.userAgent = c.userAgent ?? DEFAULT_UA
    this.concurrency = c.concurrency ?? 4
    this.onLog = typeof c.onLog === 'function' ? c.onLog : null
    this.resortCacheDir = c.resortCacheDir ?? defaultResortCacheDir()
    this._img = null // offscreen pre-rendered basemap (physical resolution)
    this._labelKey = `${this.x}_${this.y}_${this.w}_${this.h}` // shared with the sibling map-label layer
  }

  /**
   * Fetch + composite the whole basemap once. `data` is the dataset view (whole
   * `gps` series); `scale` is logical→physical, so we render the offscreen at
   * physical resolution and the map stays crisp at 2.7K/4K.
   */
  async prepare({ data, scale = 1 }) {
    const series = data.series('gps')
    if (!series || series.length < 2) return // no track → nothing to map
    const box = { x: this.x, y: this.y, w: this.w, h: this.h }
    const proj = projectTrack(series, box)
    if (!proj) return

    // geographic extent the box covers (invert our projection at its corners)
    const nw = proj.unproject(this.x, this.y)
    const se = proj.unproject(this.x + this.w, this.y + this.h)
    const north = Math.max(nw.lat, se.lat)
    const south = Math.min(nw.lat, se.lat)
    const west = Math.min(nw.lon, se.lon)
    const east = Math.max(nw.lon, se.lon)
    const z = this.zoomOverride ?? chooseZoom(proj.ppm, scale, (north + south) / 2, { max: this.maxZoom })

    // tile index ranges covering the extent (north → smaller tile-y)
    const xa = Math.floor(lon2tile(west, z))
    const xb = Math.floor(lon2tile(east, z))
    const ya = Math.floor(lat2tile(north, z))
    const yb = Math.floor(lat2tile(south, z))
    const tiles = []
    for (let xt = xa; xt <= xb; xt++) for (let yt = ya; yt <= yb; yt++) tiles.push({ xt, yt })

    // offscreen at physical resolution; draw in logical coords, box origin → 0
    const off = createCanvas(Math.max(1, Math.ceil(this.w * scale)), Math.max(1, Math.ceil(this.h * scale)))
    const octx = off.getContext('2d')
    octx.scale(scale, scale)
    octx.translate(-this.x, -this.y)
    octx.beginPath()
    octx.rect(this.x, this.y, this.w, this.h)
    octx.clip()

    // resort-name lookup runs alongside the tile fetch (independent network calls)
    const resortPromise = fetchResortPolys({
      north,
      south,
      east,
      west,
      cacheDir: this.resortCacheDir,
      userAgent: this.userAgent,
      onLog: this.onLog,
    })

    const bufs = await pool(tiles, this.concurrency, (t) =>
      getTile({ z, x: t.xt, y: t.yt, cacheDir: this.cacheDir, tileUrl: this.tileUrl, userAgent: this.userAgent }),
    )
    let ok = 0
    for (let i = 0; i < tiles.length; i++) {
      const buf = bufs[i]
      if (!buf || buf.error) continue
      const { xt, yt } = tiles[i]
      // place each tile by projecting its NW/SE corners through OUR fit — so the
      // basemap and the track (same projection) stay registered to scale.
      const [px0, py0] = proj.project(tile2lat(yt, z), tile2lon(xt, z))
      const [px1, py1] = proj.project(tile2lat(yt + 1, z), tile2lon(xt + 1, z))
      let img
      try {
        img = await loadImage(buf)
      } catch {
        continue
      }
      octx.drawImage(img, px0, py0, px1 - px0, py1 - py0)
      ok++
    }

    // which resort(s) the track actually enters — point-in-polygon against a capped
    // sample of the GPS series, not just "near the box" (a resort's boundary can sit
    // inside the visible extent without the track ever crossing into it)
    const resortPolys = await resortPromise
    if (resortPolys.length) {
      const hitJa = new Set()
      const hitEn = new Set()
      const step = Math.max(1, Math.floor(series.length / 500))
      for (let i = 0; i < series.length; i += step) {
        const v = series[i].value
        if (!v || v.lat == null) continue
        for (const p of resortPolys) {
          if (hitJa.has(p.ja)) continue
          if (pointInRing(v.lat, v.lon, p.ring)) {
            hitJa.add(p.ja)
            hitEn.add(p.en)
          }
        }
      }
      if (hitJa.size) {
        const ja = [...hitJa].join(' / ')
        const en = [...hitEn].join(' / ')
        resortLabelCache.set(this._labelKey, { ja, en })
        this.onLog?.(`map: resort → ${ja}`)
      }
    }

    if (ok === 0) {
      this.onLog?.('map: no tiles rendered (offline / cache miss) — track drawn without a basemap')
      return
    }
    this.onLog?.(`map: ${ok}/${tiles.length} OSM tiles @ z${z}`)
    this._img = off
  }

  draw(ctx) {
    if (!this._img) return
    const prev = ctx.globalAlpha
    if (this.opacity !== 1) ctx.globalAlpha = this.opacity
    ctx.drawImage(this._img, this.x, this.y, this.w, this.h)
    ctx.globalAlpha = prev
  }
}

// Track's bottom-left metric-scale readout (dashboard.js, fixed `600 14px Menlo`,
// drawn at box.x+6) — a resort name right-aligned on the SAME bottom edge must not
// grow left past this, so the JA shrink-to-fit below keeps clear of it.
const SCALE_LABEL_CLEARANCE = 74

// Greedy word-wrap by spaces at the CURRENT ctx.font — used for the EN resort name,
// which (unlike JA) has real word boundaries. Assumes no single word alone exceeds
// maxWidth (left unhandled — the label is short place names, not prose).
function wrapBySpace(ctx, text, maxWidth) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// dark stroke behind the white fill for legibility (snow-covered terrain renders
// very light in OSM's default tile style, so plain white text can otherwise
// disappear into it)
function strokeAndFill(ctx, text, px, py, fontSize) {
  ctx.font = `600 ${fontSize}px sans-serif`
  ctx.lineWidth = Math.max(2, fontSize * 0.18)
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.strokeText(text, px, py)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, px, py)
}

/**
 * Resort-name label, bottom-right of the same box as `map` — a separate layer
 * (not part of `MapLayer.draw()`) purely so it can sit LAST in the layout,
 * drawing on top of the track widget's own panel/grid/line instead of getting
 * covered by them. Reuses `map`'s already-resolved name via `resortLabelCache`
 * rather than re-querying Overpass.
 */
class MapLabelLayer extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 0
    this.y = c.y ?? 0
    this.w = c.width ?? 360
    this.h = c.height ?? 360
    this._key = `${this.x}_${this.y}_${this.w}_${this.h}`
    this._resortJa = null
    this._resortEn = null
  }

  prepare() {
    const hit = resortLabelCache.get(this._key)
    if (hit) {
      this._resortJa = hit.ja
      this._resortEn = hit.en
    }
  }

  draw(ctx, f) {
    if (!this._resortJa) return
    const isJa = Math.floor((f?.timeSec ?? 0) / 10) % 2 === 0
    const label = isJa ? this._resortJa : this._resortEn
    const maxFont = Math.max(12, Math.round(this.h * 0.09))
    const px = this.x + this.w - 8
    const py = this.y + this.h - 8
    ctx.save()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.lineJoin = 'round'

    if (isJa) {
      // JA has no word breaks to wrap at — shrink instead, until the text's left
      // edge clears the bottom-left scale label instead of overlapping it.
      let fontSize = maxFont
      const clearX = this.x + SCALE_LABEL_CLEARANCE
      ctx.font = `600 ${fontSize}px sans-serif`
      while (fontSize > 10 && px - ctx.measureText(label).width < clearX) {
        fontSize -= 1
        ctx.font = `600 ${fontSize}px sans-serif`
      }
      strokeAndFill(ctx, label, px, py, fontSize)
    } else {
      // EN wraps by space instead of shrinking, right-aligned, growing upward from
      // the same bottom-right anchor.
      ctx.font = `600 ${maxFont}px sans-serif`
      const maxWidth = this.w - 16
      const lines = wrapBySpace(ctx, label, maxWidth)
      const lineHeight = maxFont * 1.15
      let y = py
      for (let i = lines.length - 1; i >= 0; i--) {
        strokeAndFill(ctx, lines[i], px, y, maxFont)
        y -= lineHeight
      }
    }
    ctx.restore()
  }
}

export default defineProvider({
  name: 'map',
  layers: {
    map: { needs: ['gps'], create: (c) => new MapLayer(c) },
    'map-label': { create: (c) => new MapLabelLayer(c) },
  },
})
