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

// Normalized time (looping)
{
  const clock = new Clock({ loopDuration: 10 })
  clock.tick(0)
  clock.tick(5000)
  approx(clock.normalized, 0.5)
  clock.tick(10000)
  approx(clock.normalized, 0.0)
}

console.log('Clock tests passed')
