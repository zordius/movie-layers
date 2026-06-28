// dashboard widgets demo — track / altitude / speed / latlon / gradient over a
// synthetic telemetry track. No base video (gray background stands in).
//
//   npm install && npm run example:dashboard
//
import { Engine, defineProvider } from '../src/index.js'
import dashboard from '../src/providers/dashboard.js'
import datetime from '../src/providers/datetime.js'

// synthetic telemetry — one provider, data facet, all five channels
const sample = defineProvider({
  name: 'sample',
  async data() {
    const speed = []
    const altitude = []
    const gradient = []
    const gps = []
    for (let t = 0; t <= 8; t += 0.2) {
      // all sensors "acquire" at t≥1.5s — before that, every widget pre-displays
      // its upcoming first value in gray
      if (t < 1.5) continue
      speed.push({ t, value: 4 + 28 * (0.5 + 0.5 * Math.sin(t)) })
      altitude.push({ t, value: 1100 + 90 * (0.5 + 0.5 * Math.sin(t / 2)) })
      gradient.push({ t, value: -8 + 16 * (0.5 + 0.5 * Math.sin(t / 1.5)) })
      gps.push({ t, value: { lat: 37.6239 + 0.004 * Math.sin(t * 0.9), lon: 140.0342 + 0.004 * Math.cos(t * 0.7) } })
    }
    return {
      channels: {
        speed: { unit: 'km/h', samples: speed },
        altitude: { unit: 'm', samples: altitude },
        gradient: { unit: '%', samples: gradient },
        gps: { unit: 'deg', samples: gps },
      },
    }
  },
})

await new Engine({
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 8,
  startDateTime: '2026-01-16T13:54:39Z', // wall-clock anchor for the datetime widget
  timezone: 'UTC',
  background: '#8a9096', // snow-ish stand-in for a base video
  output: 'dashboard-out.mp4',
  providers: [sample, dashboard, datetime],
  layout: [
    { type: 'track', x: 5, y: 5, width: 170, height: 360 },
    { type: 'speed', x: 5, y: 914 },
    { type: 'latlon', x: 5, y: 997, windowSec: 2 },
    { type: 'altitude', x: 286, y: 997 },
    { type: 'gradient', x: 471, y: 997 },
    { type: 'datetime' }, // self-positions top-left
  ],
}).render()

console.log('wrote dashboard-out.mp4')
