/**
 * src/smooth.js — presentation-only value smoothing for dashboard gauges.
 *
 * A critically-damped follow (no overshoot): the displayed value approaches its
 * target with a SMOOTHED rate of change, so a gauge needle / number glides instead
 * of snapping to each frame's raw (noisy) telemetry value. It NEVER touches the
 * data — it's per-widget display state (see docs/dashboard-spec.md §2).
 */

/**
 * Critically-damped smoother (the "SmoothDamp" kernel, Game Programming Gems 4):
 * tracks a value and its velocity toward a moving target with a single time
 * constant, never overshooting. Holds (freezes) while the source is invalid and
 * resumes WITHOUT a snap when it re-validates.
 */
export class Smoother {
  /** @param {{smoothTime?: number}} [opts] smoothTime ≈ seconds to substantially reach the target */
  constructor({ smoothTime = 0.35 } = {}) {
    this.smoothTime = smoothTime
    this._x = null // displayed value (null until the first real sample)
    this._v = 0 // its velocity
  }

  /**
   * Advance one frame toward `target` and return the smoothed value.
   * @param {number|undefined|null} target  the raw data value this frame
   * @param {number} dt                      seconds since the previous frame
   * @param {boolean} [valid=true]           false → hold (freeze), pause smoothing
   * @returns {number|null}
   */
  step(target, dt, valid = true) {
    if (target == null || !Number.isFinite(target)) return this._x // nothing to track yet
    if (this._x === null) {
      this._x = target // snap to the first real value (no sweep up from 0)
      this._v = 0
      return this._x
    }
    if (!valid || dt <= 0 || this.smoothTime <= 0) {
      this._v = 0 // freeze: hold the value, drop velocity so re-acquire starts from rest
      return this._x
    }

    // critically-damped follow — velocity is smoothed, so the value never overshoots
    const omega = 2 / this.smoothTime
    const xd = this._x - target
    const od = omega * dt
    const e = 1 / (1 + od + 0.48 * od * od + 0.235 * od * od * od) // damping kernel
    const temp = (this._v + omega * xd) * dt
    this._v = (this._v - omega * temp) * e
    this._x = target + (xd + temp) * e
    return this._x
  }
}
