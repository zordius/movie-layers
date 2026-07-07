import { Layer, defineProvider } from '../layer.js'
import { Smoother } from '../smooth.js'
import { projectTrack } from '../geo.js'

/**
 * Smoothed display value for a numeric gauge — presentation-only (dashboard-spec
 * §2): glides toward the raw sample with a damped rate of change, holding while
 * invalid. `w.smooth` off → the raw value, unchanged. Positional gauges (track /
 * latlon) intentionally do NOT use this (smoothing a coordinate lags the map).
 */
function shown(w, sample, dt) {
  if (!w.smooth) return sample.value
  w._sm ??= new Smoother({ smoothTime: w.smoothTime })
  return w._sm.step(sample.value, dt, sample.valid)
}

// --- style (from sample.png) ---
const ACCENT = '#83e000' // lime green icons / track dot
const ACCENT_DIM = '#080' // the mini-map's "travelled long ago" trail, so recent travel
//   (full ACCENT) reads as visually distinct from old travel
const RECENT_TRAIL_SEC = 10 // mini-map: how far back "just travelled" extends, fading from
//   full opacity (now) to RECENT_TRAIL_MIN_ALPHA (oldest end) — the ring's own clip (not
//   this) is what caps its visible length if travel is faster than this window
const RECENT_TRAIL_MIN_ALPHA = 0.3 // opacity at the oldest end of the recent-trail window
const CYAN = '#4ec3f7' // "SPEED" label
const BLUE = '#1e6fd0' // altitude bar remainder
const PANEL = 'rgba(16,20,24,0.65)' // slightly more opaque than the original 0.5 — a panel that
//   blends less with the shifting base video underneath is more temporally stable, which
//   the codec compresses more cleanly (less ringing at the text edges on top of it)
const WHITE = '#ffffff'
const GRAY = '#8a929b' // provisional value (pre-fix / no signal) — dimmed
const GRID = 'rgba(255,255,255,0.15)' // track-map grid lines
const FONT = 'sans-serif'
const MONO = 'Menlo, monospace' // fixed-width for numeric values (no jitter)
const H = 78 // unified panel height across widgets

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PANEL
  ctx.fillRect(x, y, w, h)
}

// round up to a "nice" 1/2/5 × 10ⁿ value (for a readable metric grid step)
function nice125(x) {
  const p = 10 ** Math.floor(Math.log10(x))
  const f = x / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}
// metric label: 50cm / 2m / 1km
function fmtMeters(m) {
  if (m >= 1000) return `${+(m / 1000).toFixed(1)}km`
  if (m >= 1) return `${+m.toFixed(0)}m`
  return `${Math.round(m * 100)}cm`
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
// interpolate a gps {lat,lon} from a t-sorted series at time `t` (binary search + lerp)
function gpsAt(series, t) {
  const p = series
  if (!p.length) return null
  if (t <= p[0].t) return p[0].value
  if (t >= p[p.length - 1].t) return p[p.length - 1].value
  let lo = 0
  let hi = p.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (p[m].t <= t) lo = m
    else hi = m
  }
  const a = p[lo].value
  const b = p[hi].value
  if (!a || !b) return a || b
  const f = p[hi].t - p[lo].t ? (t - p[lo].t) / (p[hi].t - p[lo].t) : 0
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
}

// interpolate a numeric channel value from its t-sorted series at time `t`
function scalarAt(series, t) {
  const p = series
  if (!p.length) return null
  if (t <= p[0].t) return p[0].value
  if (t >= p[p.length - 1].t) return p[p.length - 1].value
  let lo = 0
  let hi = p.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (p[m].t <= t) lo = m
    else hi = m
  }
  const a = p[lo]
  const b = p[hi]
  const f = b.t - a.t ? (t - a.t) / (b.t - a.t) : 0
  return a.value + (b.value - a.value) * f
}

// compass bearing (radians; 0 = N, + = clockwise/E) of travel over the last `win`
// seconds, or null when barely moving (heading undefined).
function headingRad(series, t, win) {
  const cur = gpsAt(series, t)
  const past = gpsAt(series, t - win)
  if (!cur || !past) return null
  const lat0 = (((cur.lat + past.lat) / 2) * Math.PI) / 180
  const east = (cur.lon - past.lon) * Math.cos(lat0)
  const north = cur.lat - past.lat
  if (Math.hypot(east, north) < 1e-7) return null
  return Math.atan2(east, north)
}

