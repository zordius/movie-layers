import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let seq = 0

// Every spawned ffmpeg subprocess, tracked so a CLI-level SIGINT/SIGTERM handler
// (cli.js) can kill them explicitly — relying solely on the OS delivering the signal
// to the whole process group has proven unreliable in practice (a Ctrl+C has been
// observed leaving ffmpeg running, especially one spawned indirectly via a `--jobs`
// chunk child process).
export const activeFfmpegProcs = new Set()

function track(proc) {
  activeFfmpegProcs.add(proc)
  proc.once('close', () => activeFfmpegProcs.delete(proc))
  return proc
}

/**
 * Decode a single video frame at `atSec` and return it as PNG bytes. `-ss` before
 * `-i` is a fast (keyframe) seek — fine for a preview thumbnail. Used by
 * Engine.snapshot to composite the overlay over the real footage.
 */
export function extractFrame(file, atSec, { ffmpeg = 'ffmpeg', onCommand = null } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-']
  onCommand?.([ffmpeg, ...args])
  return new Promise((resolveP, reject) => {
    const proc = track(spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }))
    const chunks = []
    let err = ''
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('error', (e) => reject(new Error(`Unable to run ffmpeg (${e.message})`)))
    proc.on('close', (code) =>
      code === 0 && chunks.length
        ? resolveP(Buffer.concat(chunks))
        : reject(new Error(`ffmpeg frame extract exited ${code}: ${err.trim()}`)),
    )
  })
}

/**
 * Lossless stitch — concat base videos with **stream copy** (no re-encode). Used
 * when there is no overlay to draw: 1 file is a remux/copy, N files use the concat
 * demuxer (identical codec/res/fps required — GoPro chapters qualify). Ignores
 * fps/scale (there are no frames to render); fast and bit-exact.
 */
export function concatCopy(files, output, { ffmpeg = 'ffmpeg', creationTime = null, onCommand = null } = {}) {
  return new Promise((resolveP, reject) => {
    let concatFile = null
    let input
    if (files.length === 1) {
      input = ['-i', files[0]]
    } else {
      concatFile = join(tmpdir(), `ml-stitch-${process.pid}-${seq++}.txt`)
      writeFileSync(concatFile, files.map((f) => `file '${resolve(f)}'`).join('\n') + '\n')
      input = ['-f', 'concat', '-safe', '0', '-i', concatFile]
    }
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...input,
      '-c', 'copy',
      ...(creationTime ? ['-metadata', `creation_time=${creationTime}`] : []),
      output,
    ]
    onCommand?.([ffmpeg, ...args])
    const cleanup = () => {
      if (concatFile) {
        try {
          unlinkSync(concatFile)
        } catch {
          /* best-effort */
        }
      }
    }
    const proc = track(spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] }))
    proc.on('error', (e) => {
      cleanup()
      reject(new Error(`Unable to run ffmpeg (${e.message})`))
    })
    proc.on('close', (code) => {
      cleanup()
      code === 0 ? resolveP(output) : reject(new Error(`ffmpeg stitch exited with code ${code}`))
    })
  })
}

/**
 * The ffmpeg seam. Modes (inherited from gopro-dashboard-overlay):
 *
 *   - 0 base videos → encode our RGBA frames.
 *   - 1 base video  → [0:v][1:v]overlay (our frame on top).
 *   - N base videos → concat demuxer presents them as ONE logical [0:v]
 *                     (parts of the same trip, identical codec/res/fps), then
 *                     the same single overlay. ffmpeg owns all video pixels.
 *
 * Backpressure is honoured in writeFrame(): when ffmpeg can't keep up the write
 * awaits 'drain' — that blocking IS flow control (ffmpeg saturated = optimal).
 */
