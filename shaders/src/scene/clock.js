// shaders/src/scene/clock.js

/**
 * Frame timing for scene programs. Driven by canvas.js, which ticks it from
 * two different time bases: the raw rAF timestamp in the animation loop, and
 * an already-wrapped loop position in render(). The clock therefore reports
 * only what survives both: monotonic-per-tick `delta`, plus `elapsed` and
 * `frame`. Loop position belongs to the canvas (`_loopDuration`), not here.
 */
export class Clock {
  constructor() {
    this.elapsed = 0
    this.delta = 0
    this.frame = 0
    this._lastTime = null
    this._startTime = null
  }

  tick(timeMs) {
    if (this._startTime === null) {
      this._startTime = timeMs
      this._lastTime = timeMs
      this.frame = 1
      this.delta = 0
      this.elapsed = 0
      return
    }
    // Time steps backwards once per animation loop when the caller feeds a
    // wrapped loop position. A negative delta is meaningless to consumers
    // (it would run integrators backwards), so report no elapsed time for
    // the wrap frame instead.
    const delta = (timeMs - this._lastTime) / 1000
    this.delta = delta > 0 ? delta : 0
    this.elapsed = (timeMs - this._startTime) / 1000
    this._lastTime = timeMs
    this.frame++
  }

  reset() {
    this.elapsed = 0
    this.delta = 0
    this.frame = 0
    this._lastTime = null
    this._startTime = null
  }
}
