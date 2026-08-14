import assert from 'assert'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cloudPoints } from '../js/noisemaker/points.js'
import { setSeed } from '../js/noisemaker/util.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures', 'points', 'seed_1_freq4.json'), 'utf8'))

setSeed(1)
const [x, y] = cloudPoints(4)
assert.strictEqual(x.length, data.x.length)
for (let i = 0; i < x.length; i++) {
  assert.ok(Math.abs(x[i] - data.x[i]) < 1e-6)
  assert.ok(Math.abs(y[i] - data.y[i]) < 1e-6)
}
console.log('points fixture parity ok')
