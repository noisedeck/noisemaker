/**
 * DSL Transform - Functions for transforming compiled programs.
 *
 * Provides utilities for modifying compiled DSL programs programmatically,
 * such as replacing effects within chains.
 */

import { isStarterOp } from './validator.js'
import { ops } from './ops.js'

/**
 * Deep clone a compiled program structure
 * @param {object} obj - Object to clone
 * @returns {object} Cloned object
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj
    }
    if (Array.isArray(obj)) {
        return obj.map(deepClone)
    }
    const cloned = {}
    for (const key of Object.keys(obj)) {
        cloned[key] = deepClone(obj[key])
    }
    return cloned
}

/**
 * Whether an op is a compiler-emitted builtin rather than a user effect.
 * The validator emits these with a leading underscore (_read, _write, _write3d,
 * _subchain_begin, ...); no registered effect op can start with one.
 * @param {string} op - Op name from a chain step
 * @returns {boolean} True if the op is a builtin chain node
 */
function isBuiltinOp(op) {
    return typeof op === 'string' && op.startsWith('_')
}

/**
 * Find a step in the compiled program by its temp index
 * @param {object} compiled - Compiled program from compile()
 * @param {number} stepIndex - The temp index of the step to find
 * @returns {object|null} { planIndex, chainIndex, step } or null if not found
 */
function findStepByIndex(compiled, stepIndex) {
    if (!compiled?.plans) return null

    for (let planIndex = 0; planIndex < compiled.plans.length; planIndex++) {
        const plan = compiled.plans[planIndex]
        if (!plan?.chain) continue

        for (let chainIndex = 0; chainIndex < plan.chain.length; chainIndex++) {
            const step = plan.chain[chainIndex]
            if (step.temp === stepIndex) {
                return { planIndex, chainIndex, step }
            }
        }
    }
    return null
}

/**
 * Check if an effect is a starter effect
 * @param {string} effectName - Effect name (may include namespace)
 * @param {Array<string>} searchOrder - Namespace search order
 * @returns {boolean} True if the effect is a starter
 */
function checkIsStarter(effectName, searchOrder = []) {
    // Direct check
    if (isStarterOp(effectName)) return true

    // Check with each namespace prefix if bare name
    if (!effectName.includes('.') && searchOrder.length > 0) {
        for (const ns of searchOrder) {
            if (isStarterOp(`${ns}.${effectName}`)) return true
        }
    }

    return false
}

/**
 * Get the effect spec for a given effect name
 * @param {string} effectName - Effect name (may include namespace)
 * @param {Array<string>} searchOrder - Namespace search order
 * @returns {object|null} Effect spec or null
 */
function getEffectSpec(effectName, searchOrder = []) {
    // Direct lookup
    if (ops[effectName]) return ops[effectName]

    // Try with namespace prefixes
    if (!effectName.includes('.') && searchOrder.length > 0) {
        for (const ns of searchOrder) {
            const namespacedName = `${ns}.${effectName}`
            if (ops[namespacedName]) return ops[namespacedName]
        }
    }

    return null
}

/**
 * Replace an effect at a specific step index in a compiled program.
 *
 * This function replaces an effect in a compiled DSL program with a new effect.
 * The replacement must be "like for like":
 * - Starting effects can only be replaced with other starting effects
 * - Non-starting effects can only be replaced with other non-starting effects
 *
 * @param {object} compiled - Compiled program from compile()
 * @param {number} stepIndex - The temp index of the step to replace
 * @param {string} newEffectName - The name of the replacement effect
 * @param {object} [newArgs={}] - Optional arguments for the replacement effect
 * @param {object} [options={}] - Options
 * @param {Array<string>} [options.searchOrder] - Namespace search order (defaults to compiled.searchNamespaces)
 * @returns {object} { success, program?, error? }
 *   - success: boolean indicating if replacement succeeded
 *   - program: the new compiled program (only if success)
 *   - error: error message (only if !success)
 */
