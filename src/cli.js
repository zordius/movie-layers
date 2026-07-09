#!/usr/bin/env node
// movie-layers CLI — glue clips into one video, with a telemetry overlay when the
// footage carries it. The floor is "stitch the clips together"; the dashboard is
// what it adds on top when there's GPS (embedded or a sidecar .gpx).
//
//   movie-layers GX065132.MP4                 -> GX065132-overlay.mp4 (GoPro auto-dashboard)
//   movie-layers ./ride-folder                -> concat every clip in the folder (sorted)
//   movie-layers a.mp4 b.mp4                   -> concat two clips into one timeline
//   movie-layers clip.mp4 --gpx ride.gpx      -> overlay from a sidecar .gpx
//   movie-layers a.mp4 b.mp4 --gpx a.gpx,b.gpx -> one sidecar .gpx per clip, or a dir of them
//   movie-layers plain.mp4                     -> no GPS → just encode/concat (no dashboard)
//   movie-layers clip.mp4 --snapshot --at 30  -> one preview PNG at 30 s
//
// A GoPro clip (embedded `gpmd` GPS) automatically gets the full telemetry
// dashboard; the layout is authored in a 1080-tall LOGICAL space and the engine's
// `scaleBaseline` normalizes it, so the gadgets sit correctly at any resolution /
// aspect ratio (2.7K, 4K, 4:3, …), not just 1080p.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Engine, Source } from './index.js'
import { activeFfmpegProcs, concatCopy, DEFAULT_OUTPUT_ARGS } from './ffmpeg.js'
import gopro from './providers/gopro.js'
import gpx from './providers/gpx.js'
import dashboard from './providers/dashboard.js'
import datetime from './providers/datetime.js'
import mapProvider from './providers/map.js'
import { resolveProfile, detectHwEncoder, detectHwDecode, BUILTIN_PROFILES } from './profiles.js'

// --jobs chunk child processes, tracked so a SIGINT/SIGTERM handler (registered in
// main()) can kill them explicitly instead of relying on the OS to deliver the signal
// to the whole process group — see the matching note on ffmpeg.js's activeFfmpegProcs.
const activeChildren = new Set()

const USAGE = `movie-layers — glue clips into one video, with a telemetry overlay

usage:
  movie-layers <video | dir> [<video | dir> ...] [options]

options:
  --out FILE|DIR        output path (default: <first-video>-overlay.mp4 / .png, same dir);
                        an existing directory keeps the default filename, redirecting
                        just the output location
  --snapshot            render one preview PNG instead of a video
  --at SEC              snapshot time in seconds (default: the middle of the clip)
  --open                open the output when done (in the default viewer)
  -q, --quiet           silence the staged log / progress (errors still print)
  --gpx FILE[,FILE...]|DIR  use sidecar .gpx track(s) for telemetry instead of embedded
                        GPS — comma-separated files and/or a directory (its .gpx files,
                        sorted); every point still resolves to its clip by wall clock, so
                        one file per clip and one continuous track both work
  --fps N               output framerate (default 30)
  --widget-fps N        rate the overlay/widgets are drawn (default: = --fps); lower
                        = fewer canvas frames → faster render, base video stays --fps
  --jobs N              render in N parallel processes + lossless concat (single clip
                        with an overlay; near-Nx faster until the encode floor)
  --range START,END     render only seconds [START,END) of the clip (one chunk). Each side
                        is plain seconds or clock time (1:23 = 1m23s, 1:02:03 = 1h02m03s).
                        A chunk whose START>0 warms up gauge smoothing first, so hand-split
                        + concat seams don't jump. Boundaries should meet (0,10 then 10,20).
  --profile NAME        ffmpeg encode profile (built-in: ${Object.keys(BUILTIN_PROFILES).sort().join(', ')};
                        or a name from ~/.config/movie-layers/ffmpeg-profiles.json)
  --profile-file PATH   profiles JSON path (default: ~/.config/movie-layers/ffmpeg-profiles.json)
  --bitrate RATE        override the output -b:v (e.g. 8.5M, 8500k) — takes precedence
                        over --profile and the hw auto-upgrade's own fixed bitrate
  --no-hw               disable auto hardware acceleration (software decode + x264 encode)
  --clock-offset SEC    signed seconds added to the wall clock (fix a wrong camera clock)
  --no-stabilize        raw GPS (default: clean + smooth elevation → stable gradient)
  --mode NAME           gpx-stabilizer analysis mode (default: core; "ski" adds
                        lift/cable-car detection + a more aggressive elevation despike).
                        Embedded GoPro GPS only; ignored with --no-stabilize or --gpx.
  --no-datetime         omit the date/time readout
  --no-smooth           disable gauge-value display smoothing (on by default)
  --map                 draw an OpenStreetMap basemap under the big track map (off by default)
  --map-zoom N          force the basemap tile zoom (default: auto-fit to the track)
  --map-cache DIR       tile cache directory (default: ~/.cache/movie-layers/tiles)
  --flip                swap the bottom corners — gauges right, track map left
  --baseline N          logical baseline height for gadget scaling (default 1080)
  -h, --help            this help

Inputs are clips and/or directories (a directory expands to its videos, sorted);
several inputs concat into one timeline. A GoPro clip (embedded gpmd GPS) gets the
full dashboard automatically; a sidecar .gpx works via --gpx; a clip with no GPS is
simply stitched/encoded (no dashboard).`

