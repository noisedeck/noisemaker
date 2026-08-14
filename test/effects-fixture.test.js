import assert from 'assert'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { wormsParams } from '../js/noisemaker/effects.js'
import { setSeed } from '../js/noisemaker/util.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures', 'effects', 'worms.json'), 'utf8'))

setSeed(1)
const params = wormsParams([4, 4, 1])
for (const k of Object.keys(fixture)) {
  const arr = params[k]
  const exp = fixture[k]
  assert.strictEqual(arr.length, exp.length)
  for (let i = 0; i < arr.length; i++) {
    assert.ok(Math.abs(arr[i] - exp[i]) < 1e-6, `${k}[${i}]`)
  }
}
console.log('effects fixture parity ok')