// fixed zoom for a moving window (computed once → consistent density, only pans)
// Fixed-zoom inset projection: `mppPx` screen pixels per ground metre (constant — no
// longer a function of speed/window). Returns px-per-° latitude `scale` and the
// longitude isotropy factor `kx` (at the track's median latitude).
function reticleScale(series, mppPx) {
  const pts = series.filter((s) => s.value && s.value.lat != null)
  if (pts.length < 2) return null
  const kx = Math.cos((pts[pts.length >> 1].value.lat * Math.PI) / 180)
  return { scale: mppPx * 111320, kx } // px/° lat = mppPx px/m × 111320 m/°
}

// moving-window mini-map: whole track gray + travelled green, centred on the current
// position, with a reticle. (Lifted from the old latlon widget; now a map inset.)
function drawMovingWindow(ctx, cx, cy, R, series, f, sg, sc) {
  ctx.fillStyle = 'rgba(0,0,0,0.45)' // backing disc for contrast over the big map
  ctx.beginPath()
  ctx.arc(cx, cy, R + 2, 0, Math.PI * 2)
  ctx.fill()
  const g = sg.value ?? { lat: 0, lon: 0 }
  // Render the full moving-window map whenever we have a scale + a position — INCLUDING
  // the freeze state (held value / no signal), where the picture is kept as-is and only
  // the centre dot greys out (below). Crosshair fallback is just the no-position case.
  if (sc && sg.value) {
    const { scale, kx } = sc
    const px = (p) => cx + (p.lon - g.lon) * kx * scale
    const py = (p) => cy - (p.lat - g.lat) * scale
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.clip()
    // 20 m × 20 m grid anchored to multiple-of-20-metre ground coordinates (not the dot),
    // so it slides under the moving centre as the rider travels. Fixed zoom (10 m = 10 px).
    const STEP = 20 // grid cell, metres
    const mpp = scale / 111320 // px per metre
    if (Number.isFinite(mpp) && mpp > 0) {
      const spanM = R / mpp // metres from centre to ring
      const e0 = g.lon * kx * 111320 // current easting, metres
      const n0 = g.lat * 111320 // current northing, metres
      ctx.strokeStyle = GRID
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let e = Math.ceil((e0 - spanM) / STEP) * STEP; e <= e0 + spanM; e += STEP) {
        const x = cx + (e - e0) * mpp
        ctx.moveTo(x, cy - R)
        ctx.lineTo(x, cy + R)
      }
      for (let nm = Math.ceil((n0 - spanM) / STEP) * STEP; nm <= n0 + spanM; nm += STEP) {
        const y = cy - (nm - n0) * mpp
        ctx.moveTo(cx - R, y)
        ctx.lineTo(cx + R, y)
      }
      ctx.stroke()
    }
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = GRAY
    ctx.beginPath()
    let on = false
    for (const s of series) {
      if (!s.value || s.value.lat == null) continue
      on ? ctx.lineTo(px(s.value), py(s.value)) : (ctx.moveTo(px(s.value), py(s.value)), (on = true))
    }
    ctx.stroke()
    // travelled-so-far, dim — the "long ago" base layer (still distinct from the
    // untravelled GRAY track, but duller than the recent highlight drawn next)
    ctx.strokeStyle = ACCENT_DIM
    ctx.beginPath()
    on = false
    for (const s of series) {
      if (!s.value || s.value.lat == null) continue
      if (s.t > f.timeSec) break
      on ? ctx.lineTo(px(s.value), py(s.value)) : (ctx.moveTo(px(s.value), py(s.value)), (on = true))
    }
    if (on) ctx.lineTo(cx, cy)
    ctx.stroke()
    // just-travelled — the last RECENT_TRAIL_SEC of travel, drawn over the dim layer
    // above, fading from full opacity (now) down to RECENT_TRAIL_MIN_ALPHA (the oldest
    // end of the window). A single stroke can't vary alpha along its length, so this
    // draws one short segment per sample pair, each with its own interpolated alpha. If
    // travel is fast enough that this would reach past the ring, the ring's own clip
    // (set above) caps its visible length, not this window.
    const recentStart = f.timeSec - RECENT_TRAIL_SEC
    const recentPts = series.filter((s) => s.value && s.value.lat != null && s.t >= recentStart && s.t <= f.timeSec)
    const recentSpan = f.timeSec - recentStart
    for (let i = 1; i < recentPts.length; i++) {
      const a = recentPts[i - 1]
      const b = recentPts[i]
      const frac = recentSpan > 0 ? Math.max(0, Math.min(1, (b.t - recentStart) / recentSpan)) : 1
      const alpha = RECENT_TRAIL_MIN_ALPHA + (1 - RECENT_TRAIL_MIN_ALPHA) * frac
      ctx.strokeStyle = `rgba(131, 224, 0, ${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(px(a.value), py(a.value))
      ctx.lineTo(px(b.value), py(b.value))
      ctx.stroke()
    }
    if (recentPts.length) {
      const last = recentPts[recentPts.length - 1]
      ctx.strokeStyle = ACCENT // the closing stitch to the current dot itself — full opacity
      ctx.beginPath()
      ctx.moveTo(px(last.value), py(last.value))
      ctx.lineTo(cx, cy)
      ctx.stroke()
    }
    ctx.restore()
    ctx.strokeStyle = CYAN // ring + ticks in the SPEED label colour
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.stroke()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx * R, cy + dy * R)
      ctx.lineTo(cx + dx * (R - 5), cy + dy * (R - 5))
      ctx.stroke()
    }
    // pulsing halo around the centre dot — a regular "ping": expands + fades on a
    // 1.2 s cycle (driven by playback time, so every render is identical). Frozen
    // (held / no signal) → no pulse and the dot greys out; the rest of the picture stays.
    if (sg.valid) {
      const P = 1 // s — one ping per second
      const phase = (f.timeSec % P) / P // 0→1 ramp, then restart (expand only, no contract)
      ctx.fillStyle = `rgba(131, 224, 0, ${(0.35 * (1 - phase)).toFixed(3)})` // ACCENT, fading out as it grows
      ctx.beginPath()
      ctx.arc(cx, cy, 5 + 12 * phase, 0, Math.PI * 2)
      ctx.fill()
    }
    // white backing ring, slightly larger than the dot — the travelled path underneath
    // is drawn in the same ACCENT green, so the dot needs contrast to stay visible on it
    ctx.fillStyle = WHITE
    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = sg.valid ? ACCENT : GRAY
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fill()
  } else {
    crosshairIcon(ctx, cx, cy, 13, sg.valid ? ACCENT : GRAY)
  }
}

// north-up compass: ring + cardinal ticks + 'N' + an arrow toward the smoothed
// heading. `cs`/`sn` are the smoothed cos/sin of the bearing (null → no arrow).
function drawCompass(ctx, cx, cy, R, cs, sn, valid) {
  const col = valid ? ACCENT : GRAY
  ctx.strokeStyle = col
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 2
  for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
    ctx.beginPath()
    ctx.moveTo(cx + dx * R, cy + dy * R)
    ctx.lineTo(cx + dx * (R - 5), cy + dy * (R - 5))
    ctx.stroke()
  }
  ctx.fillStyle = col
  ctx.font = `600 11px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', cx, cy - R + 8)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if (cs != null && sn != null && (cs || sn)) {
    const mag = Math.hypot(cs, sn) || 1
    const ux = sn / mag // east → +x
    const uy = -cs / mag // north → −y (up)
    const tip = R - 4
    const ax = cx + ux * tip
    const ay = cy + uy * tip
    ctx.strokeStyle = col
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(ax, ay)
    ctx.stroke()
    const bx = cx + ux * (tip - 8)
    const by = cy + uy * (tip - 8)
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx - uy * 5, by + ux * 5)
    ctx.lineTo(bx + uy * 5, by - ux * 5)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = col
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fill()
}