// Every flag that takes a value — the parser's whitelist, so a typo (`--rnage`,
// `--jbos`) errors out instead of silently swallowing the next token as its "value".
const VALUE_FLAGS = new Set([
  '--out', '--at', '--gpx', '--fps', '--widget-fps', '--jobs', '--range',
  '--profile', '--profile-file', '--bitrate', '--clock-offset', '--mode',
  '--map-zoom', '--map-cache', '--baseline',
  '--precomputed', // internal — set by renderParallel() for a --jobs chunk
])

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.help = true
    else if (t === '--no-datetime') a.noDatetime = true
    else if (t === '--no-smooth') a.noSmooth = true
    else if (t === '--no-hw') a['no-hw'] = true
    else if (t === '--map') a.map = true
    else if (t === '--snapshot') a.snapshot = true
    else if (t === '--open') a.open = true
    else if (t === '--flip') a.flip = true
    else if (t === '--quiet' || t === '-q') a.quiet = true
    else if (t === '--stabilize') a.stabilize = true
    else if (t === '--no-stabilize') a.noStabilize = true
    else if (VALUE_FLAGS.has(t)) {
      const v = argv[++i]
      if (v === undefined) {
        console.error(`error: ${t} needs a value`)
        process.exit(1)
      }
      a[t.slice(2)] = v
    } else if (t.startsWith('-')) {
      console.error(`error: unknown option "${t}" — run with --help for the flag list`)
      process.exit(1)
    } else a._.push(t)
  }
  return a
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv'])

/** Human-readable duration: `42s` or `3m07s`. */
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

/** Parse one `--range` endpoint: plain seconds ("125", "12.5") or clock time ("1:23", "1:02:03"). */
function parseTimeSpec(s) {
  if (!s.includes(':')) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) return NaN
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}

/** Parse a numeric CLI flag; exits with a clear reason on invalid (or non-positive, if required) input. */
function numFlag(name, raw, { positive = false } = {}) {
  const n = Number(raw)
  if (!Number.isFinite(n) || (positive && n <= 0)) {
    console.error(`error: --${name} "${raw}" is not a valid${positive ? ' positive' : ''} number`)
    process.exit(1)
  }
  return n
}

/**
 * Override (or append) `-b:v` in an ffmpeg output-args array — this is how `--bitrate`
 * takes precedence over whatever rate control a `--profile` or the hw auto-upgrade
 * already picked. Also drops any existing `-crf` (a profile like `hq` sets one) — the
 * two rate-control modes don't coexist, and an explicit bitrate should fully replace it.
 */
function withBitrate(outputArgs, bitrate) {
  const out = []
  for (let i = 0; i < outputArgs.length; i++) {
    if (outputArgs[i] === '-b:v' || outputArgs[i] === '-crf') {
      i++ // drop the flag AND its value
      continue
    }
    out.push(outputArgs[i])
  }
  out.push('-b:v', bitrate)
  return out
}

/** Human-readable byte rate: `512KB/s` / `3.4MB/s`. */
function fmtRate(bytesPerSec) {
  const b = Math.max(0, bytesPerSec)
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB/s`
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB/s`
  return `${b.toFixed(0)}B/s`
}

/**
 * The shared progress-line text — used identically by the single-process render path and
 * the `--jobs` parallel path (whose numbers are the same shape, just summed across chunks),
 * so the two never drift apart in what they report.
 */
