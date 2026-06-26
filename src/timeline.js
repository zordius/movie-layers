/**
 * Maps global time → frame indices and steps the render loop.
 *
 * For now this is a simple uniform stepper. It is the seam where multi-input
 * sync will live later: mapping global t → each layer's local sample (a video
 * layer's frame, a telemetry sample, an SVG keyframe), the generalisation of
 * gopro-dashboard-overlay's stepper + timelapse_correction.
 */
export class Timeline {
  constructor({ durationSec, fps }) {
    this.durationSec = durationSec
    this.fps = fps
    this.frameCount = Math.round(durationSec * fps)
  }

  *steps() {
    for (let index = 0; index < this.frameCount; index++) {
      yield { index, timeSec: index / this.fps }
    }
  }
}
