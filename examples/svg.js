// provider-svg demo: an animated inline SVG (re-rasterized per frame) → svg-out.mp4
// No base video, no telemetry — proves the general-purpose case.
//
//   npm install && npm run example:svg
//
import { Engine } from '../src/index.js'
import svg from '../src/providers/svg.js'

await new Engine({
  width: 640,
  height: 360,
  fps: 30,
  durationSec: 3,
  background: '#101014',
  output: 'svg-out.mp4',
  providers: [svg],
  layout: [
    {
      type: 'svg',
      // SVG markup is a function of the frame → animation
      render: (f) => {
        const cx = 60 + (640 - 120) * f.progress
        const angle = (f.timeSec * 180).toFixed(1)
        return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
          <g transform="translate(${cx.toFixed(1)},180) rotate(${angle})">
            <rect x="-40" y="-40" width="80" height="80" rx="12" fill="#0a84ff"/>
          </g>
          <text x="20" y="44" font-family="sans-serif" font-size="28" fill="#fff">SVG layer · ${(f.progress * 100).toFixed(0)}%</text>
        </svg>`
      },
    },
  ],
}).render()

console.log('wrote svg-out.mp4')
