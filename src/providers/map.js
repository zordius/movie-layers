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
import { projectTrack, lon2tile, lat2tile, tile2lon, tile2lat, chooseZoom } from '../geo.js'

const { createCanvas, loadImage } = canvasPkg

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const DEFAULT_UA = 'movie-layers (OSM basemap overlay; https://github.com/zordius/movie-layers)'

/** Default on-disk tile cache: `$XDG_CACHE_HOME|~/.cache/movie-layers/tiles`. */
export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'movie-layers', 'tiles')
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
    this._img = null // offscreen pre-rendered basemap (physical resolution)
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

export default defineProvider({
  name: 'map',
  layers: {
    map: { needs: ['gps'], create: (c) => new MapLayer(c) },
  },
})
