// sidecar GPX demo — telemetry from a SEPARATE .gpx file (not embedded in a
// video), UTC-aligned onto the render timeline. No base video here (gray
// background stands in); the engine's startDateTime supplies the wall clock the
// sidecar samples align against.
//
//   npm install && npm run example:gpx
//
import { fileURLToPath } from 'node:url'

import { Engine } from '../src/index.js'
import gpx from '../src/providers/gpx.js'
import dashboard from '../src/providers/dashboard.js'
import datetime from '../src/providers/datetime.js'

// resolve the bundled fixture relative to this file (run from any cwd)
const ride = fileURLToPath(new URL('./ride.gpx', import.meta.url))

await new Engine({
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 8,
  // The sidecar carries absolute UTC; the wall clock here is what its samples
  // align to. ride.gpx truly starts at 13:54:39Z — but say the CAMERA clock was
  // 13s fast, so it stamped 13:54:52Z. clockOffsetSec pulls that back 13s so the
  // sidecar (and the displayed dateTime) line up. Drop both lines and use the
  // real 13:54:39Z if your camera clock is correct.
  startDateTime: '2026-01-16T13:54:52Z', // camera clock, 13s fast
  clockOffsetSec: -13, // fix it: true time = camera − 13s
  timezone: 'UTC',
  background: '#8a9096',
  output: 'gpx-out.mp4',
  providers: [gpx({ file: ride }), dashboard, datetime],
  layout: [
    { type: 'track', x: 5, y: 5, width: 170, height: 360 },
    { type: 'speed', x: 5, y: 914 },
    { type: 'latlon', x: 5, y: 997, windowSec: 2 },
    { type: 'altitude', x: 286, y: 997 },
    { type: 'gradient', x: 471, y: 997 },
    { type: 'datetime' },
  ],
}).render()

console.log('wrote gpx-out.mp4')