function progressLine(p, i, n, el, eta, speedX, readRate, writeRate) {
  return (
    `${String(p).padStart(3)}%  ${i}/${n}  ${fmtDur(el)} elapsed · ETA ${fmtDur(eta)} · ~${fmtDur(el + eta)} total` +
    `  ·  ${speedX.toFixed(2)}x  ·  read~${fmtRate(readRate)}  write ${fmtRate(writeRate)}`
  )
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

const GPX_EXT = new Set(['.gpx'])

/**
 * Expand `--gpx`'s value: comma-separated entries, each a `.gpx` file or a
 * directory (→ its `.gpx` files, sorted) — mirrors `expandInputs()`'s
 * file-or-directory handling for video inputs.
 */
export function expandGpxInputs(raw) {
  const out = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    let isDir = false
    try {
      isDir = statSync(part).isDirectory()
    } catch {
      /* missing path — keep it so provider-gpx reports a clear read error */
    }
    if (isDir) {
      const tracks = readdirSync(part)
        .filter((f) => GPX_EXT.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(part, f))
      out.push(...tracks)
    } else {
      out.push(part)
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
 * omitted when their channel is absent for the WHOLE clip (e.g. `track`/`latlon`/`map`
 * with no GPS at all, `altitude`/`gradient` with no elevation at all) — each caller
 * passes that in via `hasGps`/`hasAltitude`/`hasGradient`, checked independently since
 * GPS and elevation can be missing separately.
 *
 * @param {{hasSpeed:boolean, hasGps:boolean, hasAltitude:boolean, hasGradient:boolean, withDatetime:boolean, logicalW:number}} o
 *   logicalW = baseline × (videoWidth / videoHeight) — the logical canvas width.
 */
export function defaultLayout({
  hasSpeed,
  hasGps,
  hasAltitude,
  hasGradient,
  withDatetime,
  logicalW = 1920,
  flip = false,
  map = null,
}) {
  const M = 5 // edge margin (logical px) — hug the corners
  const row = 997 // bottom-row top: panel height ≈ 78 → its bottom sits ~M from 1080
  const ROW_MIN = 690 // the bottom row (latlon+altitude+gradient) spans ~666 px wide
  const ROW_W = 666 // latlon→gradient span (276 +5+180 +5+200)
  const GAUGE_W = 276 // widest single gauge (latlon), for the stacked column
  const landscape = logicalW >= ROW_MIN

  // gauges hug one bottom corner (data-dense, the priority zone), the big track map
  // the other. Default = gauges left / map right; `--flip` swaps them for footage
  // whose subject sits on the other side. datetime stays top-left (small).
  const gaugesRight = flip
  // square map = 1/3 of the 1080 logical height, clamped to the room beside the gauges
  const side = Math.max(160, Math.min(360, logicalW - 3 * M - (landscape ? ROW_W : GAUGE_W)))
  const trackX = gaugesRight ? M : logicalW - side - M
  const trackBox = { x: trackX, y: 1080 - side - M, width: side, height: side }
  const layout = []
  // track/map/map-label all need GPS — omit that whole corner when the clip has none
  // anywhere (never just the rendered --range window: a chunk with no GPS in its own
  // window can still have GPS elsewhere in the clip).
  if (hasGps) {
    // OSM basemap (opt-in) under the big track map: same box → identical projection,
    // so it stays to scale. Placed FIRST in the layout so it draws beneath the track.
    if (map) layout.push({ type: 'map', ...trackBox, ...map })
    layout.push({ type: 'track', ...trackBox })
    // resort-name label (opt-in with map): placed LAST so it always draws on top of
    // the track widget's own panel/grid/line, never occluded by anything in the box.
    if (map) layout.push({ type: 'map-label', ...trackBox })
  }

  // Which bottom-row gauges the clip's data actually supports — independent checks
  // (any subset can be missing): altitude/gradient need elevation, latlon needs GPS.
  // Widths match ROW_W's own breakdown (276 +5+180 +5+200), for landscape's
  // left-to-right layout.
  const GAUGE_WIDTH = { latlon: 276, altitude: 180, gradient: 200 }
  const gauges = [
    ...(hasGps ? ['latlon'] : []),
    ...(hasAltitude ? ['altitude'] : []),
    ...(hasGradient ? ['gradient'] : []),
  ]

  if (landscape) {
    // landscape: gauges along the bottom edge, speed just above the row
    const base = gaugesRight ? Math.max(M, logicalW - M - ROW_W) : M
    if (hasSpeed) layout.push({ type: 'speed', x: base, y: 914 })
    let x = base
    for (const type of gauges) {
      layout.push({ type, x, y: row })
      x += GAUGE_WIDTH[type] + M
    }
  } else {
    // portrait / narrow: stack the gauges bottom-up the chosen edge
    const base = gaugesRight ? Math.max(M, logicalW - M - GAUGE_W) : M
    let y = row
    for (const type of [...gauges.slice().reverse(), ...(hasSpeed ? ['speed'] : [])]) {
      layout.push({ type, x: base, y })
      y -= 90
    }
  }

  if (withDatetime) layout.push({ type: 'datetime' }) // self-positions top-left
  return layout
}

/**
 * Drop `--jobs N`, `--out X`, `--range S,E`, and `--open` from a raw argv so it can drive
 * a chunk child — the caller appends its own `--range`/`--out` (a sub-window of the
 * user's own `--range`, if any) after this.
 */
function chunkArgv(rawArgv) {
  const out = []
  for (let i = 0; i < rawArgv.length; i++) {
    const t = rawArgv[i]
    if (t === '--jobs' || t === '--out' || t === '--range') i++ // drop the flag AND its value
    else if (t === '--open') continue // parent opens the final concat, not each chunk
    else out.push(t)
  }
  return out
}

/**
 * Parallel render: split [rangeStart,rangeStart+duration) into `jobs` frame-aligned
 * ranges, render each in its own CLI child process (`--range start,end`), then losslessly
 * concat the chunks. Near-Nx faster (the draw is single-threaded per process) until the
 * encode floor. `rangeStart` is 0 for the whole clip, or the user's own `--range` start
 * when --jobs composes with it (main() then passes the range's own span as `duration`).
 * Seam note: per-chunk gauge display-smoothing restarts at each boundary (the first
 * sample snaps, so no sweep-from-zero — just a velocity reset; the basemap/halo/clock
 * are global and continuous).
 *
 * Live progress: each chunk is `--quiet` (no console output of its own) but still reports
 * its frame index to us over IPC (throttled to ~1/sec, minimal payload — just `i`; we
 * already know each chunk's own total frame count from the range we assigned it, and can
 * stat each chunk's own output file ourselves for byte rates), so we can print ONE
 * aggregate progress line in the exact same shape `progressLine()` prints for a
 * single-process render, just summed across chunks.
 */
async function renderParallel({
  rawArgv,
  jobs,
  out,
  durationSec,
  rangeStart = 0,
  inputFps,
  inputBytes,
  precomputedPath,
  quiet,
  log,
}) {
  const Fi = Math.max(1, Math.round(durationSec * inputFps)) // total overlay frames
  const bound = []
  for (let i = 0; i <= jobs; i++) bound.push(Math.round((i * Fi) / jobs))
  const ranges = []
  for (let i = 0; i < jobs; i++) {
    if (bound[i] < bound[i + 1]) ranges.push([rangeStart + bound[i] / inputFps, rangeStart + bound[i + 1] / inputFps])
  }

  const base = chunkArgv(rawArgv)
  const cliPath = fileURLToPath(import.meta.url)
  const chunks = ranges.map((_, i) => join(dirname(out), `.ml-chunk-${process.pid}-${i}-${basename(out)}`))
  const chunkN = ranges.map(([s, e]) => Math.max(1, Math.round((e - s) * inputFps))) // each chunk's own total
  const chunkI = ranges.map(() => 0) // each chunk's own latest reported progress
  log(`parallel: ${ranges.length} chunks × ~${fmtDur(durationSec / ranges.length)} → ${out}`)
  const t0 = Date.now()
  const tty = process.stdout.isTTY
  let pct = -1
  let shown = -1
  let lastRateT = t0
  let lastReadEst = 0
  let lastWriteBytes = 0
  let readRate = 0
  let writeRate = 0

  const onChunkProgress = () => {
    if (quiet) return
    const n = chunkN.reduce((a, b) => a + b, 0)
    const i = chunkI.reduce((a, b) => a + b, 0)
    const p = Math.floor((i / n) * 100)
    const now = Date.now()
    const dueForRate = now - lastRateT >= 1000 || i === n
    if (p === pct && !dueForRate) return
    if (dueForRate) {
      const dt = (now - lastRateT) / 1000
      const readEst = (i / n) * inputBytes
      const writeBytes = chunks.reduce((sum, f) => {
        try {
          return sum + statSync(f).size
        } catch {
          return sum
        }
      }, 0)
      if (dt > 0) {
        readRate = (readEst - lastReadEst) / dt
        writeRate = (writeBytes - lastWriteBytes) / dt
      }
      lastReadEst = readEst
      lastWriteBytes = writeBytes
      lastRateT = now
    }
    pct = p
    const el = (now - t0) / 1000
    const eta = i > 0 ? (el / i) * (n - i) : 0
    const speedX = el > 0 ? i / inputFps / el : 0
    const line = progressLine(p, i, n, el, eta, speedX, readRate, writeRate)
    if (tty) {
      process.stdout.write(`\r  ${line}    `)
    } else if (p % 10 === 0 && p !== shown) {
      shown = p
      log(`  ${line}`)
    }
  }

  let done = 0
  await Promise.all(
    ranges.map(([s, e], i) => {
      const argv = [cliPath, ...base, '--range', `${s},${e}`, '--out', chunks[i], '--quiet', '--precomputed', precomputedPath]
      return new Promise((res, rej) => {
        const p = spawn(process.execPath, argv, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
        activeChildren.add(p)
        p.on('message', (msg) => {
          chunkI[i] = msg.i
          onChunkProgress()
        })
        p.on('error', (e) => {
          activeChildren.delete(p)
          rej(e)
        })
        p.on('close', (code) => {
          activeChildren.delete(p)
          if (code !== 0) return rej(new Error(`chunk ${i} (${s.toFixed(1)}–${e.toFixed(1)}s) exited ${code}`))
          chunkI[i] = chunkN[i] // this chunk is done, regardless of its last reported message
          log(`  chunk ${++done}/${ranges.length} done`)
          res()
        })
      })
    }),
  )
  if (tty && !quiet) process.stdout.write('\n')
  await concatCopy(chunks, out, {})
  for (const f of [...chunks, precomputedPath]) {
    try {
      unlinkSync(f)
    } catch {
      /* best-effort cleanup */
    }
  }
  const totalElapsedSec = (Date.now() - t0) / 1000
  const speedX = totalElapsedSec > 0 ? durationSec / totalElapsedSec : 0
  log(
    `done: ${out}  (${durationSec.toFixed(1)}s)  in ${fmtDur(totalElapsedSec)} using ${ranges.length} jobs  (${speedX.toFixed(2)}x)`,
  )
  return out
}

async function main() {
  // A Ctrl+C (or a kill) has been observed leaving ffmpeg (and --jobs chunk children)
  // running rather than dying with the parent — relying solely on the OS delivering
  // the signal to the whole process group isn't reliable enough here, so kill every
  // tracked subprocess explicitly before exiting. Chunk children are themselves a full
  // `cli.js` invocation, so each one runs this same handler for its own ffmpeg.
  let killing = false
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (killing) return
      killing = true
      for (const p of activeChildren) {
        try {
          p.kill(sig)
        } catch {
          /* already gone */
        }
      }
      for (const p of activeFfmpegProcs) {
        try {
          p.kill(sig)
        } catch {
          /* already gone */
        }
      }
      process.exit(sig === 'SIGINT' ? 130 : 143)
    })
  }

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
  const defaultName = `${basename(input, extname(input))}-overlay.${ext}`
  // --out an existing directory → keep the default filename, just redirect where it lands
  let outIsDir = false
  if (args.out) {
    try {
      outIsDir = statSync(args.out).isDirectory()
    } catch {
      /* doesn't exist yet — treat as a literal file path */
    }
  }
  const out = !args.out ? join(dirname(input), defaultName) : outIsDir ? join(args.out, defaultName) : args.out
  const requestedFps = args.fps ? numFlag('fps', args.fps, { positive: true }) : null // resolved after the probe (default follows the source)
  const widgetFps = args['widget-fps'] ? numFlag('widget-fps', args['widget-fps'], { positive: true }) : null // overlay draw rate; null = = fps
  const range = args.range ? args.range.split(',').map((s) => parseTimeSpec(s.trim())) : null // chunk render window [start,end] seconds
  if (range && range.some((n) => !Number.isFinite(n))) {
    console.error(
      `error: --range "${args.range}" — expected START,END in seconds or clock time (e.g. --range 1:23,2:00)`,
    )
    process.exit(1)
  }
  const jobs = args.jobs ? Math.max(1, Math.floor(numFlag('jobs', args.jobs, { positive: true }))) : 1
  const baseline = args.baseline ? numFlag('baseline', args.baseline, { positive: true }) : 1080
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
  // default --fps follows the source's own rate (don't discard real motion samples by
  // always downsampling to 30), clamped to a sane [30,60] band — no lower than the old
  // default, no higher than YouTube's high-frame-rate ceiling
  const fps = requestedFps ?? Math.min(60, Math.max(30, info?.fps ?? 30))
  const label = files.length > 1 ? `${files.length} clips` : basename(input)
  const dims = info?.width ? `${info.width}x${info.height}` : '?'
  log(`movie-layers: ${label}, ${dims}${info?.fps ? ` @ ${info.fps.toFixed(2)}fps` : ''}`)

  // choose the data provider: --gpx sidecar > embedded GoPro GPS > none (pass-through)
  let dataProvider = null
  const hasSpeed = true
  if (args.gpx) {
    const gpxFiles = expandGpxInputs(args.gpx)
    if (gpxFiles.length === 0) {
      console.error(`error: no .gpx files found in: ${args.gpx}`)
      process.exit(1)
    }
    dataProvider = gpx({ files: gpxFiles })
    log(
      gpxFiles.length > 1
        ? `  source: sidecar gpx (${gpxFiles.length} files): ${gpxFiles.join(', ')}`
        : `  source: sidecar gpx ${gpxFiles[0]}`,
    )
    if (args.mode) log(`  note: --mode ${args.mode} ignored — only embedded GoPro GPS supports it`)
  } else if (hasGps) {
    // elevation smoothing is the provider default (clean gradient); --no-stabilize = raw
    const raw = !!args.noStabilize
    dataProvider = gopro(raw ? { stabilize: false, onLog: log } : { mode: args.mode, onLog: log })
    log(`  source: embedded GoPro GPS${raw ? ' (raw)' : ' (smoothed)'}${args.mode && !raw ? `, mode ${args.mode}` : ''}`)
    if (raw && args.mode) log(`  note: --mode ${args.mode} ignored — --no-stabilize disables analysis entirely`)
  } else {
    // pass-through: no telemetry → just stitch/encode the footage (datetime if a clock exists)
    const minimal = withDatetime && info?.creationTime != null ? 'datetime only' : 'no overlay (stitch only)'
    log(`  source: no GPS — telemetry widgets off; ${minimal}`)
  }

  // OSM basemap config (opt-in via --map); only meaningful when telemetry is present
  const mapCfg = args.map
    ? {
        onLog: log,
        ...(args['map-cache'] ? { cacheDir: args['map-cache'] } : {}),
        ...(args['map-zoom'] ? { zoom: numFlag('map-zoom', args['map-zoom']) } : {}),
      }
    : null
  if (args.map && !dataProvider) log('  note: --map needs GPS telemetry — no basemap drawn')

  // Encoder resolution, precedence: explicit --profile > auto hardware-encoder upgrade
  // (detection-based, default on) > software x264. `--no-hw` disables the auto step; a
  // chunk (--range) inherits this via the passed-through argv. Snapshots don't encode.
  // Decode-side hw accel (below) is a separate, independent auto-detect step.
  let ffmpegOptions = {}
  let enc = null
  if (args.profile) {
    enc = resolveProfile(args.profile, { ...(args['profile-file'] ? { file: args['profile-file'] } : {}) })
    log(`  profile: ${args.profile} → ${enc.output.join(' ')}`)
  } else if (!args['no-hw'] && !args.snapshot) {
    const hw = detectHwEncoder()
    if (hw) {
      enc = { input: [], output: hw.output, filter: null }
      log(`  encoder: auto-upgrade → ${hw.label} (${hw.codec}); --no-hw to force software`)
    }
  }
  if (enc) ffmpegOptions = { inputArgs: enc.input, outputArgs: enc.output, ...(enc.filter ? { filter: enc.filter } : {}) }

  // --bitrate overrides whatever rate control the above picked (profile / hw
  // auto-upgrade / plain default) — always applied last, regardless of source.
  if (args.bitrate) {
    if (!/^\d+(\.\d+)?[kKmM]?$/.test(args.bitrate)) {
      console.error(`error: --bitrate "${args.bitrate}" — expected a value like 8.5M, 8500k, or 8500000`)
      process.exit(1)
    }
    const overridden = args.profile ? `profile "${args.profile}"` : enc ? 'hw auto-upgrade' : 'default'
    ffmpegOptions = { ...ffmpegOptions, outputArgs: withBitrate(ffmpegOptions.outputArgs ?? DEFAULT_OUTPUT_ARGS, args.bitrate) }
    log(`  bitrate: --bitrate ${args.bitrate} overrides ${overridden}`)
  }

  // Decode-side hardware acceleration — independent of the output encoder/profile choice
  // above (it only speeds up reading the base video). Skipped if an explicit --profile
  // already set its own `-hwaccel` (e.g. `nvgpu`'s `-hwaccel nvdec` — respect that).
  if (!args['no-hw'] && !args.snapshot && !(ffmpegOptions.inputArgs ?? []).includes('-hwaccel')) {
    const dec = detectHwDecode()
    if (dec) {
      ffmpegOptions = { ...ffmpegOptions, inputArgs: ['-hwaccel', dec.hwaccel, ...(ffmpegOptions.inputArgs ?? [])] }
      log(`  decode: hw accel → ${dec.label} (${dec.hwaccel})`)
    }
  }

  // providers (full dashboard with data; datetime-or-nothing without)
  const providers = dataProvider
    ? [dataProvider, dashboard, datetime, ...(mapCfg ? [mapProvider] : [])]
    : [datetime]

  // --precomputed <path> (internal — set by renderParallel() for a --jobs chunk): the
  // parent already probed + loaded all provider data once; reuse it instead of
  // loading again here.
  let precomputed = args.precomputed ? JSON.parse(readFileSync(args.precomputed, 'utf8')) : null

  // Probe once, ahead of building the layout, so gauges needing elevation/GPS can be
  // dropped when the WHOLE clip has none — never scoped to a --range window (a chunk
  // with no elevation/GPS samples in its own [start,end) doesn't mean the whole video
  // lacks it). Also lets the --jobs precompute step and the single-engine path below
  // reuse this same load instead of each redoing potentially expensive per-file
  // extraction (e.g. provider-gopro's GPS parsing).
  if (dataProvider && !precomputed) {
    try {
      const probeEngine = new Engine({
        ...(files.length > 1 ? { segments: files.map((f) => ({ file: f })) } : { baseVideo: input }),
        fps,
        inputFps: widgetFps,
        scaleBaseline: baseline,
        clockOffsetSec: args['clock-offset'] ? numFlag('clock-offset', args['clock-offset']) : 0,
        providers,
      })
      precomputed = await probeEngine.prepareData()
    } catch (e) {
      console.error(`error: cannot load telemetry — ${e.message}`)
      process.exit(1)
    }
  }
  const loadedChannels = precomputed?.channels ?? {}
  // Independent checks — either can be missing without the other: no GPS anywhere
  // drops track/latlon/map; no elevation anywhere drops altitude AND gradient
  // (gradient is derived from elevation), regardless of GPS. Named *Channel to avoid
  // colliding with `hasGps` above (that one means "the video has an embedded gpmd
  // stream" — a different question from "did the loaded telemetry end up with a
  // non-empty gps channel").
  const hasGpsChannel = 'gps' in loadedChannels
  const hasAltitudeChannel = 'altitude' in loadedChannels
  const hasGradientChannel = 'gradient' in loadedChannels

  const layout = dataProvider
    ? defaultLayout({
        hasSpeed,
        hasGps: hasGpsChannel,
        hasAltitude: hasAltitudeChannel,
        hasGradient: hasGradientChannel,
        withDatetime,
        logicalW,
        flip: args.flip,
        map: mapCfg,
      })
    : withDatetime && info?.creationTime != null
      ? [{ type: 'datetime' }]
      : []

  // Parallel render (--jobs N): split into N chunks rendered by child processes, then
  // concat. WITH an overlay only (a pure stitch is already a fast copy) and not a
  // snapshot. Short-circuits before the single-engine path. Multi-file inputs work too —
  // each chunk gets the same file list (chunkArgv preserves the positional args) plus its
  // own --range, and already knows how to seek across a multi-file concat (the
  // concat-list `duration` hints in ffmpeg.js's `_baseInput()`; verified against a range
  // crossing a real segment boundary). A user-supplied --range composes with --jobs too:
  // instead of splitting the WHOLE clip into N chunks, it splits just [range[0],range[1])
  // — each chunk's own --range (passed down to it) is offset within that window.
  if (jobs > 1 && args.snapshot)
    console.warn(`note: --jobs ignored — a snapshot renders one frame, nothing to parallelize`)
  if (jobs > 1 && !args.snapshot && layout.length > 0) {
    // `precomputed` may already be populated by the channel-presence probe above
    // (whenever there's a data provider) — reuse it instead of loading a second time.
    // Only the datetime-only / no-provider case still needs its own precompute here.
    if (!precomputed) {
      try {
        const precomputeEngine = new Engine({
          ...(files.length > 1 ? { segments: files.map((f) => ({ file: f })) } : { baseVideo: input }),
          fps,
          inputFps: widgetFps,
          scaleBaseline: baseline,
          clockOffsetSec: args['clock-offset'] ? numFlag('clock-offset', args['clock-offset']) : 0,
          providers,
          layout,
        })
        precomputed = await precomputeEngine.prepareData()
      } catch {
        /* precomputed stays null — fall through to the single-engine path below */
      }
    }
    if (precomputed) {
      const totalDurationSec = precomputed.segments.reduce((sum, s) => sum + s.durationSec, 0)
      // --range narrows the window --jobs splits into chunks: [0,totalDurationSec) by
      // default, or [range[0],range[1]) when given.
      const rangeStart = range?.[0] ?? 0
      const windowDurationSec = (range?.[1] ?? totalDurationSec) - rangeStart
      const totalInputBytes = files.reduce((sum, f) => {
        try {
          return sum + statSync(f).size
        } catch {
          return sum
        }
      }, 0)
      const precomputedPath = join(tmpdir(), `ml-precomputed-${process.pid}.json`)
      writeFileSync(precomputedPath, JSON.stringify(precomputed))
      log(`movie-layers: parallel render, ${jobs} jobs${files.length > 1 ? ` (${files.length} clips)` : ''}`)
      await renderParallel({
        rawArgv: process.argv.slice(2),
        jobs,
        out,
        durationSec: windowDurationSec,
        rangeStart,
        inputFps: widgetFps ?? fps,
        inputBytes: totalInputBytes,
        precomputedPath,
        quiet: args.quiet,
        log,
      })
      if (args.open) openFile(out)
      return
    }
    log(`note: --jobs skipped — couldn't precompute telemetry; rendering normally`)
  }

  const engine = new Engine({
    // 1 clip → baseVideo; many → segments (ffmpeg concat over one logical timeline);
    // a precomputed bundle skips both entirely — EXCEPT for --snapshot: precomputed
    // mode leaves `sources` empty (by design, render()-only; see engine.js's
    // `_resolve()`), but snapshot()'s extractFrame needs it, so a snapshot always
    // resolves fresh here even though `precomputed` was already probed above (just
    // for the channel-presence gating, not reused for the engine itself).
    ...(precomputed && !args.snapshot
      ? { precomputed }
      : files.length > 1
        ? { segments: files.map((f) => ({ file: f })) }
        : { baseVideo: input }),
    fps,
    inputFps: widgetFps, // overlay draw rate (null → Engine defaults it to fps)
    renderStartSec: range?.[0] ?? null, // a chunk renders only its [start,end) window
    renderEndSec: range?.[1] ?? null,
    // warm-up lead-in for a non-first chunk so gauge smoothing converges at the seam
    // (~1.5 s ≈ 4× the 0.35 s smoothTime; clamped so it never seeks before 0)
    renderWarmupSec: range && range[0] > 0 ? Math.min(range[0], 1.5) : 0,
    scaleBaseline: baseline, // ratio fix: normalize gadget positions to a 1080 logical space
    clockOffsetSec: args['clock-offset'] ? numFlag('clock-offset', args['clock-offset']) : 0,
    gaugeSmoothing: !args.noSmooth,
    providers,
    layout,
    output: out,
    ffmpegOptions,
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
  if (args.profile && !args.snapshot && summary.layers.length === 0)
    console.warn(`note: --profile ${args.profile} ignored — a pure stitch is a stream copy (no re-encode)`)
  if (args.bitrate && !args.snapshot && summary.layers.length === 0)
    console.warn(`note: --bitrate ${args.bitrate} ignored — a pure stitch is a stream copy (no re-encode)`)
  if (jobs > 1 && !args.range && summary.layers.length === 0)
    console.warn(`note: --jobs ignored — a pure stitch is already one fast stream copy`)

  // --range narrows what actually gets rendered; reflect that window in the "rendering"/
  // "done" lines below instead of the full clip's totals — otherwise these headline
  // numbers contradict the live per-frame progress line, which counts against the window
  // (engine.js render()'s `totalFrames`), not the whole timeline.
  const renderDurationSec = range ? (range[1] ?? summary.durationSec) - (range[0] ?? 0) : summary.durationSec
  const renderFps = widgetFps ?? fps
  const renderFrameCount = range ? Math.max(1, Math.round(renderDurationSec * renderFps)) : summary.frameCount

  // ── Stage 3: do it ───────────────────────────────────────────────────────────
  const logCmd = (cmd) => log(`  $ ${cmd.join(' ')}`)
  const t0 = Date.now()
  if (args.snapshot) {
    const at = args.at != null ? numFlag('at', args.at) : null
    log(`snapshot @ ${at != null ? `${at}s` : 'middle'} → ${out}`)
    await engine.snapshot({ atSec: at, output: out, scene, onCommand: logCmd })
  } else if (summary.layers.length === 0) {
    // no overlay → lossless stream-copy stitch (one ffmpeg call, no per-frame work)
    if (args.fps) console.warn(`note: --fps ${fps} ignored — a pure stitch is a stream copy (no re-encode)`)
    log(`stitching → ${out}`)
    await engine.render({ scene, onCommand: logCmd })
  } else {
    log(`rendering → ${out}  (${renderFrameCount} frames @ ${fps}fps)`)
    const tty = process.stdout.isTTY
    // input-side "read" is an ESTIMATE (ffmpeg exposes no real bytes-read-from-input
    // counter, and there's no portable OS I/O counter — /proc/pid/io doesn't exist on
    // macOS): assume roughly-constant bitrate and scale total input size by frame
    // progress. Output-side "write" is the real thing — just stat the file being
    // encoded.
    const totalInputBytes = files.reduce((sum, f) => {
      try {
        return sum + statSync(f).size
      } catch {
        return sum
      }
    }, 0)
    // `i/n` (below) is relative to the RENDER WINDOW, not the whole file — scale the
    // estimate's denominator the same way, or a short --range on a long clip massively
    // overshoots (dividing the whole file's bytes by just the window's frame count).
    const inputBytes =
      summary.durationSec > 0 ? totalInputBytes * (renderDurationSec / summary.durationSec) : totalInputBytes
    let pct = -1
    let shown = -1
    let lastRateT = t0
    let lastReadEst = 0
    let lastWriteBytes = 0
    let readRate = 0
    let writeRate = 0
    let lastIpcT = 0
    await engine.render({
      scene,
      onCommand: logCmd,
      onProgress: (i, n) => {
        // running as a --jobs chunk (spawned with an ipc channel): tell the parent our
        // progress, throttled to ~1/sec — a minimal payload, since the parent already
        // knows this chunk's own frame total (from the range it assigned) and can stat
        // this chunk's own output file itself for byte rates. Independent of --quiet,
        // which only silences THIS process's own console output.
        if (process.send) {
          const now0 = Date.now()
          if (now0 - lastIpcT >= 1000 || i === n) {
            process.send({ i })
            lastIpcT = now0
          }
        }
        if (args.quiet) return
        const p = Math.floor((i / n) * 100)
        const now = Date.now()
        const dueForRate = now - lastRateT >= 1000 || i === n
        if (p === pct && !dueForRate) return
        if (dueForRate) {
          const dt = (now - lastRateT) / 1000
          const readEst = (i / n) * inputBytes
          let writeBytes = lastWriteBytes
          try {
            writeBytes = statSync(out).size
          } catch {
            /* output file not created yet */
          }
          if (dt > 0) {
            readRate = (readEst - lastReadEst) / dt
            writeRate = (writeBytes - lastWriteBytes) / dt
          }
          lastReadEst = readEst
          lastWriteBytes = writeBytes
          lastRateT = now
        }
        pct = p
        const el = (now - t0) / 1000
        const eta = i > 0 ? (el / i) * (n - i) : 0
        // encode speed as a multiple of realtime — e.g. an hour of footage encoded in
        // 30 real minutes is "2.00x" (video-time processed so far ÷ real elapsed time)
        const speedX = el > 0 ? i / renderFps / el : 0
        const line = progressLine(p, i, n, el, eta, speedX, readRate, writeRate)
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
  const totalElapsedSec = (Date.now() - t0) / 1000
  const avgSpeedX = !args.snapshot && totalElapsedSec > 0 ? `  (${(renderDurationSec / totalElapsedSec).toFixed(2)}x)` : ''
  log(`done: ${out}  (${renderDurationSec.toFixed(1)}s, ${dims})  in ${fmtDur(totalElapsedSec)}${avgSpeedX}`)
  const c = summary.channels
  const bits = []
  if (c.speed?.max != null) bits.push(`speed ≤ ${c.speed.max.toFixed(1)} ${c.speed.unit}`)
  if (c.altitude?.min != null) bits.push(`alt ${c.altitude.min.toFixed(0)}–${c.altitude.max.toFixed(0)} ${c.altitude.unit}`)
  if (c.gradient?.min != null) bits.push(`grade ${c.gradient.min.toFixed(0)}–${c.gradient.max.toFixed(0)} ${c.gradient.unit}`)
  if (bits.length) log(`  ${bits.join(', ')}`)

  if (args.open) openFile(out)
}

// run only as the CLI entry, so the module can be imported (e.g. for tests).
// realpath BOTH sides: a symlinked bin (npm link / mise shim) makes argv[1] the
// symlink path while import.meta.url is the resolved file — compare resolved.
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`error: ${e.message}`)
    process.exit(1)
  })
}
