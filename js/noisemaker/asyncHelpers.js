/**
 * Async utilities to make expensive CPU operations browser-friendly
 * by yielding control back to the main thread periodically.
 */

/**
 * Yields control back to the browser's main thread.
 * Uses scheduler.yield() if available (Chrome 115+), falls back to
 * requestIdleCallback, or setTimeout.
 *
 * @returns {Promise<void>}
 */
export async function yieldToMain() {
  return new Promise(resolve => {
    if (typeof scheduler !== 'undefined' && scheduler.yield) {
      scheduler.yield().then(resolve)
    } else if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => resolve(), { timeout: 16 })
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/**
 * Tracks when to yield based on elapsed time or iteration count.
 */
export class YieldController {
  constructor(options = {}) {
    this.yieldIntervalMs = options.yieldIntervalMs ?? 16 // ~60fps
    this.yieldEveryNOps = options.yieldEveryNOps ?? 100
    this.lastYieldTime = performance.now()
    this.opCount = 0
    this.enabled = options.enabled ?? true
    this.progressCallback = options.progressCallback ?? null
    this.totalSteps = options.totalSteps ?? 100
    this.currentStep = 0
  }

  /**
   * Check if we should yield, and yield if necessary.
   * @returns {Promise<void>}
   */
  async checkYield() {
    if (!this.enabled) {
      return
    }

    this.opCount++
    this.currentStep++
    const now = performance.now()
    const timeElapsed = now - this.lastYieldTime

    if (this.opCount >= this.yieldEveryNOps || timeElapsed >= this.yieldIntervalMs) {
      // Call progress callback if available
      if (this.progressCallback && this.totalSteps > 0) {
        const progress = Math.min(100, (this.currentStep / this.totalSteps) * 100)
        this.progressCallback(progress)
      }

      await yieldToMain()
      this.lastYieldTime = performance.now()
      this.opCount = 0
    }
  }

  /**
   * Reset the yield controller state
   */
  reset() {
    this.lastYieldTime = performance.now()
    this.opCount = 0
    this.currentStep = 0
  }

  /**
   * Set total steps for progress calculation
   */
  setTotalSteps(steps) {
    this.totalSteps = steps
    this.currentStep = 0
  }
}

/**
 * Wraps an async loop to yield periodically.
 *
 * @param {number} count - Number of iterations
 * @param {Function} callback - Async callback to run each iteration: (index) => Promise<void>
 * @param {YieldController} [controller] - Optional yield controller
 * @returns {Promise<void>}
 */
export async function asyncLoop(count, callback, controller = null) {
  const yieldCtrl = controller || new YieldController()
  for (let i = 0; i < count; i++) {
    await callback(i)
    await yieldCtrl.checkYield()
  }
}
