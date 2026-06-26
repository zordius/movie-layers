/**
 * Segment-based timeline.
 *
 * Two clocks, on purpose:
 *  - PLAYBACK time is continuous across segments (concat plays back-to-back) —
 *    `timeSec` / frame index never jump.
 *  - WALL-CLOCK comes from each segment's own anchor (`startUtc`), so dateTime
 *    (computed in the engine as startUtc + localTime) can jump across a
 *    real-world gap between segments while playback time does not.
 *
 * A single video is just N=1 segments — no special case.
 *
 * @param {{ durationSec: number, startUtc: number|null }[]} segments
 *        startUtc = epoch ms (or null when no anchor)
 * @param {number} fps  frame production rate
 */
export class Timeline {
  constructor({ segments, fps }) {
    this.fps = fps
    this.segments = []

    let globalStart = 0 // playback seconds — accumulates durations only (NOT gaps)
    let firstFrame = 0
    for (const seg of segments) {
      const frameCount = Math.max(0, Math.round(seg.durationSec * fps))
      this.segments.push({
        durationSec: seg.durationSec,
        startUtc: seg.startUtc ?? null,
        globalStart,
        firstFrame,
        frameCount,
      })
      globalStart += seg.durationSec
      firstFrame += frameCount
    }

    this.durationSec = globalStart
    this.frameCount = firstFrame
  }

  _segmentForFrame(index) {
    for (let s = 0; s < this.segments.length; s++) {
      const seg = this.segments[s]
      if (index < seg.firstFrame + seg.frameCount) return [seg, s]
    }
    const s = this.segments.length - 1
    return [this.segments[s], s]
  }

  *steps() {
    for (let index = 0; index < this.frameCount; index++) {
      const [seg, s] = this._segmentForFrame(index)
      const localIndex = index - seg.firstFrame
      yield {
        index,
        timeSec: index / this.fps,
        segment: {
          index: s,
          localIndex,
          localTimeSec: localIndex / this.fps,
          startUtc: seg.startUtc,
        },
      }
    }
  }
}
