import { Layer, defineProvider } from '../layer.js'

// --- style (from sample.png) ---
const ACCENT = '#83e000' // lime green icons / track dot
const CYAN = '#4ec3f7' // "SPEED" label
const BLUE = '#1e6fd0' // altitude bar remainder
const PANEL = 'rgba(16,20,24,0.5)'
const WHITE = '#ffffff'
const GRAY = '#8a929b' // provisional value (pre-fix / no signal) — dimmed
const FONT = 'sans-serif'
const MONO = 'Menlo, monospace' // fixed-width for numeric values (no jitter)
const H = 78 // unified panel height across widgets

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PANEL
  ctx.fillRect(x, y, w, h)
}

// degrees → N37° 37' 26.1"
function dms(deg, pos, neg, degW = 2) {
  const hemi = deg >= 0 ? pos : neg
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const mf = (a - d) * 60
  const m = Math.floor(mf)
  const s = ((mf - m) * 60).toFixed(1)
  return `${hemi}${String(d).padStart(degW, ' ')}° ${String(m).padStart(2, '0')}' ${s.padStart(4, '0')}"`
}

// draw a DMS line: hemisphere letter (N/E/S/W) in CYAN, the rest in WHITE
function coordLine(ctx, str, x, y, valid = true) {
  ctx.fillStyle = CYAN
  ctx.fillText(str[0], x, y)
  const hw = ctx.measureText(str[0]).width
  ctx.fillStyle = valid ? WHITE : GRAY
  ctx.fillText(str.slice(1), x + hw, y)
}

// --- icons ---
function gaugeIcon(ctx, cx, cy, r, color, frac = 0) {
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 0.25 * Math.PI) // open at bottom (270° dial)
  ctx.stroke()
  // needle sweeps the dial: frac 0 → lower-left, 0.5 → up, 1 → lower-right
  const a = 0.75 * Math.PI + Math.max(0, Math.min(1, frac)) * 1.5 * Math.PI
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + r * 0.78 * Math.cos(a), cy + r * 0.78 * Math.sin(a))
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fill()
}
function crosshairIcon(ctx, cx, cy, r, color) {
  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath()
    ctx.moveTo(cx + dx * r, cy + dy * r)
    ctx.lineTo(cx + dx * (r + 5), cy + dy * (r + 5))
    ctx.stroke()
  }
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fill()
}
function slopeIcon(ctx, x, y, s, color) {
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(x, y + s)
  ctx.lineTo(x + s, y + s)
  ctx.lineTo(x + s, y)
  ctx.closePath()
  ctx.stroke()
}

// --- widgets ---
class Speed extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 40
    this.digits = c.digits ?? 3 // value width: 3 = up to 999; set 4 for aircraft
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 146 + this.digits * 22 // panel widens to fit the value width
    const h = H
    panel(ctx, x, y, w, h)
    const sp = f.data.sample('speed')
    const spd = sp.value ?? 0
    const max = f.data.stats('speed')?.max ?? 0
    gaugeIcon(ctx, x + 38, y + 44, 20, ACCENT, max > 0 ? spd / max : 0)
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = CYAN
    ctx.font = `600 18px ${FONT}`
    ctx.fillText('SPEED', x + 78, y + 28)
    const v = String(Math.round(spd)).padStart(this.digits, ' ')
    const unit = (f.data.unit('speed') ?? 'km/h').toUpperCase()
    ctx.fillStyle = sp.valid ? WHITE : GRAY
    ctx.font = `700 36px ${MONO}`
    ctx.fillText(v, x + 78, y + 62)
    const nw = ctx.measureText(v).width
    ctx.fillStyle = CYAN
    ctx.font = `600 18px ${FONT}`
    ctx.fillText(unit, x + 78 + nw + 8, y + 62)
  }
}

