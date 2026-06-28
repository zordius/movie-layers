#!/usr/bin/env node
// movie-layers CLI — glue clips into one video, with a telemetry overlay when the
// footage carries it. The floor is "stitch the clips together"; the dashboard is
// what it adds on top when there's GPS (embedded or a sidecar .gpx).
//
//   movie-layers GX065132.MP4                 -> GX065132-overlay.mp4 (GoPro auto-dashboard)
//   movie-layers ./ride-folder                -> concat every clip in the folder (sorted)
//   movie-layers a.mp4 b.mp4                   -> concat two clips into one timeline
//   movie-layers clip.mp4 --gpx ride.gpx      -> overlay from a sidecar .gpx
//   movie-layers plain.mp4                     -> no GPS → just encode/concat (no dashboard)
//   movie-layers clip.mp4 --snapshot --at 30  -> one preview PNG at 30 s
//
// A GoPro clip (embedded `gpmd` GPS) automatically gets the full telemetry
// dashboard; the layout is authored in a 1080-tall LOGICAL space and the engine's
// `scaleBaseline` normalizes it, so the gadgets sit correctly at any resolution /
// aspect ratio (2.7K, 4K, 4:3, …), not just 1080p.
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
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

const USAGE = `movie-layers — glue clips into one video, with a telemetry overlay

usage:
  movie-layers <video | dir> [<video | dir> ...] [options]

options:
  --out FILE            output path (default: <first-video>-overlay.mp4 / .png, same dir)
  --snapshot            render one preview PNG instead of a video
  --at SEC              snapshot time in seconds (default: the middle of the clip)
  --open                open the output when done (in the default viewer)
  -q, --quiet           silence the staged log / progress (errors still print)
  --gpx FILE            use a sidecar .gpx for telemetry instead of embedded GPS
  --fps N               output framerate (default 30)
  --clock-offset SEC    signed seconds added to the wall clock (fix a wrong camera clock)
  --stabilize           clean GPS noise first (gpx-stabilizer); speed is derived from GPS
  --no-stabilize        force raw GPS (stabilize default is currently off; see code)
  --no-datetime         omit the date/time readout
  --no-smooth           disable gauge value smoothing (on by default)
  --baseline N          logical baseline height for gadget scaling (default 1080)
  -h, --help            this help

Inputs are clips and/or directories (a directory expands to its videos, sorted);
several inputs concat into one timeline. A GoPro clip (embedded gpmd GPS) gets the
full dashboard automatically; a sidecar .gpx works via --gpx; a clip with no GPS is
simply stitched/encoded (no dashboard).`

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.help = true
    else if (t === '--no-datetime') a.noDatetime = true
    else if (t === '--no-smooth') a.noSmooth = true
    else if (t === '--snapshot') a.snapshot = true
    else if (t === '--open') a.open = true
    else if (t === '--quiet' || t === '-q') a.quiet = true
    else if (t === '--stabilize') a.stabilize = true
    else if (t === '--no-stabilize') a.noStabilize = true
    else if (t.startsWith('--')) a[t.slice(2)] = argv[++i] // flag takes the next token
    else a._.push(t)
  }
  return a
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv'])

/** Human-readable duration: `42s` or `3m07s`. */
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

/** Open a file in the OS default viewer (`--open`), detached so it doesn't block. */
function openFile(path) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(cmd, [path], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
}

/** Expand each input: a directory → its video files (sorted by name); a file → itself. */
export function expandInputs(inputs) {
  const out = []
  for (const a of inputs) {
    let isDir = false
    try {
      isDir = statSync(a).isDirectory()
    } catch {
      /* missing path — keep it so the probe reports a clear read error */
    }
    if (isDir) {
      const vids = readdirSync(a)
        .filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(a, f))
      out.push(...vids)
    } else {
      out.push(a)
    }
  }
  return out
}

/**
 * Default telemetry dashboard, authored in a 1080-tall LOGICAL space (the engine's
 * `scaleBaseline` maps it to the real frame, so positions hold at any resolution).
 * Gadgets hug the edges (M-px margin): datetime top-left corner, track on the left
 * under it, the gauges along the bottom edge. That bottom row spans ~x5..671 and
 * overflows a narrow logical canvas — so for portrait / vertical aspects
 * (`logicalW < ROW_MIN`) the gauges STACK in a left column instead. Widgets are
 * omitted when their channel is absent (e.g. `speed` after `--stabilize`).
 *
 * @param {{hasSpeed:boolean, withDatetime:boolean, logicalW:number}} o
 *   logicalW = baseline × (videoWidth / videoHeight) — the logical canvas width.
 */
