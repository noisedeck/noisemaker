/**
 * Resource Management Module
 * Handles Liveness Analysis and Texture Pooling (Register Allocation).
 */

/**
 * The two names an effect definition may use for the 2D pipeline colour input.
 * The expander treats them as one slot (see the `arg.kind === 'pipeline'` and
 * `defaultVal` branches of expander.js), so this module has to as well.
 */
const PIPELINE_COLOR_INPUTS = ['inputTex', 'inputColor']

/** A node's main 2D output, as the expander names it: `node_<step>_out`. */
const NODE_OUTPUT_PATTERN = /^node_\d+_out$/

/**
 * Every texture id some pass writes.
 * @param {Array} passes List of render passes
 * @returns {Set<string>} Written texture ids
 */
function collectWrittenTextures(passes) {
    const written = new Set()
    for (const pass of passes) {
        if (!pass.outputs) continue
        for (const texId of Object.values(pass.outputs)) {
            if (typeof texId === 'string') written.add(texId)
        }
    }
    return written
}

/**
 * The value flowing down the 2D chain into the pass at `index`: the main output
 * of the most recent pass that belongs to a different node.
 * @param {Array} passes List of render passes
 * @param {number} index Index of the reading pass
 * @param {string} nodeId Node id of the reading pass
 * @returns {string|null} Upstream texture id, or null when nothing precedes it
 */
function findUpstreamChainTexture(passes, index, nodeId) {
    const ownOutput = `${nodeId}_out`
    for (let i = index - 1; i >= 0; i--) {
        const outputs = passes[i].outputs
        if (!outputs) continue
        for (const texId of Object.values(outputs)) {
            if (typeof texId !== 'string') continue
            if (texId === ownOutput) continue
            if (NODE_OUTPUT_PATTERN.test(texId)) return texId
        }
    }
    return null
}

/**
 * Maps the expander's per-node input aliases back to the textures they read.
 *
 * When an effect declares a pipeline colour input under a name the expander's
 * input mapping does not bind (`inputColor`), the expander falls through to its
 * generic node-prefixed form and emits `node_1_inputColor` rather than the
 * upstream `node_0_out`. No pass ever writes that id, so without this map
 * liveness sees the upstream texture written and never read: its lifetime ends
 * where it starts, it is never released, and its slot is never reused.
 *
 * Only ids that are (a) scoped to the reading pass's own node, (b) named for
 * the 2D pipeline colour input, and (c) written by no pass are treated as
 * aliases. That excludes real node-local textures (which some pass writes) and
 * CPU-uploaded ones such as `node_3_overlayTex` or `imageTex_step_0`.
 * @param {Array} passes List of render passes
 * @returns {Map<string, string>} Map<aliasId, upstreamTextureId>
 */
function buildInputAliases(passes) {
    const aliases = new Map()
    const written = collectWrittenTextures(passes)

    for (let i = 0; i < passes.length; i++) {
        const pass = passes[i]
        if (!pass.inputs || !pass.nodeId) continue

        for (const texId of Object.values(pass.inputs)) {
            if (typeof texId !== 'string') continue
            if (written.has(texId) || aliases.has(texId)) continue
            if (!PIPELINE_COLOR_INPUTS.some(name => texId === `${pass.nodeId}_${name}`)) continue

            const upstream = findUpstreamChainTexture(passes, i, pass.nodeId)
            if (upstream) aliases.set(texId, upstream)
        }
    }

    return aliases
}

/**
 * Analyzes the lifetime of each virtual texture in the pass list.
 * @param {Array} passes List of render passes
 * @returns {Map} Map<virtualId, {start: number, end: number}>
 */
export function analyzeLiveness(passes) {
    const lifetime = new Map()
    const aliases = buildInputAliases(passes)

    const touch = (texId, index) => {
        if (!texId) return
        // Ignore globals for liveness analysis (they are infinite)
        if (texId.startsWith('global_')) return

        if (!lifetime.has(texId)) {
            lifetime.set(texId, { start: index, end: index })
        } else {
            const l = lifetime.get(texId)
            l.start = Math.min(l.start, index)
            l.end = Math.max(l.end, index)
        }
    }

    passes.forEach((pass, index) => {
        // Inputs are read at this index, through the texture they actually name
        if (pass.inputs) {
            Object.values(pass.inputs).forEach(tex => touch(aliases.get(tex) ?? tex, index))
        }
        // Outputs are written at this index
        if (pass.outputs) {
            Object.values(pass.outputs).forEach(tex => touch(tex, index))
        }
    })

    return lifetime
}

/**
 * Allocates physical texture slots to virtual textures based on liveness.
 * Implements a simple Linear Scan Register Allocation algorithm.
 * @param {Array} passes
 * @returns {Map} Map<virtualId, physicalId>
 */
export function allocateResources(passes) {
    const lifetime = analyzeLiveness(passes)
    const aliases = buildInputAliases(passes)
    const allocations = new Map()
    // freeList: Array of { id: string, availableAfter: number }
    const freeList = []
    let physicalCount = 0

    // We iterate through passes to simulate the timeline
    for (let i = 0; i < passes.length; i++) {
        const pass = passes[i]

        // 1. Allocate Outputs (Definitions)
        if (pass.outputs) {
            Object.values(pass.outputs).forEach(texId => {
                if (texId.startsWith('global_')) return // Globals are pre-allocated
                if (allocations.has(texId)) return

                // Try to find a free slot
                // A slot is free if it was released in a strictly previous pass (availableAfter < i)
                // Because we are currently AT step i, we can reuse anything that finished BEFORE i.
                const freeIdx = freeList.findIndex(item => item.availableAfter < i)

                if (freeIdx !== -1) {
                    // Reuse
                    const item = freeList.splice(freeIdx, 1)[0]
                    allocations.set(texId, item.id)
                } else {
                    // Allocate new
                    const id = `phys_${physicalCount++}`
                    allocations.set(texId, id)
                }
            })
        }

        // 2. Release Inputs (Last Uses)
        if (pass.inputs) {
            Object.values(pass.inputs).forEach(inputId => {
                // Same alias resolution liveness used, so a read through an
                // alias releases the texture the alias stands for.
                const texId = aliases.get(inputId) ?? inputId
                if (texId.startsWith('global_')) return

                const l = lifetime.get(texId)
                // If this pass is the END of the texture's life, release it.
                if (l && l.end === i) {
                    const physId = allocations.get(texId)
                    if (physId) {
                        // It becomes available AFTER this pass is done.
                        freeList.push({ id: physId, availableAfter: i })
                    }
                }
            })
        }
    }

    return allocations
}
