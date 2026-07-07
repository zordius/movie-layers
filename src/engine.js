import { writeFileSync } from 'node:fs'

import { createCanvas, loadImage } from '@napi-rs/canvas'

import { FfmpegPipe, extractFrame, concatCopy } from './ffmpeg.js'
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
    clockOffsetSec = 0, // signed seconds added to the resolved wall clock to fix a wrong camera clock (§5)
    timezone = null, // display tz for dateTime
    scale = null, // explicit logical→physical scale (overrides scaleBaseline)
    scaleBaseline = null, // logical baseline height; scale = height / scaleBaseline (e.g. 1080)
    renderStartSec = null, // render only [start,end) of the timeline (a parallel-render chunk);
    renderEndSec = null, //    base is `-ss`-seeked to start and cut at the chunk's overlay end
    renderWarmupSec = 0, // draw this many seconds before renderStartSec WITHOUT emitting them,
    //                      so stateful gauge smoothing converges to the right value at the seam
    background = null, // css colour to clear with; null = transparent
    baseVideo = null, // single optional base video (always the bottom layer)
    output,
    providers = [], // unified providers — each may have a data and/or layers facet
    dataProviders = [], // back-compat alias; merged into `providers`
    dataConfig = {}, // passed to each data facet: data({ sources, config })
    channelMerge = {}, // { channel: providerName } — precedence on conflict (default: last wins)
    gaugeSmoothing = true, // default presentation smoothing for gauge widgets (dashboard-spec §2)
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
    this._gaugeSmoothing = gaugeSmoothing
    this.layoutSpec = layout
    this.ffmpegOptions = ffmpegOptions

    // raw config — resolved (possibly via probe) in render()
    this._width = width
    this._height = height
    this._durationSec = durationSec
    this._segmentsOpt = segments
    this._startDateTime = startDateTime
    this._clockOffsetSec = clockOffsetSec
    this._renderStartSec = renderStartSec
    this._renderEndSec = renderEndSec
    this._renderWarmupSec = renderWarmupSec

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
      let startUtc = explicitUtc ?? infos[i]?.creationTime ?? null
      const clockSource = explicitUtc != null ? 'explicit' : infos[i]?.creationTime != null ? 'meta' : 'none'
      // Manual clock correction (spec §5): a no-`cts` sidecar (Garmin .gpx) can't
      // recover an unknown camera-clock offset on its own, so the human supplies
      // it — a signed seconds nudge added to the resolved wall clock. Corrects BOTH
      // sidecar alignment (flows into segmentInfos) AND the displayed dateTime.
      // Combinable with startDateTime (nudges the explicit anchor too). A GPS clock,
      // if a provider derives one, supersedes this in _resolveClocks and needs no fix.
      if (startUtc != null && this._clockOffsetSec) startUtc += this._clockOffsetSec * 1000
      if (this.sources[i]) {
        this.sources[i].offset = offset
        this.sources[i].startUtc = startUtc
      }
      offset += durationSec
      return { durationSec, startUtc, clockSource }
    })

    // base video file list for ffmpeg (concat when >1), with each one's own duration
    // (already probed above) — lets the concat demuxer compute seek offsets analytically
    // instead of opening every physical file just to find where a `-ss` target lands.
    this.baseVideos = specs.filter((s) => s.file).map((s) => s.file)
    this.baseVideoDurations = specs.map((s, i) => (s.file ? this.segments[i].durationSec : null)).filter((d) => d != null)
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

  /**
   * Shared setup for render() and snapshot(): resolve config, load data, resolve
   * clocks, build + validate layers, prep the canvas / timeline / scale. No ffmpeg,
   * no drawing. Returns the pieces both paths draw with.
   */
  async _scene() {
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
      // inject the global gauge-smoothing default; a per-layout `smooth` still overrides
      const cfg = { smooth: this._gaugeSmoothing, ...config }
      return { type, needs: reg.needs, needsClock: reg.needsClock, instance: reg.create(cfg, ctx) }
    })
    // A wall clock exists if any segment resolved a startUtc (explicit / GPS /
    // creation_time). A clock-reading layer (datetime) fails fast when there is
    // none — better than silently rendering blank dates the user only spots after
    // the whole encode finishes.
    const hasWallClock = this.segments.some((s) => s.startUtc != null)
    for (const { type, needs, needsClock } of built) {
      for (const ch of needs) {
        if (!dataset.has(ch)) {
          throw new Error(
            `Layer "${type}" needs data channel "${ch}", but no data provider supplies it ` +
              `(available: ${dataset.list().join(', ') || 'none'})`,
          )
        }
      }
      if (needsClock && !hasWallClock) {
        throw new Error(
          `Layer "${type}" needs a wall clock (frame.dateTime), but no segment resolved one — ` +
            `set Engine \`startDateTime\` / \`segments[].startUtc\`, use a base video with a usable ` +
            `\`creation_time\`, or a data provider that derives a GPS clock`,
        )
      }
    }

    const timeline = new Timeline({ segments: this.segments, fps: this.inputFps })
    // global scale: the canvas stays physical, but layers draw in a LOGICAL space.
    // s = explicit, else height/scaleBaseline, else 1. Scale is by HEIGHT, so the
    // logical height is the baseline and the logical width = baseline × aspect.
    const s = this._scale ?? (this._scaleBaseline ? this.height / this._scaleBaseline : 1)
    this.scale = s

    // async layer init (optional `prepare`), awaited once before the render loop:
    // a layer that needs heavy/async setup that's constant across frames (e.g.
    // provider-map fetching + compositing OSM tiles) does it here, given the data
    // view and the logical→physical scale. The synchronous draw() just blits it.
    const view = dataset.view()
    for (const { instance } of built) {
      if (typeof instance.prepare === 'function') {
        await instance.prepare({ data: view, scale: s, logicalW: this.width / s, logicalH: this.height / s })
      }
    }
    return {
      canvas,
      ctx,
      built,
      data: dataset.view(),
      channelNames: dataset.list(),
      timeline,
      s,
      logicalW: this.width / s,
      logicalH: this.height / s,
    }
  }

  /**
   * Run the scene setup once and return it alongside a plain-data `summary` (geometry,
   * clock, timezone, per-channel sample counts + ranges, widget list) for a caller to
   * log. Pass the returned `scene` to render()/snapshot() to avoid re-loading data.
   */
  async prepare() {
    const scene = await this._scene()
    const seg0 = this.segments[0]
    const channels = {}
    for (const name of scene.channelNames) {
      const st = scene.data.stats(name)
      channels[name] = {
        unit: scene.data.unit(name) ?? null,
        count: (scene.data.series(name) ?? []).length,
        min: st?.min ?? null,
        max: st?.max ?? null,
      }
    }
    const summary = {
      width: this.width,
      height: this.height,
      fps: this.fps,
      durationSec: scene.timeline.durationSec,
      frameCount: scene.timeline.frameCount,
      segments: this.segments.length,
      clock: seg0 ? { startUtc: seg0.startUtc, confidence: seg0.clockSource, verified: seg0.verified === true } : null,
      timezone: this.timezone,
      channels,
      layers: scene.built.map((b) => b.type),
    }
    return { scene, summary }
  }

  /** Draw one frame's overlay layers onto `ctx`; the caller handles clear / background / base. */
  _drawOverlay(ctx, built, data, scene, step) {
    const { timeline, s, logicalW, logicalH } = scene
    const { index, timeSec, segment } = step
    const lastIndex = timeline.frameCount - 1
    data._t = timeSec
    const dateTime =
      segment.startUtc != null ? new Date(segment.startUtc + segment.localTimeSec * 1000) : null
    const frame = {
      index,
      frameCount: timeline.frameCount,
      isFirst: index === 0,
      isLast: index === lastIndex,
      timeSec,
      dt: 1 / this.inputFps,
      progress: lastIndex > 0 ? index / lastIndex : 0,
      durationSec: timeline.durationSec,
      fps: this.inputFps,
      segment,
      dateTime,
      timezone: this.timezone,
      data,
      scale: s,
      width: logicalW,
      height: logicalH,
    }
    ctx.save()
    ctx.scale(s, s)
    for (const { instance } of built) instance.draw(ctx, frame)
    ctx.restore()
  }

  async render({ scene = null, onProgress = null, onCommand = null } = {}) {
    scene = scene ?? (await this._scene())
    const { ctx, built, data } = scene

    const anchorMs = this.segments[0].startUtc

    const ranged = this._renderStartSec != null || this._renderEndSec != null

    // No overlay layers + a base video → nothing to draw, so stitch losslessly
    // (stream copy) instead of re-encoding every frame through the canvas pipe.
    // (A ranged render always re-encodes — the stream-copy shortcut ignores ranges.)
    if (built.length === 0 && this.baseVideos.length >= 1 && !ranged) {
      return concatCopy(this.baseVideos, this.output, {
        ffmpeg: this.ffmpegOptions.ffmpeg,
        creationTime: anchorMs != null ? new Date(anchorMs).toISOString() : null,
        onCommand,
      })
    }

    const pipe = new FfmpegPipe({
      width: this.width,
      height: this.height,
      fps: this.fps,
      inputFps: this.inputFps,
      baseVideos: this.baseVideos,
      baseVideoDurations: this.baseVideoDurations,
      output: this.output,
      pixfmt: 'rgba',
      creationTime: anchorMs != null ? new Date(anchorMs).toISOString() : null,
      onCommand,
      seekSec: this._renderStartSec,
      // cut the chunk to its window length (overlay filter length follows the longer base)
      clipSec: ranged && this._renderEndSec != null ? this._renderEndSec - (this._renderStartSec ?? 0) : null,
      ...this.ffmpegOptions,
    }).start()

    const writeStart = this._renderStartSec // first emitted frame; null = from the top
    const drawStart = writeStart != null ? writeStart - this._renderWarmupSec : null
    // `onProgress` counts against the frames THIS call will actually write — the render
    // WINDOW (writeStart..renderEndSec), not scene.timeline.frameCount (the full clip).
    // Otherwise a --range near the start of a long clip reports a percent that barely
    // moves (e.g. stuck at "4%") because the denominator is the whole timeline.
    const windowEndSec = this._renderEndSec ?? scene.timeline.durationSec
    const totalFrames = Math.max(1, Math.round((windowEndSec - (writeStart ?? 0)) * this.inputFps))
    let written = 0
    try {
      for (const step of scene.timeline.steps()) {
        if (drawStart != null && step.timeSec < drawStart) continue
        if (this._renderEndSec != null && step.timeSec >= this._renderEndSec) break
        ctx.clearRect(0, 0, this.width, this.height)
        if (this.background) {
          ctx.fillStyle = this.background
          ctx.fillRect(0, 0, this.width, this.height)
        }
        // Always draw — this advances stateful gauge smoothing. But a warm-up frame
        // (before writeStart) is NOT emitted: it only exists to converge the smoother
        // so a parallel chunk's seam matches the single-render value.
        this._drawOverlay(ctx, built, data, scene, step)
        if (writeStart != null && step.timeSec < writeStart) continue
        const { data: pixels } = ctx.getImageData(0, 0, this.width, this.height)
        await pipe.writeFrame(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))
        onProgress?.(++written, totalFrames)
      }
    } finally {
      await pipe.finish()
    }
  }

  /**
   * Render ONE frame to a PNG for preview — the overlay composited over the base
   * video frame at `atSec` (default: the middle of the timeline). With no base
   * video the overlay sits on `background` (or transparent). Writes `output`.
   *
   * `warmupSec` draws (but discards) the steps from `atSec - warmupSec` up to the
   * target — the same "draw but don't emit" trick as render()'s `renderWarmupSec` —
   * so stateful widget smoothing (src/smooth.js's `Smoother`: gauge display smoothing,
   * Latlon's heading smoothing) has converged to what continuous playback would
   * actually show at `atSec`, instead of snapshotting each Smoother's FIRST call
   * (which always snaps to the raw value, dashboard-spec §2).
   */
  async snapshot({ atSec = null, output = this.output, scene = null, onCommand = null, warmupSec = 1.5 } = {}) {
    scene = scene ?? (await this._scene())
    const { ctx, built, data, timeline } = scene
    const t = atSec != null ? atSec : timeline.durationSec / 2 // default: the middle frame

    // warm up from (t - warmupSec), clamped to 0, up to the target step
    const warmupStart = Math.max(0, t - warmupSec)
    let step = null
    for (const s of timeline.steps()) {
      if (s.timeSec < warmupStart) continue
      if (s.timeSec < t) {
        this._drawOverlay(ctx, built, data, scene, s) // advance smoothing state; pixels discarded below
        continue
      }
      step = s
      break
    }
    if (!step) throw new Error('snapshot: empty timeline (nothing to draw)')

    ctx.clearRect(0, 0, this.width, this.height)
    // composite over the base video frame (seek the step's own segment file), else background
    const file = this.sources[step.segment.index]?.file
    if (file) {
      const png = await extractFrame(file, step.segment.localTimeSec, { ffmpeg: this.ffmpegOptions.ffmpeg, onCommand })
      const img = await loadImage(png)
      ctx.drawImage(img, 0, 0, this.width, this.height)
    } else if (this.background) {
      ctx.fillStyle = this.background
      ctx.fillRect(0, 0, this.width, this.height)
    }
    this._drawOverlay(ctx, built, data, scene, step)
    writeFileSync(output, scene.canvas.toBuffer('image/png'))
    return output
  }
}
