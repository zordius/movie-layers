import { spawn } from 'node:child_process'
import { once } from 'node:events'

/**
 * The ffmpeg seam. Two modes, inherited from gopro-dashboard-overlay:
 *
 *   - base video present -> ffmpeg lays our composited RGBA frame on top:
 *       [0:v] = base video (bottom)   [1:v] = our frame (top)   filter = overlay
 *   - no base video      -> ffmpeg just encodes our RGBA frames.
 *
 * Everything else (gauges, SVG, maps, …) is composited by *us* into the one
 * RGBA frame before it reaches here. ffmpeg only ever does a single `overlay`.
 *
 * Backpressure is honoured in writeFrame(): when ffmpeg can't keep up, the
 * write awaits 'drain' — that blocking IS the flow control, and means ffmpeg
 * is saturated (encode-bound, which is the optimal steady state).
 */
export class FfmpegPipe {
  constructor({
    width,
    height,
    fps = 30, // output framerate
    inputFps = 10, // rate at which we produce frames (gopro overlays at 10)
    baseVideo = null, // path to the single optional base video
    output,
    ffmpeg = 'ffmpeg',
    pixfmt = 'rgba', // getImageData() gives straight-alpha RGBA
    outputArgs = ['-vcodec', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
    filter = '[0:v][1:v]overlay',
    creationTime = null,
  }) {
    Object.assign(this, {
      width,
      height,
      fps,
      inputFps,
      baseVideo,
      output,
      ffmpeg,
      pixfmt,
      outputArgs,
      filter,
      creationTime,
    })
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

    let args
    if (this.baseVideo) {
      args = ['-hide_banner', '-y', '-i', this.baseVideo, ...rawIn, '-filter_complex', this.filter]
    } else {
      args = ['-hide_banner', '-y', ...rawIn]
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
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)
  }
}
