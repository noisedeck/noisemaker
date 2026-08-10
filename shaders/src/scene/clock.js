// shaders/src/scene/clock.js
export class Clock {
  constructor({ loopDuration = 10 } = {}) {
    this.loopDuration = loopDuration
    this.elapsed = 0
    this.delta = 0
    this.frame = 0
    this.normalized = 0
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
      this.normalized = 0
      return
    }
    this.delta = (timeMs - this._lastTime) / 1000
    this.elapsed = (timeMs - this._startTime) / 1000
    this.normalized = (this.elapsed % this.loopDuration) / this.loopDuration
    this._lastTime = timeMs
    this.frame++
  }

  reset() {
    this.elapsed = 0
    this.delta = 0
    this.frame = 0
    this.normalized = 0
    this._lastTime = null
    this._startTime = null
  }
}
