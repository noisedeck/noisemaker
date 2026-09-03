import assert from 'assert'
import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

const calls = []
const gl = {
  FLOAT_VEC2: 0x8B50,
  FLOAT_VEC3: 0x8B51,
  FLOAT_VEC4: 0x8B52,
  uniform2fv(_location, value) { calls.push(['vec2', Array.from(value)]) },
  uniform3fv(_location, value) { calls.push(['vec3', Array.from(value)]) },
  uniform4fv(_location, value) { calls.push(['vec4', Array.from(value)]) }
}

const backend = Object.create(WebGL2Backend.prototype)
backend._vec2Buf = new Float32Array(2)
backend._vec3Buf = new Float32Array(3)
backend._vec4Buf = new Float32Array(4)

backend._setUniform(gl, { location: 1, type: gl.FLOAT_VEC2 }, new Float32Array([2, 3]))
backend._setUniform(gl, { location: 2, type: gl.FLOAT_VEC3 }, new Float32Array([4, 5, 6]))
backend._setUniform(gl, { location: 3, type: gl.FLOAT_VEC4 }, new Float32Array([7, 8, 9, 10]))

assert.deepStrictEqual(calls, [
  ['vec2', [2, 3]],
  ['vec3', [4, 5, 6]],
  ['vec4', [7, 8, 9, 10]]
])

console.log('All WebGL uniform tests passed')
