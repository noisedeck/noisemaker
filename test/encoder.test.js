import assert from 'assert'
import { Context } from '../js/noisemaker/context.js'

const canvas = {}
const ctx = new Context(canvas, true)

assert.strictEqual(ctx.canvas, canvas)
assert.strictEqual(ctx.debug, true)
assert.strictEqual(ctx.withEncoder, undefined)
assert.strictEqual(ctx.runCompute, undefined)
assert.doesNotThrow(() => ctx.flush())
assert.doesNotThrow(() => ctx.destroy())

console.log('context tests passed')
