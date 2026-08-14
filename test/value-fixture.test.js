import assert from 'assert'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { valueNoise } from '../js/noisemaker/value.js'
import { setSeed } from '../js/noisemaker/util.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures', 'value', 'seed_1.json'), 'utf8'))

setSeed(1)
const result = Array.from(valueNoise(64))
assert.strictEqual(result.length, fixture.length)
for (let i = 0; i < result.length; i++) {
  assert.ok(Math.abs(result[i] - fixture[i]) < 1e-6, `index ${i}`)
}
console.log('value fixture parity ok')