export function defaultLayout({ hasSpeed, withDatetime, logicalW = 1920 }) {
  const M = 5 // edge margin (logical px) — hug the corners
  const row = 997 // bottom-row top: panel height ≈ 78 → its bottom sits ~M from 1080
  const ROW_MIN = 690 // the bottom row (latlon+altitude+gradient) spans ~x5..671
  // track hugs the left edge, below the datetime bar (≈44 px tall) so they don't overlap
  const layout = [{ type: 'track', x: M, y: 55, width: 170, height: 360 }]

  if (logicalW >= ROW_MIN) {
    // landscape: gauges along the bottom edge, speed just above the row on the left
    if (hasSpeed) layout.push({ type: 'speed', x: M, y: 914 })
    let x = M
    layout.push({ type: 'latlon', x, y: row, windowSec: 4 })
    x += 281 // latlon panel (276) + M
    layout.push({ type: 'altitude', x, y: row })
    x += 185 // altitude panel (180) + M
    layout.push({ type: 'gradient', x, y: row })
  } else {
    // portrait / narrow: stack the gauges bottom-up along the left edge
    let y = row
    for (const type of ['gradient', 'altitude', 'latlon', ...(hasSpeed ? ['speed'] : [])]) {
      layout.push(type === 'latlon' ? { type, x: M, y, windowSec: 4 } : { type, x: M, y })
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

  // inputs → flat clip list (directories expand to their videos)
  const files = expandInputs(args._)
  if (files.length === 0) {
    console.error(`error: no video files found in: ${args._.join(', ')}`)
    process.exit(1)
  }
  const input = files[0] // first clip drives naming / probing
  const ext = args.snapshot ? 'png' : 'mp4'
  const out =
    args.out ?? join(dirname(input), `${basename(input, extname(input))}-overlay.${ext}`)
  const fps = args.fps ? Number(args.fps) : 30
  const baseline = args.baseline ? Number(args.baseline) : 1080
  const withDatetime = !args.noDatetime
  const log = args.quiet ? () => {} : (...a) => console.log(...a) // --quiet silences stdout info/progress

  // ── Stage 1: inputs + probe ──────────────────────────────────────────────────
  // probe the FIRST clip (concat needs equal dimensions, so it's representative)
  const src = new Source(input)
  let hasGps = false
  let info = null
  let logicalW = baseline * (16 / 9) // fallback aspect if the probe can't size it
  try {
    hasGps = await src.hasStream('gpmd')
    info = await src.info()
    if (info?.width && info?.height) logicalW = baseline * (info.width / info.height)
  } catch (e) {
    console.error(`error: cannot read ${input} — ${e.message}`)
    process.exit(1)
  }
  const label = files.length > 1 ? `${files.length} clips` : basename(input)
  const dims = info?.width ? `${info.width}x${info.height}` : '?'
  log(`movie-layers: ${label}, ${dims}${info?.fps ? ` @ ${info.fps.toFixed(2)}fps` : ''}`)

  // choose the data provider: --gpx sidecar > embedded GoPro GPS > none (pass-through)
  let dataProvider = null
  const hasSpeed = true
  if (args.gpx) {
    dataProvider = gpx({ file: args.gpx })
    log(`  source: sidecar gpx ${args.gpx}`)
  } else if (hasGps) {
    const stabilize = args.stabilize ? true : args.noStabilize ? false : STABILIZE_READY
    dataProvider = gopro(stabilize ? { stabilize: true } : {})
    log(`  source: embedded GoPro GPS${stabilize ? ' (stabilized)' : ''}`)
  } else {
    // pass-through: no telemetry → just stitch/encode the footage (datetime if a clock exists)
    const minimal = withDatetime && info?.creationTime != null ? 'datetime only' : 'no overlay (stitch only)'
    log(`  source: no GPS — telemetry widgets off; ${minimal}`)
  }

  // providers + layout (full dashboard with data; datetime-or-nothing without)
  const providers = dataProvider ? [dataProvider, dashboard, datetime] : [datetime]
  const layout = dataProvider
    ? defaultLayout({ hasSpeed, withDatetime, logicalW })
    : withDatetime && info?.creationTime != null
      ? [{ type: 'datetime' }]
      : []

  const engine = new Engine({
    // 1 clip → baseVideo; many → segments (ffmpeg concat over one logical timeline)
    ...(files.length > 1 ? { segments: files.map((f) => ({ file: f })) } : { baseVideo: input }),
    fps,
    scaleBaseline: baseline, // ratio fix: normalize gadget positions to a 1080 logical space
    clockOffsetSec: args['clock-offset'] ? Number(args['clock-offset']) : 0,
    gaugeSmoothing: !args.noSmooth,
    providers,
    layout,
    output: out,
  })

  // load data once; report what was found
  const { scene, summary } = await engine.prepare()
  if (summary.clock?.startUtc != null) {
    const c = summary.clock
    log(
      `  clock: ${new Date(c.startUtc).toISOString()} (${c.confidence}${c.verified ? ', verified' : ''})` +
        `${summary.timezone ? `, tz ${summary.timezone}` : ''}`,
    )
  }
  for (const [name, ch] of Object.entries(summary.channels)) {
    const range = ch.min != null && ch.max != null ? `  ${ch.min.toFixed(1)}–${ch.max.toFixed(1)} ${ch.unit}` : ''
    log(`  ${name}: ${ch.count} samples${range}`)
  }

  // ── Stage 2: render plan ─────────────────────────────────────────────────────
  log(`widgets: ${summary.layers.join(' · ') || '(none — stitch only)'}`)

  // ── Stage 3: do it ───────────────────────────────────────────────────────────
  const logCmd = (cmd) => log(`  $ ${cmd.join(' ')}`)
  const t0 = Date.now()
  if (args.snapshot) {
    const at = args.at != null ? Number(args.at) : null
    log(`snapshot @ ${at != null ? `${at}s` : 'middle'} → ${out}`)
    await engine.snapshot({ atSec: at, output: out, scene, onCommand: logCmd })
  } else if (summary.layers.length === 0) {
    // no overlay → lossless stream-copy stitch (one ffmpeg call, no per-frame work)
    if (args.fps) console.warn(`note: --fps ${fps} ignored — a pure stitch is a stream copy (no re-encode)`)
    log(`stitching → ${out}`)
    await engine.render({ scene, onCommand: logCmd })
  } else {
    log(`rendering → ${out}  (${summary.frameCount} frames @ ${fps}fps)`)
    const tty = process.stdout.isTTY
    let pct = -1
    let shown = -1
    await engine.render({
      scene,
      onCommand: logCmd,
      onProgress: (i, n) => {
        if (args.quiet) return
        const p = Math.floor((i / n) * 100)
        if (p === pct) return
        pct = p
        const el = (Date.now() - t0) / 1000
        const eta = i > 0 ? (el / i) * (n - i) : 0
        const line = `${String(p).padStart(3)}%  ${i}/${n}  ${fmtDur(el)} elapsed · ETA ${fmtDur(eta)} · ~${fmtDur(el + eta)} total`
        if (tty) {
          process.stdout.write(`\r  ${line}    `) // one updating line in a terminal
        } else if (p % 10 === 0 && p !== shown) {
          shown = p // non-TTY (pipe / CI / file): plain lines at 10% steps, no \r garble
          log(`  ${line}`)
        }
      },
    })
    if (tty && !args.quiet) process.stdout.write('\n')
  }

  // ── Stage 4: done ────────────────────────────────────────────────────────────
  log(`done: ${out}  (${summary.durationSec.toFixed(1)}s, ${dims})  in ${fmtDur((Date.now() - t0) / 1000)}`)
  const c = summary.channels
  const bits = []
  if (c.speed?.max != null) bits.push(`speed ≤ ${c.speed.max.toFixed(1)} ${c.speed.unit}`)
  if (c.altitude?.min != null) bits.push(`alt ${c.altitude.min.toFixed(0)}–${c.altitude.max.toFixed(0)} ${c.altitude.unit}`)
  if (c.gradient?.min != null) bits.push(`grade ${c.gradient.min.toFixed(0)}–${c.gradient.max.toFixed(0)} ${c.gradient.unit}`)
  if (bits.length) log(`  ${bits.join(', ')}`)

  if (args.open) openFile(out)
}

// run only as the CLI entry, so the module can be imported (e.g. for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${e.message}`)
    process.exit(1)
  })
}
