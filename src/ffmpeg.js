import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let seq = 0

/**
 * Decode a single video frame at `atSec` and return it as PNG bytes. `-ss` before
 * `-i` is a fast (keyframe) seek — fine for a preview thumbnail. Used by
 * Engine.snapshot to composite the overlay over the real footage.
 */
export function extractFrame(file, atSec, { ffmpeg = 'ffmpeg' } = {}) {
  return new Promise((resolveP, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-hide_banner', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
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
export class FfmpegPipe {
  constructor({
    width,
    height,
    fps = 30, // output framerate
    inputFps = 10, // rate at which we produce frames (gopro overlays at 10)
    baseVideos = [], // 0/1/N base video files (the bottom layer; >1 → concat)
    output,
    ffmpeg = 'ffmpeg',
    pixfmt = 'rgba', // getImageData() gives straight-alpha RGBA
    outputArgs = ['-vcodec', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
    filter = '[0:v][1:v]overlay',
    creationTime = null,
    logLevel = 'error', // ffmpeg -loglevel (quiet the banner/progress; errors still print). null = default
  }) {
    Object.assign(this, {
      width,
      height,
      fps,
      inputFps,
      baseVideos,
      output,
      ffmpeg,
      pixfmt,
      outputArgs,
      filter,
      creationTime,
      logLevel,
    })
    this._concatFile = null
  }

  _baseInput() {
    if (this.baseVideos.length === 0) return []
    if (this.baseVideos.length === 1) return ['-i', this.baseVideos[0]]
    // N → concat demuxer over a list file
    this._concatFile = join(tmpdir(), `ml-concat-${process.pid}-${seq++}.txt`)
    const lines = this.baseVideos.map((f) => `file '${resolve(f)}'`).join('\n')
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
      args.push(...this._baseInput(), ...rawIn, '-filter_complex', this.filter)
    } else {
      args.push(...rawIn)
    }

    args.push('-r', String(this.fps), ...this.outputArgs)
    if (this.creationTime) args.push('-metadata', `creation_time=${this.creationTime}`)
    args.push(this.output)

    this.proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] })
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
