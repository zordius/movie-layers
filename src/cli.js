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
import { fileURLToPath } from 'node:url'

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
  movie-layers <video> [<video> ...] [options]

options:
  --out FILE            output path (default: <first-video>-overlay.mp4 / .png, same dir)
  --snapshot           render one preview PNG instead of a video
  --at SEC             snapshot time in seconds (default: the middle of the clip)
  --gpx FILE            use a sidecar .gpx for telemetry instead of embedded GPS
  --fps N               output framerate (default 30)
  --clock-offset SEC    signed seconds added to the wall clock (fix a wrong camera clock)
  --stabilize           clean GPS noise first (gpx-stabilizer); speed is derived from GPS
  --no-stabilize        force raw GPS (stabilize default is currently off; see code)
  --no-datetime         omit the date/time readout
  --no-smooth           disable gauge value smoothing (on by default)
  --baseline N          logical baseline height for gadget scaling (default 1080)
  -h, --help            this help

A GoPro clip is detected by its embedded GPS (gpmd) and gets the full dashboard
(track · speed · latlon · altitude · gradient · datetime) automatically. Pass
several clips (same resolution / fps — parts of one trip) to concat them into a
single timeline; their telemetry is offset-merged across the join.`

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.help = true
    else if (t === '--no-datetime') a.noDatetime = true
    else if (t === '--no-smooth') a.noSmooth = true
    else if (t === '--snapshot') a.snapshot = true
    else if (t === '--stabilize') a.stabilize = true
    else if (t === '--no-stabilize') a.noStabilize = true
    else if (t.startsWith('--')) a[t.slice(2)] = argv[++i] // flag takes the next token
    else a._.push(t)
  }
  return a
}

/**
 * Default telemetry dashboard, authored in a 1080-tall LOGICAL space (the engine's
 * `scaleBaseline` maps it to the real frame, so positions hold at any resolution).
 * The gauges normally form a bottom ROW (landscape), but that row spans ~x40..730
 * and overflows a narrow logical canvas — so for portrait / vertical aspects
 * (`logicalW < ROW_MIN`) they STACK in a left column instead. Widgets are omitted
 * when their channel is absent (e.g. `speed` after `--stabilize`).
 *
 * @param {{hasSpeed:boolean, withDatetime:boolean, logicalW:number}} o
 *   logicalW = baseline × (videoWidth / videoHeight) — the logical canvas width.
 */
export function defaultLayout({ hasSpeed, withDatetime, logicalW = 1920 }) {
  const ROW_MIN = 760 // the bottom row (latlon+altitude+gradient) needs ~this much width
  const layout = [{ type: 'track', x: 40, y: 40, width: 170, height: 360 }]

  if (logicalW >= ROW_MIN) {
    // landscape: gauges along the bottom, speed above the row on the left
    if (hasSpeed) layout.push({ type: 'speed', x: 40, y: 895 })
    let x = 40
    layout.push({ type: 'latlon', x, y: 985, windowSec: 4 })
    x += 290
    layout.push({ type: 'altitude', x, y: 985 })
    x += 200
    layout.push({ type: 'gradient', x, y: 985 })
  } else {
    // portrait / narrow: stack the gauges bottom-up along the left edge
    let y = 985
    for (const type of ['gradient', 'altitude', 'latlon', ...(hasSpeed ? ['speed'] : [])]) {
      layout.push(type === 'latlon' ? { type, x: 40, y, windowSec: 4 } : { type, x: 40, y })
      y -= 90
    }
  }

  if (withDatetime) layout.push({ type: 'datetime' }) // self-positions top-left
  return layout
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  const files = args._ // one or more clips, concatenated in order
  const input = files[0] // first clip drives naming / probing
  const ext = args.snapshot ? 'png' : 'mp4'
  const out =
    args.out ?? join(dirname(input), `${basename(input, extname(input))}-overlay.${ext}`)
  const fps = args.fps ? Number(args.fps) : 30
  const baseline = args.baseline ? Number(args.baseline) : 1080
  const withDatetime = !args.noDatetime

  // probe the FIRST clip: GoPro telemetry present? + geometry (for the responsive
  // layout). Concat requires identical dimensions, so the first is representative.
  const src = new Source(input)
  let hasGps = false
  let logicalW = baseline * (16 / 9) // fallback aspect if the probe can't size it
  try {
    hasGps = await src.hasStream('gpmd')
    const info = await src.info()
    if (info?.width && info?.height) logicalW = baseline * (info.width / info.height)
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
    // stabilize drops device speed, but provider-gopro now derives it from GPS
    // (dashboard-spec §3), so the speed gauge stays — no need to omit it.
  } else {
    console.error(
      `error: no embedded GPS in ${input} and no --gpx given — nothing to overlay.\n` +
        `       pass --gpx FILE for sidecar telemetry, or see --help.`,
    )
    process.exit(1)
  }

  const engine = new Engine({
    // 1 clip → baseVideo; many → segments (ffmpeg concat over one logical timeline)
    ...(files.length > 1 ? { segments: files.map((f) => ({ file: f })) } : { baseVideo: input }),
    fps,
    scaleBaseline: baseline, // <-- ratio fix: normalize gadget positions to a 1080 logical space
    clockOffsetSec: args['clock-offset'] ? Number(args['clock-offset']) : 0,
    gaugeSmoothing: !args.noSmooth,
    providers: [dataProvider, dashboard, datetime],
    layout: defaultLayout({ hasSpeed, withDatetime, logicalW }),
    output: out,
  })

  const what = args.gpx ? ` (gpx: ${args.gpx})` : hasGps ? ' (GoPro GPS)' : ''
  const src_ = files.length > 1 ? `${files.length} clips` : basename(input)
  if (args.snapshot) {
    const at = args.at != null ? Number(args.at) : null
    console.log(`snapshot ${src_} @ ${at != null ? `${at}s` : 'middle'} -> ${out}${what}`)
    await engine.snapshot({ atSec: at, output: out })
  } else {
    console.log(`rendering ${src_} -> ${out}${what}`)
    await engine.render()
  }
  console.log(`done: ${out}`)
}

// run only as the CLI entry, so the module can be imported (e.g. for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${e.message}`)
    process.exit(1)
  })
}
