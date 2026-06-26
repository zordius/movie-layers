// Minimal end-to-end demo: an inline provider, no base video, → out.mp4
//
//   npm install && npm run example
//
import { Engine, Layer, defineProvider } from '../src/index.js'

// --- a tiny inline provider exposing one layer type: "demo-box" ---
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

const demoProvider = defineProvider({
  name: 'demo',
  layers: {
    'demo-box': (config) => new DemoBox(config),
  },
})

await new Engine({
  width: 1280,
  height: 720,
  fps: 30,
  inputFps: 30,
  durationSec: 5,
  background: '#101014',
  output: 'out.mp4',
  providers: [demoProvider],
  layout: [{ type: 'demo-box', color: '#0a84ff', size: 160 }],
}).render()

console.log('wrote out.mp4')
