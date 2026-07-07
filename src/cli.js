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
import { readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Engine, Source } from './index.js'
import { concatCopy, DEFAULT_OUTPUT_ARGS } from './ffmpeg.js'
import gopro from './providers/gopro.js'
import gpx from './providers/gpx.js'
import dashboard from './providers/dashboard.js'
import datetime from './providers/datetime.js'
import mapProvider from './providers/map.js'
import { resolveProfile, detectHwEncoder, detectHwDecode, BUILTIN_PROFILES } from './profiles.js'

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
  --gpx FILE            use a sidecar .gpx for telemetry instead of embedded GPS
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
export function defaultLayout({ hasSpeed, withDatetime, logicalW = 1920, flip = false, map = null }) {
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
  // OSM basemap (opt-in) under the big track map: same box → identical projection,
  // so it stays to scale. Placed FIRST in the layout so it draws beneath the track.
  const layout = map ? [{ type: 'map', ...trackBox, ...map }] : []
  layout.push({ type: 'track', ...trackBox })

  if (landscape) {
    // landscape: gauges along the bottom edge, speed just above the row
    const base = gaugesRight ? Math.max(M, logicalW - M - ROW_W) : M
    if (hasSpeed) layout.push({ type: 'speed', x: base, y: 914 })
    let x = base
    layout.push({ type: 'latlon', x, y: row })
    x += 281 // latlon panel (276) + M
    layout.push({ type: 'altitude', x, y: row })
    x += 185 // altitude panel (180) + M
    layout.push({ type: 'gradient', x, y: row })
  } else {
    // portrait / narrow: stack the gauges bottom-up the chosen edge
    const base = gaugesRight ? Math.max(M, logicalW - M - GAUGE_W) : M
    let y = row
    for (const type of ['gradient', 'altitude', 'latlon', ...(hasSpeed ? ['speed'] : [])]) {
      layout.push({ type, x: base, y })
      y -= 90
    }
  }

  if (withDatetime) layout.push({ type: 'datetime' }) // self-positions top-left
  return layout
}

/** Drop `--jobs N`, `--out X`, and `--open` from a raw argv so it can drive a chunk child. */
function chunkArgv(rawArgv) {
  const out = []
  for (let i = 0; i < rawArgv.length; i++) {
    const t = rawArgv[i]
    if (t === '--jobs' || t === '--out') i++ // drop the flag AND its value
    else if (t === '--open') continue // parent opens the final concat, not each chunk
    else out.push(t)
  }
  return out
}

/**
 * Parallel render: split [0,duration) into `jobs` frame-aligned ranges, render each in
 * its own CLI child process (`--range start,end`), then losslessly concat the chunks.
 * Near-Nx faster (the draw is single-threaded per process) until the encode floor.
 * Seam note: per-chunk gauge display-smoothing restarts at each boundary (the first
 * sample snaps, so no sweep-from-zero — just a velocity reset; the basemap/halo/clock
 * are global and continuous).
 */
async function renderParallel({ rawArgv, jobs, out, durationSec, inputFps, log }) {
  const Fi = Math.max(1, Math.round(durationSec * inputFps)) // total overlay frames
  const bound = []
  for (let i = 0; i <= jobs; i++) bound.push(Math.round((i * Fi) / jobs))
  const ranges = []
  for (let i = 0; i < jobs; i++) if (bound[i] < bound[i + 1]) ranges.push([bound[i] / inputFps, bound[i + 1] / inputFps])

  const base = chunkArgv(rawArgv)
  const cliPath = fileURLToPath(import.meta.url)
  const chunks = ranges.map((_, i) => join(dirname(out), `.ml-chunk-${process.pid}-${i}-${basename(out)}`))
  log(`parallel: ${ranges.length} chunks × ~${fmtDur(durationSec / ranges.length)} → ${out}`)
  const t0 = Date.now()
  let done = 0
  await Promise.all(
    ranges.map(([s, e], i) => {
      const argv = [cliPath, ...base, '--range', `${s},${e}`, '--out', chunks[i], '--quiet']
      return new Promise((res, rej) => {
        const p = spawn(process.execPath, argv, { stdio: ['ignore', 'ignore', 'inherit'] })
        p.on('error', rej)
        p.on('close', (code) => {
          if (code !== 0) return rej(new Error(`chunk ${i} (${s.toFixed(1)}–${e.toFixed(1)}s) exited ${code}`))
          log(`  chunk ${++done}/${ranges.length} done`)
          res()
        })
      })
    }),
  )
  await concatCopy(chunks, out, {})
  for (const f of chunks) {
    try {
      unlinkSync(f)
    } catch {
      /* best-effort cleanup */
    }
  }
  log(`done: ${out}  (${durationSec.toFixed(1)}s)  in ${fmtDur((Date.now() - t0) / 1000)} using ${ranges.length} jobs`)
  return out
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
    dataProvider = gpx({ file: args.gpx })
    log(`  source: sidecar gpx ${args.gpx}`)
  } else if (hasGps) {
    // elevation smoothing is the provider default (clean gradient); --no-stabilize = raw
    const raw = !!args.noStabilize
    dataProvider = gopro(raw ? { stabilize: false } : {})
    log(`  source: embedded GoPro GPS${raw ? ' (raw)' : ' (smoothed)'}`)
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

  // providers + layout (full dashboard with data; datetime-or-nothing without)
  const providers = dataProvider
    ? [dataProvider, dashboard, datetime, ...(mapCfg ? [mapProvider] : [])]
    : [datetime]
  const layout = dataProvider
    ? defaultLayout({ hasSpeed, withDatetime, logicalW, flip: args.flip, map: mapCfg })
    : withDatetime && info?.creationTime != null
      ? [{ type: 'datetime' }]
      : []

  // Parallel render (--jobs N): split into N chunks rendered by child processes, then
  // concat. Only for a single clip WITH an overlay (a pure stitch is already a fast copy)
  // and not a chunk (--range) / snapshot. Short-circuits before the single-engine path.
  if (jobs > 1 && !args.range && !args.snapshot && files.length === 1 && layout.length > 0 && info?.durationSec) {
    log(`movie-layers: parallel render, ${jobs} jobs`)
    await renderParallel({
      rawArgv: process.argv.slice(2),
      jobs,
      out,
      durationSec: info.durationSec,
      inputFps: widgetFps ?? fps,
      log,
    })
    if (args.open) openFile(out)
    return
  }
  if (jobs > 1 && files.length > 1) log(`note: --jobs needs a single clip — rendering normally`)

  const engine = new Engine({
    // 1 clip → baseVideo; many → segments (ffmpeg concat over one logical timeline)
    ...(files.length > 1 ? { segments: files.map((f) => ({ file: f })) } : { baseVideo: input }),
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
  const renderFrameCount = range ? Math.max(1, Math.round(renderDurationSec * (widgetFps ?? fps))) : summary.frameCount

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
    await engine.render({
      scene,
      onCommand: logCmd,
      onProgress: (i, n) => {
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
        const line =
          `${String(p).padStart(3)}%  ${i}/${n}  ${fmtDur(el)} elapsed · ETA ${fmtDur(eta)} · ~${fmtDur(el + eta)} total` +
          `  ·  read~${fmtRate(readRate)}  write ${fmtRate(writeRate)}`
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
  log(`done: ${out}  (${renderDurationSec.toFixed(1)}s, ${dims})  in ${fmtDur((Date.now() - t0) / 1000)}`)
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
