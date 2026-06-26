// Minimal end-to-end demo: inline layer + data providers, no base video → out.mp4
// Exercises the richer frame (timeSec, progress, dateTime) AND the data layer
// (frame.data.get/stats/unit + needs validation).
//
//   npm install && npm run example
//
import { Engine, Layer, defineProvider, defineDataProvider } from '../src/index.js'

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

// a data-driven layer — reads an interpolated channel + whole-series stats
class SpeedReadout extends Layer {
  draw(ctx, frame) {
    const speed = frame.data.get('speed') // interpolated at frame.timeSec
    const s = frame.data.stats('speed') // whole-series aggregate
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 64px sans-serif'
    ctx.fillText(`${speed.toFixed(1)} ${frame.data.unit('speed')}`, 40, frame.height - 150)
    ctx.font = '24px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText(`max ${s.max.toFixed(1)}`, 40, frame.height - 115)
  }
}

// a data provider: synthetic 1Hz speed track — the engine interpolates between
const dataDemo = defineDataProvider({
  name: 'demo-data',
  async load() {
    const samples = []
    for (let t = 0; t <= 5; t++) samples.push({ t, value: 20 + 15 * Math.sin(t) })
    return { channels: { speed: { unit: 'km/h', samples } }, timeRange: [0, 5] }
  },
})

const demoProvider = defineProvider({
  name: 'demo',
  layers: {
    'demo-box': (config) => new DemoBox(config),
    hud: () => new Hud(),
    'speed-readout': { needs: ['speed'], create: () => new SpeedReadout() },
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
  dataProviders: [dataDemo],
  layout: [
    { type: 'demo-box', color: '#0a84ff', size: 160 },
    { type: 'hud' },
    { type: 'speed-readout' },
  ],
}).render()

console.log('wrote out.mp4')