// --- widgets ---
class Speed extends Layer {
  constructor(c = {}) {
    super()
    this.x = c.x ?? 40
    this.y = c.y ?? 40
    this.digits = c.digits ?? 3 // value width: 3 = up to 999; set 4 for aircraft
    this.smooth = c.smooth ?? true // presentation smoothing (dashboard-spec §2), default on
    this.smoothTime = c.smoothTime ?? 0.35
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 146 + this.digits * 22 // panel widens to fit the value width
    const h = H
    panel(ctx, x, y, w, h)
    const sp = f.data.sample('speed')
    const spd = shown(this, sp, f.dt) ?? 0
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
    this.windowSec = c.windowSec ?? 3 // heading averaged over the last ~N s of travel
    this.smoothTime = c.smoothTime ?? 0.4
    this._cos = new Smoother({ smoothTime: this.smoothTime }) // smooth heading as a unit
    this._sin = new Smoother({ smoothTime: this.smoothTime }) //   vector (wrap-safe)
  }

  draw(ctx, f) {
    const { x, y } = this
    const w = 276
    const h = H
    panel(ctx, x, y, w, h)

    const sg = f.data.sample('gps')
    const g = sg.value ?? { lat: 0, lon: 0 }
    const cx = x + 34
    const cy = y + h / 2
    const R = 26
    // heading compass: bearing of travel, angular-smoothed via its (cos,sin) vector
    // (avoids the 359°→0° wrap) with the same critically-damped follow as the gauges.
    const series = f.data.series('gps') ?? []
    const hd = sg.valid ? headingRad(series, f.timeSec, this.windowSec) : null
    const moving = hd != null
    const cs = this._cos.step(moving ? Math.cos(hd) : null, f.dt, moving)
    const sn = this._sin.step(moving ? Math.sin(hd) : null, f.dt, moving)
    drawCompass(ctx, cx, cy, R, cs, sn, sg.valid)

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
    this.smooth = c.smooth ?? true
    this.smoothTime = c.smoothTime ?? 0.35
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 180
    const h = H
    panel(ctx, x, y, w, h)
    const sa = f.data.sample('altitude')
    const v = shown(this, sa, f.dt) ?? 0
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
    this.smooth = c.smooth ?? true
    this.smoothTime = c.smoothTime ?? 0.35
  }
  draw(ctx, f) {
    const { x, y } = this
    const w = 200
    const h = H
    panel(ctx, x, y, w, h)
    const sgr = f.data.sample('gradient')
    const g = shown(this, sgr, f.dt) ?? 0 // smoothed gradient → the number + the slope-line angle

    // altitude mini-profile: a ±10 s window, vertically centred on the current altitude
    const bx = x + 12
    const by = y + 12
    const bw = 50
    const bh = h - 24
    const ccx = bx + bw / 2
    const ccy = by + bh / 2
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(bx, by, bw, bh)
    const alt = f.data.series('altitude') ?? []
    const half = 10 // seconds each side of "now"
    if (alt.length) {
      const cur = scalarAt(alt, f.timeSec) ?? 0
      const N = bw
      const ys = []
      for (let i = 0; i <= N; i++) ys.push(scalarAt(alt, f.timeSec - half + (i / N) * 2 * half))
      const vs = 2 // fixed scale: 1 m = 2 px (no dynamic zoom)
      ctx.save()
      ctx.beginPath()
      ctx.rect(bx, by, bw, bh)
      ctx.clip()
      // solid blue (altitude colour), filled up from the bottom of the block. Build
      // the whole filled region as ONE path so it can double as the clip for the
      // gridlines (which must show only inside the blue).
      const bottom = by + bh
      ctx.beginPath()
      let i = 0
      while (i <= N) {
        if (ys[i] == null) {
          i++
          continue
        }
        const start = i
        ctx.moveTo(bx + (start / N) * bw, bottom)
        let last = start
        while (i <= N && ys[i] != null) {
          ctx.lineTo(bx + (i / N) * bw, ccy - (ys[i] - cur) * vs)
          last = i
          i++
        }
        ctx.lineTo(bx + (last / N) * bw, bottom)
        ctx.closePath()
      }
      ctx.fillStyle = BLUE
      ctx.fill()
      // 5 m horizontal gridlines, snapped to integer 5 m, clipped to the blue region
      ctx.clip()
      ctx.strokeStyle = WHITE
      ctx.lineWidth = 1
      const span = bh / 2 / vs // metres visible each side of centre
      ctx.beginPath()
      for (let m = Math.ceil((cur - span) / 5) * 5; m <= cur + span; m += 5) {
        const py = ccy - (m - cur) * vs // no pixel-snap: must glide in sync with the fill
        ctx.moveTo(bx, py)
        ctx.lineTo(bx + bw, py)
      }
      ctx.stroke()
      ctx.restore()
    }

    // grade slope-line through the centre dot (angle = atan(grade%/100); rotation is
    // damped since `g` is the smoothed gradient)
    const ang = Math.atan(g / 100) // + = uphill
    const L = bw / 2
    const dx = Math.cos(ang)
    const dy = -Math.sin(ang) // up = −y
    ctx.strokeStyle = sgr.valid ? ACCENT : GRAY
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(ccx - L * dx, ccy - L * dy)
    ctx.lineTo(ccx + L * dx, ccy + L * dy)
    ctx.stroke()
    // centre dot = current altitude (green, altitude colour)
    ctx.fillStyle = sgr.valid ? ACCENT : GRAY
    ctx.beginPath()
    ctx.arc(ccx, ccy, 3, 0, Math.PI * 2)
    ctx.fill()

    // label + number (kept)
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
    this.w = c.width ?? 360
    this.h = c.height ?? 360
    this.grid = c.grid ?? true // semi-transparent panel + metric grid behind the track
    this.inset = c.inset ?? true // moving-window mini-map in the top-left corner
    this._ret = undefined // cached inset zoom (computed once)
  }
  // Shared with provider-map (geo.js) so a basemap drawn UNDER this widget uses
  // the identical fit and stays exactly to scale (尺度同步).
  _project(series) {
    return projectTrack(series, { x: this.x, y: this.y, w: this.w, h: this.h })
  }
  draw(ctx, f) {
    const series = f.data.series('gps')
    if (!series || series.length < 2) return
    const p = this._project(series)
    if (!p) return
    const { project, ppm, offx, offy, drawH } = p

    // semi-transparent panel + metric grid (cell = a nice 1/2/5 m value whose on-screen
    // step is ≥ 40 px), behind the track
    if (this.grid) {
      panel(ctx, this.x, this.y, this.w, this.h)
      if (ppm > 0 && Number.isFinite(ppm)) {
        const cell = nice125(40 / ppm) // metres
        const gpx = cell * ppm // ≥ 40 px
        ctx.save()
        ctx.beginPath()
        ctx.rect(this.x, this.y, this.w, this.h)
        ctx.clip()
        ctx.strokeStyle = GRID
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let gx = offx - Math.floor((offx - this.x) / gpx) * gpx; gx <= this.x + this.w; gx += gpx) {
          ctx.moveTo(gx, this.y)
          ctx.lineTo(gx, this.y + this.h)
        }
        const baseY = offy + drawH // world north = 0
        for (let gy = baseY - Math.floor((baseY - this.y) / gpx) * gpx; gy <= this.y + this.h; gy += gpx) {
          ctx.moveTo(this.x, gy)
          ctx.lineTo(this.x + this.w, gy)
        }
        ctx.stroke()
        ctx.restore()
        ctx.fillStyle = GRAY
        ctx.font = `600 14px ${MONO}`
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(fmtMeters(cell), this.x + 6, this.y + this.h - 6)
      }
    }

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
        const [px, py] = project(v.lat, v.lon)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }
    // current position dot
    const cs = f.data.sample('gps')
    const cur = cs.value
    if (cur && cur.lat != null) {
      const [px, py] = project(cur.lat, cur.lon)
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.beginPath()
      ctx.arc(px, py, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = cs.valid ? ACCENT : GRAY
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fill()
    }

    // moving-window inset (zoomed, current-position-centred) in the top-left corner
    if (this.inset) {
      const R = Math.round(Math.min(this.w, this.h) * 0.153) // ~15% of the box (85% of the old 18%)
      const icx = this.x + R + 10
      const icy = this.y + R + 10
      if (this._ret === undefined) this._ret = reticleScale(series, 1) // fixed 10 m = 10 px (1 px/m)
      drawMovingWindow(ctx, icx, icy, R, series, f, cs, this._ret)
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
