// shaders/src/scene/bindings.js
/**
 * Animation bindings: canonical osc(), midi() and audio() descriptors embedded
 * in scene IR, evaluated against the same clock and the same external input
 * state as effect uniforms.
 *
 * collectBindings() replaces descriptors with their loop-start value, then
 * evaluateBindings() advances them. The evaluators are the pipeline's own —
 * imported, not reimplemented — so a descriptor written into a scene transform
 * behaves exactly as the same call written into an effect uniform.
 */

import { evaluateOscillator, evaluateMidi, evaluateAudio } from '../runtime/pipeline.js'
import { isAnimationDescriptor } from '../rendering/scene-compiler.js'

const TRANSFORM_CHANNELS = ['position', 'rotation', 'scale']
const ROTATION_RANGE = Object.freeze({ min: 0, max: 360 })

/**
 * Evaluate one binding to a percentage and map it onto the channel's range.
 *
 * `externalState` is the pipeline's own `{ midi, audio }` record. When it is
 * absent — no host input yet, or the loop-start sanitization pass — the
 * evaluators return the descriptor's own minimum, which is the same contract
 * the pipeline honours for an effect uniform with no MidiState/AudioState set.
 * There is no path here that yields NaN.
 */
function bindingValue(binding, normalizedTime, externalState, nowMs) {
    let percentage
    switch (binding.descriptor.type) {
        case 'Midi':
            percentage = evaluateMidi(binding.descriptor, externalState?.midi ?? null, nowMs)
            break
        case 'Audio':
            percentage = evaluateAudio(binding.descriptor, externalState?.audio ?? null)
            break
        default:
            percentage = evaluateOscillator(binding.descriptor, normalizedTime)
    }
    if (!binding.range) return percentage
    return binding.range.min + percentage * (binding.range.max - binding.range.min)
}

/**
 * Walk the tree's nodes and lights for animation descriptors, sanitize them to
 * their loop-start values in place, and return binding records.
 *
 * @param {SceneTree} tree - Tree built by SceneTree.fromIR
 * @returns {Array<{target, channel, index, descriptor, range}>}
 */
export function collectBindings(tree) {
    const bindings = []
    const now = Date.now()

    const scanNode = (node) => {
        for (const channel of TRANSFORM_CHANNELS) {
            const arr = node[`_${channel}`]
            if (!arr) continue
            for (let i = 0; i < arr.length; i++) {
                if (isAnimationDescriptor(arr[i])) {
                    const binding = {
                        target: node,
                        channel,
                        index: i,
                        descriptor: arr[i],
                        range: channel === 'rotation' ? ROTATION_RANGE : null
                    }
                    bindings.push(binding)
                    arr[i] = bindingValue(binding, 0, null, now)
                }
            }
        }
        for (const child of node.children) scanNode(child)
    }
    scanNode(tree.root)

    for (const light of tree.lights || []) {
        if (isAnimationDescriptor(light.intensity)) {
            const binding = {
                target: light,
                channel: 'intensity',
                index: null,
                descriptor: light.intensity,
                range: null
            }
            bindings.push(binding)
            light.intensity = bindingValue(binding, 0, null, now)
        }
    }

    return bindings
}

/**
 * Advance all bindings to the given loop position and external input state.
 * Mutates transform components in place and marks nodes dirty directly — no
 * per-frame allocation.
 *
 * @param {Array} bindings - From collectBindings
 * @param {number} normalizedTime - Shared animation loop position in [0, 1]
 * @param {{midi: ?object, audio: ?object}} [externalState] - The pipeline's
 *   externalState record, so scene bindings and effect uniforms read one
 *   MidiState and one AudioState. Omitted, midi/audio bindings hold at their
 *   descriptor minimum.
 */
export function evaluateBindings(bindings, normalizedTime, externalState = null) {
    // One timestamp for the whole frame: the pipeline reads Date.now() per
    // MIDI uniform, but a frame is a single instant and sharing it keeps every
    // trigger falloff in a scene consistent with itself.
    const now = Date.now()
    for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i]
        const value = bindingValue(b, normalizedTime, externalState, now)
        if (b.channel === 'intensity') {
            b.target.intensity = value
        } else {
            b.target[`_${b.channel}`][b.index] = value
            b.target._markDirty()
        }
    }
}
