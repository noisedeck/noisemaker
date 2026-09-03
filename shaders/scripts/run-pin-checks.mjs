#!/usr/bin/env node
/**
 * Run every pin case in shaders/tests/pin-cases/ against its committed
 * baseline in shaders/tests/pin-baselines/.
 *
 * A pin compares an effect's rendered output on each backend against that
 * backend's own prior self — never cross-backend (the two readbacks return
 * opposite row orders; cross-backend identity is the parity attestations'
 * job). This is the regression gate for the legacy volumetric renderers,
 * including the voxel branch the one-case-per-effect attestation schema
 * cannot exercise.
 *
 * Needs a real GPU and system Chrome, like test:shaders:visual. Re-baseline
 * deliberately with:
 *   node shaders/scripts/pin-effect-pixels.mjs --case <case> --out <baseline>
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const caseDir = path.resolve(here, '../tests/pin-cases')
const baselineDir = path.resolve(here, '../tests/pin-baselines')
const tool = path.resolve(here, 'pin-effect-pixels.mjs')

let failed = 0
for (const file of readdirSync(caseDir).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '')
    const baseline = path.join(baselineDir, `${name}.pin.json`)
    const result = spawnSync('node', [tool, '--case', path.join(caseDir, file), '--check', baseline], {
        stdio: 'inherit'
    })
    if (result.status !== 0) {
        console.error(`PIN CHECK FAILED: ${name}`)
        failed++
    }
}
console.log(failed === 0 ? `\nAll pin checks passed` : `\n${failed} pin check(s) failed`)
if (failed > 0) process.exit(1)
