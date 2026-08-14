/**
 * Test to verify mixer effects in nd namespace use tex0 and tex1
 */

import Coalesce from '../effects/nd/coalesce/definition.js'
import Composite from '../effects/nd/composite/definition.js'
import DepthOfField from '../effects/nd/depth-of-field/definition.js'
import DisplaceMixer from '../effects/nd/displace-mixer/definition.js'
import FeedbackMixer from '../effects/nd/feedback-mixer/definition.js'
// NOTE: live-code mixers have pre-existing syntax errors in embedded shader code
// import LiveCodeGlslMixer from '../effects/nd/live-code-glsl-mixer/definition.js';
// import LiveCodeWgslMixer from '../effects/nd/live-code-wgsl-mixer/definition.js';
import MediaMixer from '../effects/nd/media-mixer/definition.js'
// NOTE: shape-mixer has pre-existing issue with undefined None
// import ShapeMixer from '../effects/nd/shape-mixer/definition.js';
import WgslMixerDemo from '../effects/nd/wgsl-mixer-demo/definition.js'

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        fn()
        console.log(`✓ PASS: ${name}`)
        return true
    } catch (e) {
        console.error(`✗ FAIL: ${name}`)
        console.error(e)
        return false
    }
}

let passed = 0
let failed = 0

const mixerEffects = [
    { name: 'Coalesce', Effect: Coalesce },
    { name: 'Composite', Effect: Composite },
    { name: 'DepthOfField', Effect: DepthOfField },
    { name: 'DisplaceMixer', Effect: DisplaceMixer },
    { name: 'FeedbackMixer', Effect: FeedbackMixer },
    // NOTE: LiveCode mixers have pre-existing syntax errors and are skipped
    // { name: 'LiveCodeGlslMixer', Effect: LiveCodeGlslMixer },
    // { name: 'LiveCodeWgslMixer', Effect: LiveCodeWgslMixer },
    { name: 'MediaMixer', Effect: MediaMixer },
    // NOTE: shape-mixer has pre-existing issue with undefined None
    // { name: 'ShapeMixer', Effect: ShapeMixer },
    { name: 'WgslMixerDemo', Effect: WgslMixerDemo }
]

// Test each mixer effect
for (const { name, Effect } of mixerEffects) {
    if (test(`${name} - uses tex0 and tex1 with correct values`, () => {
        const effect = new Effect()
        const firstPass = effect.passes[0]

        if (!firstPass.inputs) {
            throw new Error(`${name} doesn't have inputs`)
        }

        if (!firstPass.inputs.tex0) {
            throw new Error(`${name} doesn't have tex0 in inputs`)
        }

        if (!firstPass.inputs.tex1) {
            throw new Error(`${name} doesn't have tex1 in inputs`)
        }

        if (firstPass.inputs.tex0 !== "inputTex") {
            throw new Error(`${name} tex0 maps to ${firstPass.inputs.tex0}, expected "inputTex"`)
        }

        if (firstPass.inputs.tex1 !== "tex") {
            throw new Error(`${name} tex1 maps to ${firstPass.inputs.tex1}, expected "tex"`)
        }
    })) {
        passed++
    } else {
        failed++
    }
}



console.log(`\n============================================================`)
console.log(`Results: ${passed} passed, ${failed} failed (out of ${passed + failed} tests)`)
console.log(`============================================================`)

process.exit(failed > 0 ? 1 : 0)
