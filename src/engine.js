import { writeFileSync } from 'node:fs'

import { createCanvas, loadImage } from '@napi-rs/canvas'

import { FfmpegPipe, extractFrame, concatCopy } from './ffmpeg.js'
import { haversineM } from './gradient.js'
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
/** Clamped linear interpolation over t-sorted `{t, value}` samples (numbers or {lat,lon}). */
function sampleAtT(samples, t) {
  if (!samples.length) return undefined
  if (t <= samples[0].t) return samples[0].value
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1].value
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  const f = b.t - a.t > 0 ? (t - a.t) / (b.t - a.t) : 0
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * f
  if (a.value?.lat != null && b.value?.lat != null) {
    return { lat: a.value.lat + (b.value.lat - a.value.lat) * f, lon: a.value.lon + (b.value.lon - a.value.lon) * f }
  }
  return a.value
}

/** primary − secondary at a splice edge; null when the shapes don't support blending. */
function valueDelta(pv, sv) {
  if (typeof pv === 'number' && typeof sv === 'number') return { d: pv - sv }
  if (pv?.lat != null && sv?.lat != null) return { lat: pv.lat - sv.lat, lon: pv.lon - sv.lon }
  return null
}

/** value + delta·w — the taper application (numbers and {lat,lon}). */
function addDelta(v, delta, w) {
  if (w <= 0) return v
  if (delta.d != null && typeof v === 'number') return v + delta.d * w
  if (delta.lat != null && v?.lat != null) return { ...v, lat: v.lat + delta.lat * w, lon: v.lon + delta.lon * w }
  return v
}

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
    renderEndSec = null, //    base is `-ss`-seeked to start and cut at the chunk's overlay end;
    //                      a NEGATIVE value counts back from the end of the full timeline
    //                      (python-slice style: -30 = durationSec − 30), resolved in _resolve()
    renderWarmupSec = 0, // draw this many seconds before renderStartSec WITHOUT emitting them,
    //                      so stateful gauge smoothing converges to the right value at the seam
    background = null, // css colour to clear with; null = transparent
    baseVideo = null, // single optional base video (always the bottom layer)
    output,
    providers = [], // unified providers — each may have a data and/or layers facet
    dataProviders = [], // back-compat alias; merged into `providers`
    dataConfig = {}, // passed to each data facet: data({ sources, config })
    channelMerge = {}, // { channel: providerName } — precedence on conflict (default: last wins)
    channelFill = null, // splice a SECONDARY source into a primary channel's signal holes:
    //   { minGapSec, minMoveM, fills: { gps: 'gopro:gps', ... }, drop: [...] } — windows are
    //   found on the primary `gps` channel (gap > minGapSec AND the endpoints moved
    //   > minMoveM; the tail after gps ends counts too), each fill's samples inside a
    //   window are inserted, and `drop` names are removed afterwards (see _applyChannelFill)
    gaugeSmoothing = true, // default presentation smoothing for gauge widgets (dashboard-spec §2)
    layout = [], // [{ type, ...config }] resolved against providers
    metadata = {}, // extra output-container tags (`-metadata k=v`), e.g. encoder/comment provenance
    ffmpegOptions = {},
    precomputed = null, // { width, height, baseVideos, baseVideoDurations, segments, timezone,
    //   channels } from a prior prepareData() call — skips probing + provider data-loading +
    //   clock resolution entirely and uses this instead (the CLI's --jobs parent precomputes
    //   this once and hands the same bundle to every chunk, instead of each chunk redoing
    //   potentially expensive per-file extraction, e.g. provider-gopro's GPS parsing)
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
    this.channelFill = channelFill
    this._gaugeSmoothing = gaugeSmoothing
    this.layoutSpec = layout
    this.metadata = metadata
    this.ffmpegOptions = ffmpegOptions
    this._precomputed = precomputed

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
    // precomputed bundle (--jobs parent already resolved this once) — skip probing
    // entirely. `sources` stays empty: nothing on the render() path needs it (only
    // snapshot()'s extractFrame does, and precomputed mode is render()-only).
    if (this._precomputed) {
      const p = this._precomputed
      this.width = p.width
      this.height = p.height
      this.segments = p.segments
      this.baseVideos = p.baseVideos
      this.baseVideoDurations = p.baseVideoDurations
      this.sources = []
      this._resolveRenderWindow()
      return
    }
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

    this._resolveRenderWindow()
  }

  /**
   * Resolve the render window against the now-known timeline: a NEGATIVE
   * `renderStartSec`/`renderEndSec` counts back from the end of the full timeline
   * (python-slice style: -30 = durationSec − 30, clamped at 0), and the warm-up is
   * clamped so it never seeks before 0. Throws when the resolved window is empty
   * (start ≥ end) — otherwise it would silently render nothing.
   */
  _resolveRenderWindow() {
    const total = this.segments.reduce((sum, s) => sum + s.durationSec, 0)
    const abs = (v) => (v == null ? null : v < 0 ? Math.max(0, total + v) : v)
    this._renderStartSec = abs(this._renderStartSec)
    this._renderEndSec = abs(this._renderEndSec)
    if (
      this._renderStartSec != null &&
      this._renderEndSec != null &&
      this._renderEndSec <= this._renderStartSec
    ) {
      throw new Error(
        `render range [${this._renderStartSec}s, ${this._renderEndSec}s) is empty — ` +
          `start ≥ end after resolving against the ${total.toFixed(1)}s timeline`,
      )
    }
    if (this._renderStartSec != null) {
      this._renderWarmupSec = Math.min(this._renderWarmupSec, this._renderStartSec)
    }
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
    const MAX_UNVERIFIED_SKEW_MS = 30 * 86400000 // past this vs a trusted anchor, an unverified anchor is garbage (step 2.5)
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
      } else if (Math.abs(lockDelay) > MAX_UNVERIFIED_SKEW_MS) {
        // 2.5) absurd-anchor demotion: a no-lock GoPro track can carry a stale /
        // bogus GPSU (e.g. a years-off date) that arrives here as a plausible-
        // looking UNVERIFIED 'gps' anchor. Against a TRUSTED anchor, a skew this
        // large is garbage — not a real recording break (a genuine multi-day
        // concat with only an unverified first fix is the rare case sacrificed
        // here; trust wins). Demote so continue-time (step 3) refills it from
        // the trusted neighbour — otherwise the wall clock, the footage-span
        // log, and the stamped creation_time all inherit the bogus date.
        segs[i].startUtc = null
        segs[i].clockSource = 'none'
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
   * Splice a secondary source into the primary channels' signal holes (Engine
   * `channelFill`). Fill WINDOWS come from the primary `gps` channel: an
   * inter-sample gap > `minGapSec` whose endpoints sit > `minMoveM` apart
   * horizontally (a paused-but-stationary recorder needs no fill), plus the TAIL
   * — the primary ending > `minGapSec` before the timeline does counts as a
   * break with nothing after it. Every `fills` pair then inserts the secondary
   * samples falling strictly inside a window into the primary channel, and the
   * `drop` names (the secondary channels) are removed so widgets/`needs` never
   * see them. Deterministic — --jobs chunks recompute identical fills.
   *
   * The two sources can disagree by a few metres (different receivers), so each
   * window edge gets a `blendSec` (default 5 s) linear taper: inserted values
   * near an edge are shifted by the primary−secondary delta AT that edge, fading
   * to raw secondary toward the window middle — the splice lands exactly on the
   * primary's endpoint instead of stepping sideways. A window shorter than
   * 2×blendSec splits it evenly; the tail (and an edge the secondary doesn't
   * actually reach) blends on the available side only.
   */
  _applyChannelFill(dataset) {
    if (!this.channelFill) return
    const { minGapSec = 60, minMoveM = 100, blendSec = 5, fills = {}, drop = [] } = this.channelFill
    const prim = dataset.channels.get('gps')
    const sec = dataset.channels.get(fills.gps)
    if (prim?.samples.length && sec?.samples.length) {
      const s = prim.samples
      const windows = []
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1]
        const b = s[i]
        if (b.t - a.t > minGapSec && a.value?.lat != null && b.value?.lat != null && haversineM(a.value, b.value) > minMoveM) {
          windows.push([a.t, b.t])
        }
      }
      const totalSec = this.segments.reduce((sum, x) => sum + x.durationSec, 0)
      if (totalSec - s[s.length - 1].t > minGapSec) windows.push([s[s.length - 1].t, Infinity])
      if (windows.length) {
        for (const [name, from] of Object.entries(fills)) {
          const p = dataset.channels.get(name)
          const alt = dataset.channels.get(from)
          if (!p || !alt?.samples.length) continue
          const inserts = []
          for (const [t0, t1] of windows) {
            const wins = alt.samples.filter((m) => m.t > t0 && m.t < t1)
            if (!wins.length) continue
            const wB = Math.min(blendSec, (Number.isFinite(t1) ? t1 - t0 : Infinity) / 2)
            // blend only on edges the secondary actually reaches within the taper
            const da = wins[0].t - t0 <= wB ? valueDelta(sampleAtT(p.samples, t0), sampleAtT(alt.samples, t0)) : null
            const db =
              Number.isFinite(t1) && t1 - wins[wins.length - 1].t <= wB
                ? valueDelta(sampleAtT(p.samples, t1), sampleAtT(alt.samples, t1))
                : null
            for (const m of wins) {
              let v = m.value
              if (da) v = addDelta(v, da, Math.max(0, 1 - (m.t - t0) / wB))
              if (db) v = addDelta(v, db, Math.max(0, 1 - (t1 - m.t) / wB))
              inserts.push(v === m.value ? m : { t: m.t, value: v })
            }
          }
          if (inserts.length) dataset.addChannel(name, p.unit, [...p.samples, ...inserts], p.maxGap)
        }
      }
    }
    for (const name of drop) dataset.channels.delete(name)
  }

  /**
   * Resolve config + load all provider data + resolve clocks (spec §5) — everything
   * needed to render EXCEPT the canvas/layers/timeline (those are cheap and stay in
   * _scene(); this is the potentially-expensive half, e.g. provider-gopro's per-file GPS
   * extraction). Returns a plain, JSON-serializable bundle.
   *
   * Exists as its own method so the CLI's `--jobs` parent can call it ONCE and hand the
   * same bundle to every chunk (via the `precomputed` constructor option) instead of each
   * chunk redoing potentially expensive extraction redundantly.
   */
  async prepareData() {
    await this._resolve()

    // Per-segment timing for ALL segments (file-bearing AND fileless), so a
    // sidecar provider can UTC-align its samples against the timeline even with no
    // base video (where `sources` is empty). Rebuilt after clock resolution so the
    // second load round (below) sees the upgraded anchors.
    const segmentInfos = () => {
      let acc = 0
      return this.segments.map((seg, i) => {
        const info = { index: i, offset: acc, startUtc: seg.startUtc, durationSec: seg.durationSec }
        acc += seg.durationSec
        return info
      })
    }

    // Two-phase data load (spec §5). A provider marked `needsClock: true` (a
    // sidecar like provider-gpx) aligns its samples against the segments' wall
    // clocks, so it must see the BEST anchors — load the clock-producing providers
    // first, fold their GPS candidates into each segment (_resolveClocks), then
    // load the clock-aligned providers against the resolved anchors. Clock
    // candidates from the second round are not re-adjudicated (a no-`cts` sidecar
    // can't anchor the video — spec §5 "wrong camera clock").
    const eager = this.dataProviders.filter((p) => p.needsClock !== true)
    const aligned = this.dataProviders.filter((p) => p.needsClock === true)
    const shared = { sources: this.sources.filter(Boolean), config: this.dataConfig, merge: this.channelMerge }
    const dataset = await DataSet.load(eager, { ...shared, segments: segmentInfos() })

    // Clock resolution (spec §5): fold the providers' per-segment GPS candidates
    // into each segment's anchor — done here, after the first load round and before
    // the aligned round + ffmpeg anchor + Timeline snapshot read segment.startUtc.
    this._resolveClocks(dataset)

    if (aligned.length) await dataset.loadFrom(aligned, { ...shared, segments: segmentInfos() })

    // gap-fill a primary channel from a secondary source (e.g. a gpx sidecar's
    // blackout backfilled by the clip's own embedded GPS) — after BOTH rounds,
    // so both sources are present
    this._applyChannelFill(dataset)

    // timezone precedence: explicit Engine config > provider-derived (e.g. GPS) > default
    this.timezone = this._timezone ?? dataset.timezone ?? null

    return {
      width: this.width,
      height: this.height,
      baseVideos: this.baseVideos,
      baseVideoDurations: this.baseVideoDurations,
      segments: this.segments,
      timezone: this.timezone,
      channels: Object.fromEntries(
        dataset.list().map((name) => {
          const c = dataset.channels.get(name)
          // maxGap defaults to Infinity, which JSON.stringify silently turns into `null` —
          // null it explicitly here so the bundle round-trips through a file (--jobs
          // children read it back with `?? Infinity` below) without a silent meaning change
          return [name, { unit: c.unit, maxGap: Number.isFinite(c.maxGap) ? c.maxGap : null, samples: c.samples }]
        }),
      ),
    }
  }

  /**
   * Shared setup for render() and snapshot(): resolve config, load data, resolve
   * clocks, build + validate layers, prep the canvas / timeline / scale. No ffmpeg,
   * no drawing. Returns the pieces both paths draw with.
   */
  async _scene() {
    const bundle = this._precomputed ?? (await this.prepareData())
    this.width = bundle.width
    this.height = bundle.height
    this.baseVideos = bundle.baseVideos
    this.baseVideoDurations = bundle.baseVideoDurations
    this.segments = bundle.segments
    this.timezone = bundle.timezone

    const canvas = createCanvas(this.width, this.height)
    const ctx = canvas.getContext('2d')

    const dataset = new DataSet()
    for (const [name, ch] of Object.entries(bundle.channels)) {
      dataset.addChannel(name, ch.unit, ch.samples, ch.maxGap ?? Infinity)
    }

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
        metadata: this.metadata,
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
      metadata: this.metadata,
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
