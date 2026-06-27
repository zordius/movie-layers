import { Layer, defineProvider } from '../layer.js'

// style — matches the dashboard provider
const CYAN = '#4ec3f7'
const WHITE = '#ffffff'
const GRAY = '#8a929b'
const PANEL = 'rgba(16,20,24,0.5)'
const MONO = 'Menlo, monospace'
const FONT = 'sans-serif'

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
 * Time + date readout (two rows, gps-style). Reads the engine wall clock
 * (frame.dateTime + frame.timezone) — not a data channel. Self-anchors to the
 * bottom-right using the canvas size; values are zero-padded so they never jump.
 */
class DateTime extends Layer {
  constructor(c = {}) {
    super()
    this.margin = c.margin ?? 5
    this.w = c.width ?? 250
    this.h = c.height ?? 78
  }
  draw(ctx, f) {
    const { w, h } = this
    const x = f.width - w - this.margin // bottom-right via canvas info
    const y = f.height - h - this.margin

    ctx.fillStyle = PANEL
    ctx.fillRect(x, y, w, h)

    const { time, date, valid } = fmt(f.dateTime, f.timezone)
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = CYAN
    ctx.font = `600 18px ${FONT}`
    ctx.fillText('DATE', x + 16, y + 34)
    ctx.fillText('TIME', x + 16, y + 62)
    ctx.fillStyle = valid ? WHITE : GRAY
    ctx.font = `600 22px ${MONO}`
    ctx.fillText(date, x + 80, y + 34)
    ctx.fillText(time, x + 80, y + 62)
  }
}

export default defineProvider({
  name: 'datetime',
  layers: {
    datetime: (c) => new DateTime(c),
  },
})