class Latlon extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 150
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 276
    const h = H
    panel(ctx, x, y, w, h)
    crosshairIcon(ctx, x + 32, y + h / 2, 13, ACCENT)
    const sg = f.data.sample('gps')
    const g = sg.value ?? { lat: 0, lon: 0 }
    ctx.font = `600 22px ${MONO}`
    ctx.textBaseline = 'alphabetic'
    coordLine(ctx, dms(g.lat, 'N', 'S', 3), x + 66, y + 34, sg.valid)
    coordLine(ctx, dms(g.lon, 'E', 'W', 3), x + 66, y + 62, sg.valid)
  }
}

class Altitude extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 250
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 180
    const h = H
    panel(ctx, x, y, w, h)
    const sa = f.data.sample('altitude')
    const v = sa.value ?? 0
    const unit = f.data.unit('altitude') ?? 'm'
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'center'
    ctx.fillStyle = sa.valid ? WHITE : GRAY
    ctx.font = `700 38px ${MONO}`
    const num = String(Math.round(v)).padStart(4, ' ')
    ctx.fillText(num, x + w / 2 - 8, y + 40)
    const nw = ctx.measureText(num).width
    ctx.fillStyle = CYAN
    ctx.font = `600 18px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(unit, x + w / 2 - 8 + nw / 2 + 4, y + 40)
    // bar: green fill (position in min..max) + blue remainder
    const s = f.data.stats('altitude')
    const frac = s && s.max > s.min ? (v - s.min) / (s.max - s.min) : 0
    const bx = x + 16
    const by = y + h - 18
    const bw = w - 32
    ctx.fillStyle = BLUE
    ctx.fillRect(bx, by, bw, 8)
    ctx.fillStyle = ACCENT
    ctx.fillRect(bx, by, Math.max(8, bw * frac), 8)
    ctx.textAlign = 'left'
  }
}

class Gradient extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 350
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 200
    const h = H
    panel(ctx, x, y, w, h)
    slopeIcon(ctx, x + 22, y + 24, 26, ACCENT)
    const sgr = f.data.sample('gradient')
    const g = sgr.value ?? 0
    ctx.fillStyle = CYAN
    ctx.font = `600 18px ${FONT}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('GRADIENT', x + 70, y + 28)
    ctx.fillStyle = sgr.valid ? WHITE : GRAY
    ctx.font = `700 32px ${MONO}`
    const gstr = `${g >= 0 ? '+' : '-'}${Math.abs(g).toFixed(1).padStart(4, ' ')}%`
    ctx.fillText(gstr, x + 70, y + 60)
  }
}

class Track extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 40
    this.w = c.width ?? 160
    this.h = c.height ?? 320
  }
  _project(series) {
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
    const sc = Math.min(this.w / spanLon, this.h / spanLat) * 0.9
    const drawW = spanLon * sc
    const drawH = spanLat * sc
    const offx = this.x + (this.w - drawW) / 2
    const offy = this.y + (this.h - drawH) / 2
    return (lat, lon) => [offx + (lon - minLon) * kx * sc, offy + drawH - (lat - minLat) * sc]
  }
  draw(ctx, f) {
    const series = f.data.series('gps')
    if (!series || series.length < 2) return
    const proj = this._project(series)
    if (!proj) return

    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // dark outline then white line
    for (const [color, width] of [['rgba(0,0,0,0.5)', 6], [WHITE, 3]]) {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      series.forEach((s, i) => {
        const v = s.value
        if (!v || v.lat == null) return
        const [px, py] = proj(v.lat, v.lon)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }
    // current position dot
    const cs = f.data.sample('gps')
    const cur = cs.value
    if (cur && cur.lat != null) {
      const [px, py] = proj(cur.lat, cur.lon)
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.beginPath()
      ctx.arc(px, py, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = cs.valid ? ACCENT : GRAY
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export default defineProvider({
  name: 'dashboard',
  layers: {
    track: { needs: ['gps'], create: (c) => new Track(c) },
    altitude: { needs: ['altitude'], create: (c) => new Altitude(c) },
    speed: { needs: ['speed'], create: (c) => new Speed(c) },
    latlon: { needs: ['gps'], create: (c) => new Latlon(c) },
    gradient: { needs: ['gradient'], create: (c) => new Gradient(c) },
  },
})
