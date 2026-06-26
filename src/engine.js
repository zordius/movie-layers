import { createCanvas } from '@napi-rs/canvas'

import { FfmpegPipe } from './ffmpeg.js'
import { Registry } from './layer.js'
import { Timeline } from './timeline.js'

/**
 * The compositor. For each frame it clears the canvas, draws every layer
 * bottom→top into one RGBA frame, and pipes it to ffmpeg.
 *
 * ┌── per frame ─────────────────────────────────────────────┐
 * │ clear → layer[0].draw → … → layer[n].draw → getImageData  │
 * │                                              → ffmpeg pipe │
 * └──────────────────────────────────────────────────────────┘
 *
 * NOTE: getImageData → rgba is the correct-but-copying path. A later
 * optimisation is canvas.data()/toBuffer('raw') + `-pix_fmt bgra` (premultiplied),
 * and a DoubleBuffer-style writer to overlap draw with the pipe write.
 */
export class Engine {
  constructor({
    width,
    height,
    fps = 30,
    inputFps = null, // rate we produce frames at; defaults to fps
    durationSec,
    background = null, // css colour to clear with; null = transparent
    baseVideo = null, // single optional base video (always the bottom layer)
    output,
    providers = [],
    layout = [], // [{ type, ...config }] resolved against providers
    ffmpegOptions = {},
  }) {
    this.width = width
    this.height = height
    this.fps = fps
    this.inputFps = inputFps ?? fps
    this.durationSec = durationSec
    this.background = background
    this.baseVideo = baseVideo
    this.output = output
    this.registry = new Registry(providers)
    this.layoutSpec = layout
    this.ffmpegOptions = ffmpegOptions
  }

  async render() {
    const canvas = createCanvas(this.width, this.height)
    const ctx = canvas.getContext('2d')

    const layers = this.layoutSpec.map(({ type, ...config }) =>
      this.registry.create(type, config, ctx),
    )

    const pipe = new FfmpegPipe({
      width: this.width,
      height: this.height,
      fps: this.fps,
      inputFps: this.inputFps,
      baseVideo: this.baseVideo,
      output: this.output,
      pixfmt: 'rgba',
      ...this.ffmpegOptions,
    }).start()

    const timeline = new Timeline({ durationSec: this.durationSec, fps: this.inputFps })

    try {
      for (const { index, timeSec } of timeline.steps()) {
        ctx.clearRect(0, 0, this.width, this.height)
        if (this.background) {
          ctx.fillStyle = this.background
          ctx.fillRect(0, 0, this.width, this.height)
        }

        const frame = {
          index,
          timeSec,
          width: this.width,
          height: this.height,
          fps: this.inputFps,
        }
        for (const layer of layers) layer.draw(ctx, frame)

        const { data } = ctx.getImageData(0, 0, this.width, this.height)
        await pipe.writeFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      }
    } finally {
      await pipe.finish()
    }
  }
}
