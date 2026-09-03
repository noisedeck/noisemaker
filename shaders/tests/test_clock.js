// shaders/tests/test_clock.js
import assert from 'assert'
import { Clock } from '../src/scene/clock.js'

function approx(a, b, eps = 0.01) {
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
}

{
  const clock = new Clock()
  assert.strictEqual(clock.elapsed, 0)
  assert.strictEqual(clock.delta, 0)
  assert.strictEqual(clock.frame, 0)

  clock.tick(1000)
  assert.strictEqual(clock.frame, 1)
  assert.strictEqual(clock.delta, 0)

  clock.tick(1016)
  approx(clock.delta, 0.016)
  approx(clock.elapsed, 0.016)
  assert.strictEqual(clock.frame, 2)

  clock.tick(1033)
  approx(clock.delta, 0.017)
  assert.strictEqual(clock.frame, 3)
}

// Reset
{
  const clock = new Clock()
  clock.tick(1000)
  clock.tick(2000)
  clock.reset()
  assert.strictEqual(clock.elapsed, 0)
  assert.strictEqual(clock.frame, 0)
}

// delta never goes negative when the driving timestamp wraps. canvas.js
// render() feeds an already-wrapped loop position, so time steps backwards
// once per animation loop.
{
  const clock = new Clock()
  const loopMs = 10000
  let lastElapsed = null
  for (let i = 0; i < 25; i++) {
    clock.tick((i * 1500) % loopMs)
    assert.ok(clock.delta >= 0, `delta ${clock.delta} must never be negative`)
    lastElapsed = clock.elapsed
  }
  assert.ok(lastElapsed !== null)
}

// A single hard backwards jump reports zero delta, not a negative one.
{
  const clock = new Clock()
  clock.tick(9000)
  clock.tick(9500)
  approx(clock.delta, 0.5)
  clock.tick(0)
  assert.strictEqual(clock.delta, 0)
}

// Clock owns no loop duration. `normalized` was computed against a private
// default that disagreed with the canvas's own loop length, and nothing ever
// read it, so both are gone. Only elapsed/delta/frame are part of the contract.
{
  const clock = new Clock()
  assert.ok(!('normalized' in clock), 'Clock must not expose normalized')
  assert.ok(!('loopDuration' in clock), 'Clock must not own a loop duration')
  clock.tick(0)
  clock.tick(5000)
  approx(clock.elapsed, 5)
  clock.reset()
  assert.ok(!('normalized' in clock), 'reset must not resurrect normalized')
}

console.log('Clock tests passed')
