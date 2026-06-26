import { createCanvas } from '@napi-rs/canvas'

import { FfmpegPipe } from './ffmpeg.js'
import { Registry } from './layer.js'
import { DataSet } from './data.js'
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
 * The compositor. Loads data providers once, then for each frame clears the
 * canvas, draws every layer bottom→top into one RGBA frame, and pipes it to
 * ffmpeg.
 *
 * The `frame` handed to each layer carries:
 *  - playback clock (continuous): index, frameCount, isFirst, isLast, timeSec,
 *    dt, progress, durationSec, fps
 *  - segment + wall clock: segment{index,localIndex,localTimeSec,startUtc},
 *    dateTime (= segment.startUtc + localTime, may jump across a gap; null when
 *    no anchor), timezone
 *  - data: time-bound accessor — get/series/stats/unit/has (interpolated at timeSec)
 *  - geometry: width, height
 *
 * Time fields are engine-intrinsic (timeline + config). Channel values come
 * from data providers; the engine only brokers and interpolates them.
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
    providers = [], // layer providers
    dataProviders = [], // data providers (time-varying channels)
    dataConfig = {}, // passed to each dataProvider.load(config)
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
    this.dataProviders = dataProviders
    this.dataConfig = dataConfig
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

    // load all data providers once, up front (parse → channels)
    const dataset = await DataSet.load(this.dataProviders, this.dataConfig)

    // build layers, then fail fast if a declared data need is unmet
    const built = this.layoutSpec.map(({ type, ...config }) => {
      const reg = this.registry.get(type)
      return { type, needs: reg.needs, instance: reg.create(config, ctx) }
    })
    for (const { type, needs } of built) {
      for (const ch of needs) {
        if (!dataset.has(ch)) {
          throw new Error(
            `Layer "${type}" needs data channel "${ch}", but no data provider supplies it ` +
              `(available: ${dataset.list().join(', ') || 'none'})`,
          )
        }
      }
    }
    const data = dataset.view()

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

        data._t = timeSec
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
          // data + geometry
          data,
          width: this.width,
          height: this.height,
        }

        for (const { instance } of built) instance.draw(ctx, frame)

        const { data: pixels } = ctx.getImageData(0, 0, this.width, this.height)
        await pipe.writeFrame(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))
      }
    } finally {
      await pipe.finish()
    }
  }
}