export function replaceEffect(compiled, stepIndex, newEffectName, newArgs = {}, options = {}) {
    if (!compiled?.plans) {
        return { success: false, error: 'Invalid compiled program: missing plans' }
    }

    const searchOrder = options.searchOrder || compiled.searchNamespaces || []

    // Find the step to replace
    const location = findStepByIndex(compiled, stepIndex)
    if (!location) {
        return { success: false, error: `Step with index ${stepIndex} not found` }
    }

    const { planIndex, chainIndex, step } = location
    const oldEffectName = step.op

    // Builtin chain nodes (_write, _read, ...) are structural, not user effects.
    // Replacing one would corrupt the chain's output wiring.
    if (isBuiltinOp(oldEffectName)) {
        return {
            success: false,
            error: `Cannot replace builtin '${oldEffectName}': it is a structural chain node, not an effect.`
        }
    }

    // Also check position in chain - first effect in chain is "starter position"
    const isStarterPosition = chainIndex === 0

    // Check if new effect is a starter
    const newIsStarter = checkIsStarter(newEffectName, searchOrder)

    // Verify the new effect exists
    const newSpec = getEffectSpec(newEffectName, searchOrder)
    if (!newSpec) {
        return { success: false, error: `Effect '${newEffectName}' not found` }
    }

    // Enforce like-for-like replacement
    // If the step is in starter position (first in chain), new effect must be a starter
    // If the step is not in starter position, new effect must NOT be a starter
    if (isStarterPosition && !newIsStarter) {
        return {
            success: false,
            error: `Cannot replace starter effect '${oldEffectName}' with non-starter effect '${newEffectName}'. ` +
                   `The first effect in a chain must be a starting effect.`
        }
    }
    if (!isStarterPosition && newIsStarter) {
        return {
            success: false,
            error: `Cannot replace non-starter effect '${oldEffectName}' with starter effect '${newEffectName}'. ` +
                   `Starting effects can only appear at the beginning of a chain.`
        }
    }

    // Clone the program for immutability
    const newProgram = deepClone(compiled)

    // Build new args with defaults from effect spec
    const finalArgs = {}
    const specArgs = newSpec.args || []

    // First, set defaults for all params
    // Use def.name (DSL parameter name), NOT def.uniform (shader uniform name)
    for (const def of specArgs) {
        if (def.default !== undefined) {
            finalArgs[def.name] = def.default
        }
    }

    // Apply provided args (with rounding for floats - max 3 decimal places)
    for (const [key, value] of Object.entries(newArgs)) {
        if (typeof value === 'number' && !Number.isInteger(value)) {
            finalArgs[key] = Math.round(value * 1000) / 1000
        } else {
            finalArgs[key] = value
        }
    }

    // Get the resolved effect name (with namespace if needed)
    let resolvedNewName = newEffectName
    let effectNamespace = null

    if (newEffectName.includes('.')) {
        // Already namespaced - extract namespace
        const parts = newEffectName.split('.')
        effectNamespace = parts[0]
        // Verify it exists
        if (!ops[newEffectName]) {
            return { success: false, error: `Effect '${newEffectName}' not found` }
        }
    } else {
        // Try to find the namespaced version
        for (const ns of searchOrder) {
            const namespacedName = `${ns}.${newEffectName}`
            if (ops[namespacedName]) {
                resolvedNewName = namespacedName
                effectNamespace = ns
                break
            }
        }
        // If not found in search order, try all registered ops
        if (!effectNamespace) {
            for (const opName of Object.keys(ops)) {
                if (opName.endsWith(`.${newEffectName}`)) {
                    resolvedNewName = opName
                    effectNamespace = opName.split('.')[0]
                    break
                }
            }
        }
    }

    // Ensure the namespace is in searchNamespaces so unparser can strip it
    if (effectNamespace && !newProgram.searchNamespaces.includes(effectNamespace)) {
        newProgram.searchNamespaces = [...newProgram.searchNamespaces, effectNamespace]
    }

    // Update the step
    const newStep = newProgram.plans[planIndex].chain[chainIndex]
    newStep.op = resolvedNewName
    newStep.args = finalArgs

    // Update namespace info — reset to clean state for the new effect
    // This clears stale from() overrides from the old step
    newStep.namespace = effectNamespace
        ? { resolved: effectNamespace }
        : null

    return { success: true, program: newProgram }
}

/**
 * List all steps in a compiled program with their metadata.
 *
 * Useful for understanding the structure of a program before calling replaceEffect.
 *
 * Returns every member of `plan.chain`, including compiler-emitted builtins such
 * as the terminal `_write`. Use `kind` to tell them apart: builtins report
 * `kind: 'builtin'` and are never replaceable.
 *
 * @param {object} compiled - Compiled program from compile()
 * @param {object} [options={}] - Options
 * @param {Array<string>} [options.searchOrder] - Namespace search order
 * @returns {Array<object>} Array of step info objects
 */
export function listSteps(compiled, options = {}) {
    if (!compiled?.plans) return []

    const searchOrder = options.searchOrder || compiled.searchNamespaces || []
    const steps = []

    for (let planIndex = 0; planIndex < compiled.plans.length; planIndex++) {
        const plan = compiled.plans[planIndex]
        if (!plan?.chain) continue

        for (let chainIndex = 0; chainIndex < plan.chain.length; chainIndex++) {
            const step = plan.chain[chainIndex]
            const isStarterPosition = chainIndex === 0
            const isStarter = checkIsStarter(step.op, searchOrder)
            const builtin = isBuiltinOp(step.op)

            steps.push({
                stepIndex: step.temp,
                planIndex,
                chainIndex,
                effectName: step.op,
                kind: builtin ? 'builtin' : 'effect',
                isStarter,
                isStarterPosition,
                canReplaceWithStarter: !builtin && isStarterPosition,
                canReplaceWithNonStarter: !builtin && !isStarterPosition,
                args: step.args || {}
            })
        }
    }

    return steps
}

/**
 * Get compatible replacement effects for a given step.
 *
 * Returns a list of effect names that can legally replace the effect at the given step.
 *
 * @param {object} compiled - Compiled program from compile()
 * @param {number} stepIndex - The temp index of the step
 * @param {object} [options={}] - Options
 * @param {Array<string>} [options.searchOrder] - Namespace search order
 * @returns {object} { success, starters?, nonStarters?, error? }
 */
export function getCompatibleReplacements(compiled, stepIndex, options = {}) {
    if (!compiled?.plans) {
        return { success: false, error: 'Invalid compiled program: missing plans' }
    }

    const searchOrder = options.searchOrder || compiled.searchNamespaces || []

    const location = findStepByIndex(compiled, stepIndex)
    if (!location) {
        return { success: false, error: `Step with index ${stepIndex} not found` }
    }

    const { chainIndex, step } = location

    if (isBuiltinOp(step.op)) {
        return {
            success: false,
            error: `Cannot replace builtin '${step.op}': it is a structural chain node, not an effect.`
        }
    }

    const isStarterPosition = chainIndex === 0

    // Collect all registered ops
    const starters = []
    const nonStarters = []

    for (const opName of Object.keys(ops)) {
        const isStarter = checkIsStarter(opName, searchOrder)
        if (isStarter) {
            starters.push(opName)
        } else {
            nonStarters.push(opName)
        }
    }

    if (isStarterPosition) {
        return { success: true, compatible: starters, incompatible: nonStarters }
    } else {
        return { success: true, compatible: nonStarters, incompatible: starters }
    }
}
