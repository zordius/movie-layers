import { createCanvas } from '@napi-rs/canvas'

import { FfmpegPipe } from './ffmpeg.js'
import { Registry } from './layer.js'
import { DataSet } from './data.js'
import { Timeline } from './timeline.js'
import { Source } from './source.js'

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
 * The compositor. Resolves config (probing the base video when needed), loads
 * data providers once, then for each frame clears the canvas, draws every layer
 * bottom→top into one RGBA frame, and pipes it to ffmpeg.
 *
 * Config precedence is `explicit > probed > error`: width/height/durationSec and
 * the wall-clock anchor default from the base video's container metadata when
 * not given explicitly. (A GPS-derived anchor from a data provider will later
 * override probed creation_time.)
 *
 * The `frame` handed to each layer carries playback clock (index, frameCount,
 * isFirst, isLast, timeSec, dt, progress, durationSec, fps), segment + wall
 * clock (segment, dateTime, timezone), data accessor, and geometry.
 */
export class Engine {
  constructor({
    width = null,
    height = null,
    fps = 30,
    inputFps = null, // rate we produce frames at; defaults to fps
    durationSec = null, // single-segment length (ignored when `segments` given)
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

    // raw config — resolved (possibly via probe) in render()
    this._width = width
    this._height = height
    this._durationSec = durationSec
    this._segmentsOpt = segments
    this._startDateTime = startDateTime

    this.width = null
    this.height = null
    this.segments = null
  }

  /**
   * Normalise inputs to a per-segment list, probe each file segment once
   * (shared Source), then derive geometry + per-segment duration / offset /
   * wall-clock anchor. Precedence `explicit > probed`. Playback `offset` is
   * cumulative duration (gaps not counted); `startUtc` is per segment.
   *
   * Clock resolution here is the structural part only — explicit `startUtc` else
   * the segment's `creation_time`. The GPS-candidate / continue-time / gap /
   * confidence machinery (spec §5) is deferred (needs provider-gopro).
   */
  async _resolve() {
    // segment specs: explicit segments > single baseVideo > synthetic (durationSec)
    let specs
    if (this._segmentsOpt) {
      specs = this._segmentsOpt
    } else if (this.baseVideo) {
      specs = [{ file: this.baseVideo }]
    } else {
      if (this._durationSec == null) {
        throw new Error('Engine needs one of: `durationSec`, `baseVideo`, or `segments`')
      }
      specs = [{ durationSec: this._durationSec, startUtc: this._startDateTime }]
    }

    const ff = { ffmpeg: this.ffmpegOptions.ffmpeg, ffprobe: this.ffmpegOptions.ffprobe }
    this.sources = specs.map((s) => (s.file ? new Source(s.file, ff) : null))
    const infos = await Promise.all(this.sources.map((src) => (src ? src.info() : null)))

    // geometry: explicit, else first file segment's probe
    const firstInfo = infos.find(Boolean) ?? null
    this.width = this._width ?? firstInfo?.width ?? null
    this.height = this._height ?? firstInfo?.height ?? null
    if (this.width == null || this.height == null) {
      throw new Error('Engine needs `width`/`height` (or a file-bearing segment to derive them from)')
    }

    // concat (stream-copy) requires identical dimensions across file segments
    const fileInfos = infos.filter(Boolean)
    for (const fi of fileInfos) {
      if (fi.width !== fileInfos[0].width || fi.height !== fileInfos[0].height) {
        throw new Error(
          `segments must share dimensions for concat ` +
            `(got ${fileInfos[0].width}x${fileInfos[0].height} and ${fi.width}x${fi.height})`,
        )
      }
    }

    // segments + cumulative offsets + per-segment anchors
    let offset = 0
    this.segments = specs.map((s, i) => {
      const durationSec = s.durationSec ?? infos[i]?.durationSec ?? null
      if (durationSec == null) {
        throw new Error(`segment ${i} needs a \`durationSec\` or a probeable \`file\``)
      }
      const startUtc = toEpochMs(s.startUtc) ?? infos[i]?.creationTime ?? null
      if (this.sources[i]) {
        this.sources[i].offset = offset
        this.sources[i].startUtc = startUtc
      }
      offset += durationSec
      return { durationSec, startUtc }
    })

    // base video file list for ffmpeg (concat when >1)
    this.baseVideos = specs.filter((s) => s.file).map((s) => s.file)
  }

  async render() {
    await this._resolve()

    const canvas = createCanvas(this.width, this.height)
    const ctx = canvas.getContext('2d')

    // load all data providers once, up front (parse → channels); each gets the
    // shared sources + its own config
    const dataset = await DataSet.load(this.dataProviders, {
      sources: this.sources.filter(Boolean),
      config: this.dataConfig,
    })

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
      baseVideos: this.baseVideos,
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
