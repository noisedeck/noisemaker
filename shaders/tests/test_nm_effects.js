import { EffectHarness } from './harness_effect.js'
import AdjustContrast from '../effects/nm/adjust_contrast/definition.js'
import AdjustBrightness from '../effects/nm/adjust_brightness/definition.js'
import AdjustHue from '../effects/nm/adjust_hue/definition.js'
import AdjustSaturation from '../effects/nm/adjust_saturation/definition.js'
import Bloom from '../effects/nm/bloom/definition.js'
import Blur from '../effects/nm/blur/definition.js'
import Clouds from '../effects/nm/clouds/definition.js'
import Vignette from '../effects/nm/vignette/definition.js'
import Aberration from '../effects/nm/aberration/definition.js'
import Grain from '../effects/nm/grain/definition.js'
import Worms from '../effects/nm/worms/definition.js'

function testEffect(EffectClass, name) {
    console.log(`Testing ${name}...`)

    const harness = new EffectHarness(EffectClass)

    try {
        harness.validate()
    } catch (e) {
        console.error(`  Validation: FAIL - ${e.message}`)
        return false
    }

    try {
        harness.mount()
    } catch (e) {
        console.error(`  Mount: FAIL - ${e.message}`)
        return false
    }

    try {
        harness.update(0.1)
    } catch (e) {
        console.error(`  Update: FAIL - ${e.message}`)
        return false
    }

    console.log(`  ✓ ${name} passed`)
    return true
}

console.log('Testing NM Effects')
console.log('=' .repeat(60))

const effectsToTest = [
    [AdjustContrast, 'AdjustContrast'],
    [AdjustBrightness, 'AdjustBrightness'],
    [AdjustHue, 'AdjustHue'],
    [AdjustSaturation, 'AdjustSaturation'],
    [Bloom, 'Bloom'],
    [Blur, 'Blur'],
    [Clouds, 'Clouds'],
    [Vignette, 'Vignette'],
    [Aberration, 'Aberration'],
    [Grain, 'Grain'],
    [Worms, 'Worms (complex multi-pass)'],
]

let passed = 0
let failed = 0

for (const [EffectClass, name] of effectsToTest) {
    if (testEffect(EffectClass, name)) {
        passed++
    } else {
        failed++
    }
}

console.log('=' .repeat(60))
console.log(`Results: ${passed} passed, ${failed} failed (out of ${effectsToTest.length} tested)`)
console.log(`Note: ${68 - effectsToTest.length} effects not tested in this sample`)

if (failed > 0) {
    process.exit(1)
}
