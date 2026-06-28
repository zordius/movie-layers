#!/usr/bin/env node
// movie-layers CLI — point it at a video and it renders an overlay.
//
//   movie-layers GX065132.MP4                 -> GX065132-overlay.mp4 (GoPro auto-dashboard)
//   movie-layers clip.mp4 --gpx ride.gpx      -> overlay from a sidecar .gpx
//   movie-layers clip.mp4 --out out.mp4 --fps 30 --clock-offset -13 --stabilize --no-datetime
//
// A GoPro clip (embedded `gpmd` GPS) automatically gets the full telemetry
// dashboard; the layout is authored in a 1080-tall LOGICAL space and the engine's
// `scaleBaseline` normalizes it, so the gadgets sit correctly at any resolution /
// aspect ratio (2.7K, 4K, 4:3, …), not just 1080p.
import { basename, dirname, extname, join } from 'node:path'

import { Engine, Source } from './index.js'
import gopro from './providers/gopro.js'
import gpx from './providers/gpx.js'
import dashboard from './providers/dashboard.js'
import datetime from './providers/datetime.js'

// Stabilize is the INTENDED default (cleaner GPS → steadier gauges), but today it
// drops the `speed` channel and the elevation-reconstruction (stable gradient)
// work isn't in gpx-stabilizer yet (see its SPEC.md contract) — so enabling it now
// would only lose speed without fixing gradient. It is therefore TEMPORARILY off:
// flip this to `true` once the lib lands speed-carry + elevation smoothing, and the
// default becomes on. `--stabilize` / `--no-stabilize` always override explicitly.
const STABILIZE_READY = false

const USAGE = `movie-layers — render a telemetry overlay onto a video

usage:
  movie-layers <video> [options]

options:
  --out FILE            output path (default: <video>-overlay.mp4, same dir)
  --gpx FILE            use a sidecar .gpx for telemetry instead of embedded GPS
  --fps N               output framerate (default 30)
  --clock-offset SEC    signed seconds added to the wall clock (fix a wrong camera clock)
  --stabilize           clean the GPS noise first (gpx-stabilizer); drops the speed gauge
  --no-stabilize        force raw GPS (stabilize default is currently off; see code)
  --no-datetime         omit the date/time readout
  --baseline N          logical baseline height for gadget scaling (default 1080)
  -h, --help            this help

A GoPro clip is detected by its embedded GPS (gpmd) and gets the full dashboard
(track · speed · latlon · altitude · gradient · datetime) automatically.`

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.help = true
    else if (t === '--no-datetime') a.noDatetime = true
    else if (t === '--stabilize') a.stabilize = true
    else if (t === '--no-stabilize') a.noStabilize = true
    else if (t.startsWith('--')) a[t.slice(2)] = argv[++i] // flag takes the next token
    else a._.push(t)
  }
  return a
}

/**
 * Default telemetry dashboard, authored in a 1080-tall LOGICAL space (the engine's
 * `scaleBaseline` maps it to the real frame, so positions hold at any aspect). The
 * bottom row is laid left→right; widgets are omitted when their channel is absent
 * (e.g. `speed` after `--stabilize`).
 */
function defaultLayout({ hasSpeed, withDatetime }) {
  const row = 985 // bottom row baseline (of 1080)
  const layout = [{ type: 'track', x: 40, y: 40, width: 170, height: 360 }]
  let x = 40
  if (hasSpeed) {
    layout.push({ type: 'speed', x: 40, y: 895 }) // sits above the bottom row, left
  }
  layout.push({ type: 'latlon', x, y: row, windowSec: 4 })
  x += 290
  layout.push({ type: 'altitude', x, y: row })
  x += 200
  layout.push({ type: 'gradient', x, y: row })
  if (withDatetime) layout.push({ type: 'datetime' }) // self-positions top-left
  return layout
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  const input = args._[0]
  const out =
    args.out ?? join(dirname(input), `${basename(input, extname(input))}-overlay.mp4`)
  const fps = args.fps ? Number(args.fps) : 30
  const baseline = args.baseline ? Number(args.baseline) : 1080
  const withDatetime = !args.noDatetime

  // probe: GoPro telemetry present?
  const src = new Source(input)
  let hasGps = false
  try {
    hasGps = await src.hasStream('gpmd')
  } catch (e) {
    console.error(`error: cannot read ${input} — ${e.message}`)
    process.exit(1)
  }

  // choose the data provider: explicit --gpx sidecar > embedded GoPro GPS
  let dataProvider
  let hasSpeed = true
  if (args.gpx) {
    dataProvider = gpx({ file: args.gpx })
  } else if (hasGps) {
    // default = STABILIZE_READY (intended on, temporarily off); flags override
    const stabilize = args.stabilize ? true : args.noStabilize ? false : STABILIZE_READY
    dataProvider = gopro(stabilize ? { stabilize: true } : {})
    if (stabilize) hasSpeed = false // stabilize reduces points to lat/lon/ele/time (drops speed)
  } else {
    console.error(
      `error: no embedded GPS in ${input} and no --gpx given — nothing to overlay.\n` +
        `       pass --gpx FILE for sidecar telemetry, or see --help.`,
    )
    process.exit(1)
  }

  const engine = new Engine({
    baseVideo: input,
    fps,
    scaleBaseline: baseline, // <-- ratio fix: normalize gadget positions to a 1080 logical space
    clockOffsetSec: args['clock-offset'] ? Number(args['clock-offset']) : 0,
    providers: [dataProvider, dashboard, datetime],
    layout: defaultLayout({ hasSpeed, withDatetime }),
    output: out,
  })

  console.log(`rendering ${basename(input)} -> ${out}${args.gpx ? ` (gpx: ${args.gpx})` : hasGps ? ' (GoPro GPS)' : ''}`)
  await engine.render()
  console.log(`done: ${out}`)
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
