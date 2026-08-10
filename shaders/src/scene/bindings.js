// shaders/src/scene/bindings.js
/**
 * Animation bindings: canonical osc() descriptors embedded in scene IR,
 * evaluated against the same normalized loop time as effect uniforms.
 *
 * collectBindings() replaces descriptors with their loop-start value, then
 * evaluateBindings() advances them using the built-in oscillator evaluator.
 */

import { evaluateOscillator } from '../runtime/pipeline.js'

const TRANSFORM_CHANNELS = ['position', 'rotation', 'scale']
const ROTATION_RANGE = Object.freeze({ min: 0, max: 360 })

function isOscillator(value) {
    return value !== null
        && typeof value === 'object'
        && value.type === 'Oscillator'
        && Number.isFinite(value.oscType)
}

function bindingValue(binding, normalizedTime) {
    const percentage = evaluateOscillator(binding.osc, normalizedTime)
    if (!binding.range) return percentage
    return binding.range.min + percentage * (binding.range.max - binding.range.min)
}

/**
 * Walk the tree's nodes and lights for oscillator descriptors, sanitize them
 * to their t=0 values in place, and return binding records.
 *
 * @param {SceneTree} tree - Tree built by SceneTree.fromIR
 * @returns {Array<{target, channel, index, osc}>}
 */
export function collectBindings(tree) {
    const bindings = []

    const scanNode = (node) => {
        for (const channel of TRANSFORM_CHANNELS) {
            const arr = node[`_${channel}`]
            if (!arr) continue
            for (let i = 0; i < arr.length; i++) {
                if (isOscillator(arr[i])) {
                    const osc = arr[i]
                    const binding = {
                        target: node,
                        channel,
                        index: i,
                        osc,
                        range: channel === 'rotation' ? ROTATION_RANGE : null
                    }
                    bindings.push(binding)
                    arr[i] = bindingValue(binding, 0)
                }
            }
        }
        for (const child of node.children) scanNode(child)
    }
    scanNode(tree.root)

    for (const light of tree.lights || []) {
        if (isOscillator(light.intensity)) {
            const osc = light.intensity
            const binding = { target: light, channel: 'intensity', index: null, osc, range: null }
            bindings.push(binding)
            light.intensity = bindingValue(binding, 0)
        }
    }

    return bindings
}

/**
 * Advance all bindings to time tSec. Mutates transform components in place
 * and marks nodes dirty directly — no per-frame allocation.
 *
 * @param {Array} bindings - From collectBindings
 * @param {number} normalizedTime - Shared animation loop position in [0, 1]
 */
export function evaluateBindings(bindings, normalizedTime) {
    for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i]
        const value = bindingValue(b, normalizedTime)
        if (b.channel === 'intensity') {
            b.target.intensity = value
        } else {
            b.target[`_${b.channel}`][b.index] = value
            b.target._markDirty()
        }
    }
}
