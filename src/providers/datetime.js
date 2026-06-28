import { Layer, defineProvider } from '../layer.js'

// style — matches the dashboard provider
const ACCENT = '#83e000' // SPEED green (gauge/needle)
const WHITE = '#ffffff'
const GRAY = '#8a929b'
const PANEL = 'rgba(16,20,24,0.5)'
const MONO = 'Menlo, monospace'

/** Format the engine wall clock in `tz` → zero-padded HH:MM:SS + YYYY/MM/DD. */
function fmt(dt, tz) {
  if (!dt) return { time: '--:--:--', date: '----/--/--', valid: false }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(dt)
  const p = {}
  for (const { type, value } of parts) p[type] = value
  return { time: `${p.hour}:${p.minute}:${p.second}`, date: `${p.year}/${p.month}/${p.day}`, valid: true }
}

/**
 * Single-line date + time readout, top-left. Reads the engine wall clock
 * (frame.dateTime + frame.timezone) — not a data channel. Layout: a SPEED-green
 * dot, then `YYYY/MM/DD HH:MM:SS` (mono, zero-padded so it never jumps). The dot
 * pulses green↔gray on a 1-second cycle (synced to the ticking second when the
 * wall clock is valid, else to playback seconds), like a running heartbeat.
 *
 * Registered with `needsClock`, so the engine fails fast if NO segment has a wall
 * clock — the `--:--:--` placeholder below then only appears on an individual
 * clock-less segment / gap within an otherwise-clocked render, never a whole one.
 */
class DateTime extends Layer {
  constructor(c = {}) {
    super()
    this.margin = c.margin ?? 5
    this.fontSize = c.fontSize ?? 22
  }
  draw(ctx, f) {
    const margin = this.margin
    const fs = this.fontSize
    const padX = 16
    const padY = 11
    const h = fs + padY * 2
    const dotR = Math.round(fs * 0.3)
    const dotGap = 12

    const { time, date, valid } = fmt(f.dateTime, f.timezone)
    const text = `${date} ${time}`
    ctx.font = `600 ${fs}px ${MONO}`
    const textW = ctx.measureText(text).width
    const w = padX + dotR * 2 + dotGap + textW + padX

    const x = margin // top-left via canvas info
    const y = margin
    ctx.fillStyle = PANEL
    ctx.fillRect(x, y, w, h)

    // SPEED-green dot, pulsing green↔gray every second
    const sec = f.dateTime ? Math.floor(f.dateTime.getTime() / 1000) : Math.floor(f.timeSec)
    const cy = y + h / 2
    const dotCx = x + padX + dotR
    ctx.beginPath()
    ctx.arc(dotCx, cy, dotR, 0, Math.PI * 2)
    ctx.fillStyle = sec % 2 === 0 ? ACCENT : GRAY
    ctx.fill()

    // date + time, one line
    ctx.textBaseline = 'middle'
    ctx.fillStyle = valid ? WHITE : GRAY
    ctx.fillText(text, dotCx + dotR + dotGap, cy)
    ctx.textBaseline = 'alphabetic'
  }
}

export default defineProvider({
  name: 'datetime',
  layers: {
    // needsClock: reads the wall clock, so the engine fails fast (before encoding)
    // if no segment resolves a startUtc — rather than render blank `--:--:--`.
    datetime: { needsClock: true, create: (c) => new DateTime(c) },
  },
})
