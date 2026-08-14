/**
 * Test to verify inputTex convention is properly applied
 */

import ColorLab from '../effects/nd/color-lab/definition.js'
import ErosionWorms from '../effects/nd/erosion-worms/definition.js'
import Glitch from '../effects/nd/glitch/definition.js'
import Refract from '../effects/nd/refract/definition.js'

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

// Test 1: ColorLab effect uses inputTex
if (test("ColorLab - uses inputTex in inputs", () => {
    const colorLab = new ColorLab()
    const firstPass = colorLab.passes[0]
    if (!firstPass.inputs.inputTex) {
        throw new Error("ColorLab doesn't have inputTex in inputs")
    }
    if (firstPass.inputs.inputTex !== "inputTex") {
        throw new Error(`ColorLab inputTex maps to ${firstPass.inputs.inputTex}, expected "inputTex"`)
    }
})) {
    passed++
} else {
    failed++
}

// Test 2: Glitch effect uses inputTex
if (test("Glitch - uses inputTex in inputs", () => {
    const glitch = new Glitch()
    const firstPass = glitch.passes[0]
    if (!firstPass.inputs.inputTex) {
        throw new Error("Glitch doesn't have inputTex in inputs")
    }
    if (firstPass.inputs.inputTex !== "inputTex") {
        throw new Error(`Glitch inputTex maps to ${firstPass.inputs.inputTex}, expected "inputTex"`)
    }
})) {
    passed++
} else {
    failed++
}

// Test 3: Refract effect uses inputTex
if (test("Refract - uses inputTex in inputs", () => {
    const refract = new Refract()
    const firstPass = refract.passes[0]
    if (!firstPass.inputs.inputTex) {
        throw new Error("Refract doesn't have inputTex in inputs")
    }
    if (firstPass.inputs.inputTex !== "inputTex") {
        throw new Error(`Refract inputTex maps to ${firstPass.inputs.inputTex}, expected "inputTex"`)
    }
})) {
    passed++
} else {
    failed++
}

// Test 4: ErosionWorms has inputTex along with other inputs
if (test("ErosionWorms - uses inputTex with other inputs", () => {
    const erosionWorms = new ErosionWorms()
    const firstPass = erosionWorms.passes[0]
    if (!firstPass.inputs.inputTex) {
        throw new Error("ErosionWorms doesn't have inputTex in inputs")
    }
    if (firstPass.inputs.inputTex !== "inputTex") {
        throw new Error(`ErosionWorms inputTex maps to ${firstPass.inputs.inputTex}, expected "inputTex"`)
    }
    if (!firstPass.inputs.erosionTex) {
        throw new Error("ErosionWorms should still have erosionTex")
    }
})) {
    passed++
} else {
    failed++
}



console.log(`\n============================================================`)
console.log(`Results: ${passed} passed, ${failed} failed (out of ${passed + failed} tests)`)
console.log(`============================================================`)

process.exit(failed > 0 ? 1 : 0)
