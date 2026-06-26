// Minimal end-to-end demo: an inline provider, no base video, → out.mp4
// Exercises the richer frame: timeSec, progress, dateTime, index/frameCount.
//
//   npm install && npm run example
//
import { Engine, Layer, defineProvider } from '../src/index.js'

// a sliding box — uses playback time
class DemoBox extends Layer {
  constructor(config = {}) {
    super()
    this.color = config.color ?? '#ff3b30'
    this.size = config.size ?? 120
  }

  draw(ctx, frame) {
    const { width, height, timeSec } = frame
    const x = (Math.sin(timeSec * 1.5) * 0.4 + 0.5) * (width - this.size)
    const y = height / 2 - this.size / 2

    ctx.fillStyle = this.color
    ctx.fillRect(x, y, this.size, this.size)

    ctx.fillStyle = '#fff'
    ctx.font = '48px sans-serif'
    ctx.fillText(`t = ${timeSec.toFixed(2)}s`, 40, 80)
  }
}

// a HUD — uses progress (0..1), dateTime (wall clock), and the frame counter
class Hud extends Layer {
  draw(ctx, frame) {
    const { width, height, progress, dateTime, index, frameCount } = frame

    const pad = 40
    const y = height - 60
    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    ctx.fillRect(pad, y, width - pad * 2, 8)
    ctx.fillStyle = '#0a84ff'
    ctx.fillRect(pad, y, (width - pad * 2) * progress, 8)

    ctx.fillStyle = '#fff'
    ctx.font = '28px sans-serif'
    const stamp = dateTime ? dateTime.toISOString() : '(no anchor)'
    ctx.fillText(`${stamp}  ·  ${index + 1}/${frameCount}`, pad, height - 80)
  }
}

const demoProvider = defineProvider({
  name: 'demo',
  layers: {
    'demo-box': (config) => new DemoBox(config),
    hud: () => new Hud(),
  },
})

await new Engine({
  width: 1280,
  height: 720,
  fps: 30,
  inputFps: 30,
  durationSec: 5,
  startDateTime: '2026-06-26T12:00:00Z', // single-segment wall-clock anchor
  timezone: 'UTC',
  background: '#101014',
  output: 'out.mp4',
  providers: [demoProvider],
  layout: [
    { type: 'demo-box', color: '#0a84ff', size: 160 },
    { type: 'hud' },
  ],
}).render()

console.log('wrote out.mp4')