// the engine default when no --profile / hw auto-upgrade applies (libx264 / veryfast /
// yuv420p, x264 default CRF 23) — exported so a caller (e.g. --bitrate) can start from
// the same baseline instead of duplicating it.
export const DEFAULT_OUTPUT_ARGS = ['-vcodec', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']

export class FfmpegPipe {
  constructor({
    width,
    height,
    fps = 30, // output framerate
    inputFps = 10, // rate at which we produce frames (gopro overlays at 10)
    baseVideos = [], // 0/1/N base video files (the bottom layer; >1 → concat)
    baseVideoDurations = [], // each baseVideos[i]'s own duration (secs) — concat-list hint (below)
    output,
    ffmpeg = 'ffmpeg',
    pixfmt = 'rgba', // getImageData() gives straight-alpha RGBA
    inputArgs = [], // decode options BEFORE the base `-i` (e.g. a profile's `-hwaccel nvdec`)
    seekSec = null, // `-ss` before the base `-i` (accurate seek) — render a sub-range (parallel chunks)
    clipSec = null, // output `-t`: cut the chunk to this many seconds (the overlay filter's
    //                length follows the longer base, so -shortest won't do it; -t is reliable)
    outputArgs = DEFAULT_OUTPUT_ARGS,
    filter = '[0:v][1:v]overlay',
    creationTime = null,
    logLevel = 'error', // ffmpeg -loglevel (quiet the banner/progress; errors still print). null = default
    onCommand = null, // optional callback([ffmpeg, ...args]) — surfaces the command being run
  }) {
    Object.assign(this, {
      width,
      height,
      fps,
      inputFps,
      baseVideos,
      baseVideoDurations,
      output,
      ffmpeg,
      pixfmt,
      inputArgs,
      seekSec,
      clipSec,
      outputArgs,
      filter,
      creationTime,
      logLevel,
      onCommand,
    })
    this._concatFile = null
  }

  _baseInput() {
    if (this.baseVideos.length === 0) return []
    if (this.baseVideos.length === 1) return ['-i', this.baseVideos[0]]
    // N → concat demuxer over a list file. A `duration` hint per entry (already probed by
    // the engine) lets the demuxer compute each file's cumulative offset analytically —
    // without it, seeking (`-ss`) deep into a multi-file concat can require opening/
    // scanning every physical file first just to find where the target lands, which is
    // slow for several large (multi-GB) source files.
    this._concatFile = join(tmpdir(), `ml-concat-${process.pid}-${seq++}.txt`)
    const lines = this.baseVideos
      .map((f, i) => {
        const dur = this.baseVideoDurations[i]
        return dur != null ? `file '${resolve(f)}'\nduration ${dur}` : `file '${resolve(f)}'`
      })
      .join('\n')
    writeFileSync(this._concatFile, lines + '\n')
    return ['-f', 'concat', '-safe', '0', '-i', this._concatFile]
  }

  start() {
    const size = `${this.width}x${this.height}`
    const rawIn = [
      '-f', 'rawvideo',
      '-pix_fmt', this.pixfmt,
      '-s', size,
      '-framerate', String(this.inputFps),
      '-i', 'pipe:0',
    ]

    const args = ['-hide_banner', '-y', ...(this.logLevel ? ['-loglevel', this.logLevel] : [])]
    if (this.baseVideos.length >= 1) {
      // profile input opts (e.g. -hwaccel) then an accurate `-ss` seek → before the base -i
      const seek = this.seekSec != null ? ['-ss', String(this.seekSec)] : []
      args.push(...this.inputArgs, ...seek, ...this._baseInput(), ...rawIn, '-filter_complex', this.filter)
    } else {
      args.push(...rawIn)
    }

    args.push('-r', String(this.fps), ...this.outputArgs)
    if (this.clipSec != null) args.push('-t', String(this.clipSec))
    if (this.creationTime) args.push('-metadata', `creation_time=${this.creationTime}`)
    args.push(this.output)

    this.onCommand?.([this.ffmpeg, ...args])
    this.proc = track(spawn(this.ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] }))
    this.closed = once(this.proc, 'close')
    return this
  }

  /** Write one raw frame, respecting ffmpeg backpressure. */
  async writeFrame(buffer) {
    if (!this.proc.stdin.write(buffer)) {
      await once(this.proc.stdin, 'drain')
    }
  }

  async finish() {
    this.proc.stdin.end()
    const [code] = await this.closed
    if (this._concatFile) {
      try {
        unlinkSync(this._concatFile)
      } catch {
        /* best-effort */
      }
    }
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)
  }
}
