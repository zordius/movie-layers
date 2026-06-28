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
    scale = null, // explicit logical→physical scale (overrides scaleBaseline)
    scaleBaseline = null, // logical baseline height; scale = height / scaleBaseline (e.g. 1080)
    background = null, // css colour to clear with; null = transparent
    baseVideo = null, // single optional base video (always the bottom layer)
    output,
    providers = [], // unified providers — each may have a data and/or layers facet
    dataProviders = [], // back-compat alias; merged into `providers`
    dataConfig = {}, // passed to each data facet: data({ sources, config })
    channelMerge = {}, // { channel: providerName } — precedence on conflict (default: last wins)
    layout = [], // [{ type, ...config }] resolved against providers
    ffmpegOptions = {},
  }) {
    this.fps = fps
    this.inputFps = inputFps ?? fps
    this._timezone = timezone // explicit override (highest precedence); resolved in render()
    this.timezone = timezone
    this._scale = scale
    this._scaleBaseline = scaleBaseline
    this.background = background
    this.baseVideo = baseVideo
    this.output = output
    // route a single provider list by facet (dataProviders alias merged in)
    const allProviders = [...providers, ...dataProviders]
    this.registry = new Registry(allProviders.filter((p) => p.layers))
    this.dataProviders = allProviders.filter((p) => typeof p.data === 'function')
    this.dataConfig = dataConfig
    this.channelMerge = channelMerge
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
      // clock candidates (spec §5): explicit config > container creation_time. A
      // GPS candidate from a data provider can outrank `meta` later (render()),
      // but never an explicit anchor. `clockSource` records which we used.
      const explicitUtc = toEpochMs(s.startUtc)
      const startUtc = explicitUtc ?? infos[i]?.creationTime ?? null
      const clockSource = explicitUtc != null ? 'explicit' : infos[i]?.creationTime != null ? 'meta' : 'none'
      if (this.sources[i]) {
        this.sources[i].offset = offset
        this.sources[i].startUtc = startUtc
      }
      offset += durationSec
      return { durationSec, startUtc, clockSource }
    })

    // base video file list for ffmpeg (concat when >1)
    this.baseVideos = specs.filter((s) => s.file).map((s) => s.file)
  }

  /**
   * Adjudicate each segment's wall-clock anchor from the candidates (spec §5),
   * mutating `this.segments` in place. `sources[i]` ↔ `segments[i]`, so a
   * provider's `clocks` entry keyed by `sourceIndex` maps straight to a segment.
   *
   *  1) pick per segment: `explicit > GPS > creation_time (meta) > none`
   *     (explicit config set in `_resolve` is never overridden);
   *  2) back-derive: an *unverified*-GPS segment (its first fix is delayed by GPS
   *     lock — e.g. a GoPro chapter 1) that is contiguous with a trusted anchor
   *     (explicit / verified-GPS) inherits that anchor's clock via cumulative
   *     duration, recovering the true start the delay hid;
   *  3) continue-time: a weak (meta/none) segment inherits the nearest reliable
   *     (explicit/gps) neighbour's anchor via cumulative duration, marked
   *     `continued` so it is NOT treated as an independent reading;
   *  4) gap detection: between two INDEPENDENT reliable anchors whose Δstart
   *     disagrees with Δcumulative-duration beyond a tolerance, flag `gap` — a real
   *     world break where the wall clock legitimately jumps (playback never does).
   */
  _resolveClocks(dataset) {
    const segs = this.segments
    const RANK = { explicit: 4, gps: 3, continued: 2, meta: 1, none: 0 }

    // cumulative playback offsets (seconds): segment i begins after prior durations
    const offset = []
    let acc = 0
    for (let i = 0; i < segs.length; i++) {
      offset[i] = acc
      acc += segs[i].durationSec
    }

    // 1) a GPS candidate upgrades a non-explicit segment over creation_time/none
    for (let i = 0; i < segs.length; i++) {
      segs[i].verified = false
      const cand = dataset.clocks.get(i)
      if (
        cand &&
        cand.startUtc != null &&
        segs[i].clockSource !== 'explicit' &&
        RANK[cand.confidence] > RANK[segs[i].clockSource]
      ) {
        segs[i].startUtc = cand.startUtc
        segs[i].clockSource = cand.confidence // 'gps'
        segs[i].verified = cand.verified === true
      }
    }

    // 2) back-derive: an unverified-GPS segment whose first fix is delayed by GPS
    // lock acquisition, but which is contiguous with a trusted anchor (explicit or
    // verified-GPS), inherits that anchor's clock via cumulative duration. Guard
    // contiguity by requiring the implied lock delay (first-fix − back-derived
    // start) to be plausible: a small negative tolerance for jitter up to a
    // cold-start TTFF ceiling. A larger mismatch ⇒ a real break (separate
    // recording), so keep the segment's own first fix.
    const trusted = (i) =>
      segs[i].clockSource === 'explicit' || (segs[i].clockSource === 'gps' && segs[i].verified)
    const MAX_LOCK_DELAY_MS = 180000 // 3-minute cold-start time-to-first-fix ceiling
    const NEG_TOL_MS = 2000
    for (let i = 0; i < segs.length; i++) {
      if (!(segs[i].clockSource === 'gps' && !segs[i].verified) || segs[i].startUtc == null) continue
      let src = -1
      let best = Infinity
      for (let j = 0; j < segs.length; j++) {
        if (!trusted(j) || segs[j].startUtc == null) continue
        const d = Math.abs(j - i)
        if (d < best) {
          best = d
          src = j
        }
      }
      if (src < 0) continue
      const derived = segs[src].startUtc + (offset[i] - offset[src]) * 1000
      const lockDelay = segs[i].startUtc - derived
      if (lockDelay >= -NEG_TOL_MS && lockDelay <= MAX_LOCK_DELAY_MS) {
        segs[i].startUtc = derived
        segs[i].clockSource = 'continued' // derived from a trusted neighbour, no longer independent
      }
    }

    const reliable = (i) => segs[i].clockSource === 'explicit' || segs[i].clockSource === 'gps'

    // 3) continue-time: fill weak segments from the nearest reliable neighbour
    for (let i = 0; i < segs.length; i++) {
      if (reliable(i)) continue
      let src = -1
      let best = Infinity
      for (let j = 0; j < segs.length; j++) {
        if (!reliable(j) || segs[j].startUtc == null) continue
        const d = Math.abs(j - i)
        if (d < best) {
          best = d
          src = j
        }
      }
      if (src >= 0) {
        segs[i].startUtc = segs[src].startUtc + (offset[i] - offset[src]) * 1000
        segs[i].clockSource = 'continued'
      }
    }

    // 4) gap detection between consecutive INDEPENDENT (original gps/explicit) anchors
    const TOL_MS = 1000
    let prev = -1
    for (let i = 0; i < segs.length; i++) {
      segs[i].gap = false
      if (!reliable(i) || segs[i].startUtc == null) continue
      if (prev >= 0) {
        const expected = (offset[i] - offset[prev]) * 1000
        const actual = segs[i].startUtc - segs[prev].startUtc
        if (Math.abs(actual - expected) > TOL_MS) segs[i].gap = true
      }
      prev = i
    }
  }

  async render() {
    await this._resolve()

    const canvas = createCanvas(this.width, this.height)
    const ctx = canvas.getContext('2d')

    // Per-segment timing for ALL segments (file-bearing AND fileless), so a
    // sidecar provider can UTC-align its samples against the timeline even with no
    // base video (where `sources` is empty). `startUtc` here is the structural
    // anchor (explicit / creation_time) — GPS upgrades land later in
    // _resolveClocks; sidecar best-clock-wins (spec §5) is a separate follow-up.
    let acc = 0
    const segmentInfos = this.segments.map((seg, i) => {
      const info = { index: i, offset: acc, startUtc: seg.startUtc, durationSec: seg.durationSec }
      acc += seg.durationSec
      return info
    })

    // load all data providers once, up front (parse → channels); each gets the
    // shared sources, the segment timeline, and its own config
    const dataset = await DataSet.load(this.dataProviders, {
      sources: this.sources.filter(Boolean),
      segments: segmentInfos,
      config: this.dataConfig,
      merge: this.channelMerge,
    })

    // timezone precedence: explicit Engine config > provider-derived (e.g. GPS) > default
    this.timezone = this._timezone ?? dataset.timezone ?? null

    // Clock resolution (spec §5): fold the providers' per-segment GPS candidates
    // into each segment's anchor — done here, after data load and before the
    // ffmpeg anchor + Timeline snapshot read segment.startUtc.
    this._resolveClocks(dataset)

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

    // global scale: the canvas stays physical, but layers draw in a LOGICAL space.
    // s = explicit, else height/scaleBaseline, else 1. Scale is by HEIGHT, so the
    // logical height is the baseline and the logical width = baseline × aspect
    // (uniform → no distortion; widgets author in logical px and anchor to edges).
    const s = this._scale ?? (this._scaleBaseline ? this.height / this._scaleBaseline : 1)
    const logicalW = this.width / s
    const logicalH = this.height / s
    this.scale = s

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
          // data + geometry (logical space — see scale below)
          data,
          scale: s,
          width: logicalW,
          height: logicalH,
        }

        ctx.save()
        ctx.scale(s, s)
        for (const { instance } of built) instance.draw(ctx, frame)
        ctx.restore()

        const { data: pixels } = ctx.getImageData(0, 0, this.width, this.height)
        await pipe.writeFrame(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))
      }
    } finally {
      await pipe.finish()
    }
  }
}
