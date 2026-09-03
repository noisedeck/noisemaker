import { vec3, mat4, quat } from 'gl-matrix'
import assert from 'assert'

const v = vec3.fromValues(1, 2, 3)
assert.strictEqual(v[0], 1)
assert.strictEqual(v[1], 2)
assert.strictEqual(v[2], 3)

const m = mat4.create()
assert.strictEqual(m.length, 16)
assert.strictEqual(m[0], 1) // identity diagonal

const q = quat.create()
assert.strictEqual(q[3], 1) // identity quaternion w=1

console.log('gl-matrix smoke tests passed')
