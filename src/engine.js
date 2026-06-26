import { createCanvas } from '@napi-rs/canvas'

import { FfmpegPipe } from './ffmpeg.js'
import { Registry } from './layer.js'
import { Timeline } from './timeline.js'

/** Normalise a wall-clock anchor (Date | epoch-ms | ISO string) to epoch ms. */
function toEpochMs(v) {
  if (v == null) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * The compositor. For each frame it clears the canvas, draws every layer
 * bottom→top into one RGBA frame, and pipes it to ffmpeg.
 *
 * The `frame` handed to each layer carries:
 *  - playback clock (continuous): index, frameCount, isFirst, isLast, timeSec,
 *    dt, progress, durationSec, fps
 *  - segment + wall clock: segment{index,localIndex,localTimeSec,startUtc},
 *    dateTime (= segment.startUtc + localTime, may jump across a gap; null when
 *    no anchor), timezone
 *  - geometry: width, height
 *
 * None of this comes from a data provider — it's engine-intrinsic (timeline +
 * config). Only the per-segment startUtc anchor may originate upstream (config
 * now; a gopro provider's GPS back-calc later); the engine just adds local time.
 */
export class Engine {
  constructor({
    width,
    height,
    fps = 30,
    inputFps = null, // rate we produce frames at; defaults to fps
    durationSec, // single-segment length (ignored when `segments` given)
    segments = null, // [{ durationSec, startUtc }] for multi-video concat
    startDateTime = null, // single-segment wall-clock anchor (Date | ms | ISO)
    timezone = null, // display tz for dateTime
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
    this.timezone = timezone
    this.background = background
    this.baseVideo = baseVideo
    this.output = output
    this.registry = new Registry(providers)
    this.layoutSpec = layout
    this.ffmpegOptions = ffmpegOptions

    if (segments) {
      this.segments = segments.map((s) => ({
        durationSec: s.durationSec,
        startUtc: toEpochMs(s.startUtc),
      }))
    } else {
      if (durationSec == null) {
        throw new Error('Engine needs either `durationSec` or `segments`')
      }
      this.segments = [{ durationSec, startUtc: toEpochMs(startDateTime) }]
    }
  }

  async render() {
    const canvas = createCanvas(this.width, this.height)
    const ctx = canvas.getContext('2d')

    const layers = this.layoutSpec.map(({ type, ...config }) =>
      this.registry.create(type, config, ctx),
    )

    const anchorMs = this.segments[0].startUtc
    const pipe = new FfmpegPipe({
      width: this.width,
      height: this.height,
      fps: this.fps,
      inputFps: this.inputFps,
      baseVideo: this.baseVideo,
      output: this.output,
      pixfmt: 'rgba',
      creationTime: anchorMs != null ? new Date(anchorMs).toISOString() : null,
      ...this.ffmpegOptions,
    }).start()

    const timeline = new Timeline({ segments: this.segments, fps: this.inputFps })
    const { frameCount, durationSec } = timeline
    const lastIndex = frameCount - 1

    try {
      for (const { index, timeSec, segment } of timeline.steps()) {
        ctx.clearRect(0, 0, this.width, this.height)
        if (this.background) {
          ctx.fillStyle = this.background
          ctx.fillRect(0, 0, this.width, this.height)
        }

        const dateTime =
          segment.startUtc != null
            ? new Date(segment.startUtc + segment.localTimeSec * 1000)
            : null

        const frame = {
          // playback clock (continuous)
          index,
          frameCount,
          isFirst: index === 0,
          isLast: index === lastIndex,
          timeSec,
          dt: 1 / this.inputFps,
          progress: lastIndex > 0 ? index / lastIndex : 0,
          durationSec,
          fps: this.inputFps,
          // segment + wall clock
          segment,
          dateTime,
          timezone: this.timezone,
          // geometry
          width: this.width,
          height: this.height,
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
