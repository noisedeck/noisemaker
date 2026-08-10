import diagnostics from './diagnostics.js'
import enums from './enums.js'
import { stdEnums } from './std_enums.js'
import { ops } from './ops.js'
import { normalizeMemberPath, pathStartsWith, applyEnumPrefix } from './enumPaths.js'
import { resolveParamAliases } from './paramAliases.js'
import { checkEffectAlias } from './effectAliases.js'

/**
 * STRICT ALLOWLIST FOR STRING PARAMETERS
 *
 * !! WARNING: DO NOT EXPAND THIS ALLOWLIST !!
 *
 * Format: "effect.param" where effect is the func name (e.g., "text.text")
 */
const ALLOWED_STRING_PARAMS = new Set([
    'text.text',     // Text content for text overlay effect
    'text.font',     // Font family for text overlay effect
    'text.justify',  // Text justification (left/center/right)
    // Named cut within the family ("Bold Italic", or "Argon Medium Italic" for
    // a family bundling several typefaces). Same category as text.font above:
    // the valid values are whatever the host's installed font bundle provides,
    // so this cannot be an enum or a choices map. It has to reach the DSL or
    // the unparser drops it and every recompile reverts the text to the
    // family's first cut.
    'text.style',
])

const stateSurfaces = new Set(['time','frame','mouse','resolution','seed','a'])
const stateValues = new Set(['time','frame','mouse','resolution','seed','a','u1','u2','u3','u4','s1','s2','b1','b2','a1','a2','deltaTime'])
const STARTER_OPS = new Set()

const SURFACE_PASSTHROUGH_CALLS = new Set(['read'])

/**
 * Scene DSL function names.
 * These are recognized as scene description primitives and pass through
 * the validator without requiring an ops registration. The scene compiler
 * (a later pipeline stage) is responsible for interpreting them.
 */
const SCENE_FUNCTIONS = new Set([
    'scene', 'camera', 'mesh', 'light', 'group',
    'material', 'solid', 'surface', 'pbr', 'emit',
    'environment'
])

const validatorHooks = {}

export function registerValidatorHook(name, hook) {
    if (typeof name === 'string' && typeof hook === 'function') {
        validatorHooks[name] = hook
    }
}

export function registerStarterOps(names = []) {
    if (!Array.isArray(names)) { return }
    names.forEach((name) => {
        if (typeof name === 'string' && name) {
            STARTER_OPS.add(name)
        }
    })
}

export function isStarterOp(name) {
    if (typeof name !== 'string') { return false }
    // Force particles to be non-starter (workaround for stale manifest/cache)
    if (name === 'particles' || name === 'render.particles') return false
    // Check exact name first
    if (STARTER_OPS.has(name)) {
        return true
    }
    // For namespaced names like nm.voronoi
    const parts = name.split('.')
    if (parts.length > 1) {
        const canonical = parts[parts.length - 1]
        // If the bare canonical is a starter, check if any namespaced version exists
        if (STARTER_OPS.has(canonical)) {
            // Look for any "X.canonical" in STARTER_OPS
            for (const op of STARTER_OPS) {
                if (op.endsWith('.' + canonical)) {
                    // A namespaced starter exists (e.g., basics.voronoi)
                    // Since our exact name (nm.voronoi) wasn't found, we're not a starter
                    return false
                }
            }
            // No namespaced version - bare name applies
            return true
        }
    }
    return false
}

export function clamp(value, min, max) {
    if (typeof min === 'number' && value < min) return min
    if (typeof max === 'number' && value > max) return max
    return value
}

function toBoolean(value) {
    return typeof value === 'number' ? value !== 0 : !!value
}

function toSurface(arg) {
    if (!arg) return null
    if (arg.type === 'OutputRef') return {kind:'output', name:arg.name}
    if (arg.type === 'SourceRef') return {kind:'source', name:arg.name}
    if (arg.type === 'XyzRef') return {kind:'xyz', name:arg.name}
    if (arg.type === 'VelRef') return {kind:'vel', name:arg.name}
    if (arg.type === 'RgbaRef') return {kind:'rgba', name:arg.name}
    if (arg.type === 'MeshRef') return {kind:'mesh', name:arg.name}
    if (arg.type === 'Ident' && arg.name === 'none') return {kind:'output', name:'none'}
    if (arg.type === 'Ident' && stateSurfaces.has(arg.name)) return {kind:'state', name:arg.name}
    return null
}

function callToSurface(node) {
    if (!node || typeof node !== 'object') { return null }
    if (node.type === 'Chain' && Array.isArray(node.chain) && node.chain.length === 1) {
        return callToSurface(node.chain[0])
    }
    if (node.type !== 'Call' || !SURFACE_PASSTHROUGH_CALLS.has(node.name)) { return null }
    let target = null
    if (Array.isArray(node.args) && node.args.length) {
        target = node.args[0]
    }
    if (!target && node.kwargs && typeof node.kwargs === 'object') {
        target = node.kwargs.tex
    }
    if (!target) { return null }
    return toSurface(target)
}

/**
 * Semantic validator producing a flattened chain with temporary surfaces
 * @param {object} ast
 * @returns {object} PlannedChain {chain, out, final, diagnostics}
 */
export function validate(ast) {
    const diagnosticsList = []
    function pushDiag(code, node, message = diagnostics[code].message) {
        // Enrich message with identifier/location context when available
        let enrichedMessage = message
        const identName = extractIdentifierName(node)
        // Only append identifier if not already in message
        if (identName && !message.includes(identName) && !message.includes("'")) {
            enrichedMessage = `${message}: '${identName}'`
        }
        // Add source location if available
        let location = null
        if (node?.loc) {
            location = { line: node.loc.line, column: node.loc.column }
        }
        diagnosticsList.push({
            code,
            message: enrichedMessage,
            severity: diagnostics[code].severity,
            nodeId: node?.id,
            ...(location && { location }),
            ...(identName && { identifier: identName })
        })
    }

    function extractIdentifierName(node) {
        if (!node) return null
        if (node.type === 'Ident') return node.name
        if (node.type === 'Member' && Array.isArray(node.path)) return node.path.join('.')
        if (node.type === 'Call') return node.name
        if (node.type === 'Func' && node.src) return `{${node.src.slice(0, 30)}${node.src.length > 30 ? '...' : ''}}`
        // Fallback: try to extract any name-like property
        if (node.name) return node.name
        if (node.value) return String(node.value)
        // Debug: show what we got
        return `[${node.type || 'unknown'}]`
    }
    const plans = []
    const render = ast.render ? ast.render.name : null
    let tempIndex = 0

    const programSearchOrder = ast.namespace?.searchOrder
    if (!programSearchOrder || programSearchOrder.length === 0) {
        throw new Error("Missing required 'search' directive. Every program must start with 'search <namespace>, ...' to specify namespace search order.")
    }

    const symbols = new Map()

    function resolveEnum(path) {
        if (!Array.isArray(path) || path.length === 0) return undefined
        let [head, ...rest] = path
        let cur
        if (symbols.has(head)) {
            cur = symbols.get(head)
            if (cur && (cur.type === 'Number' || cur.type === 'Boolean')) cur = cur.value
        } else if (Object.prototype.hasOwnProperty.call(enums, head)) {
            cur = enums[head]
        } else if (Object.prototype.hasOwnProperty.call(stdEnums, head)) {
            // Also check stdEnums for oscKind, oscType, palette, etc.
            cur = stdEnums[head]
        } else {
            return undefined
        }
        for (const part of rest) {
            if (cur && Object.prototype.hasOwnProperty.call(cur, part)) {
                cur = cur[part]
            } else {
                return undefined
            }
        }
        if (cur && (cur.type === 'Number' || cur.type === 'Boolean')) return cur.value
        return cur
    }

    function clone(node) {
        return node && typeof node === 'object' ? JSON.parse(JSON.stringify(node)) : node
    }

    function canResolveOpName(name) {
        // Check if a bare op name can resolve via the search order
        for (const ns of programSearchOrder) {
            if (ops[`${ns}.${name}`]) return true
        }
        return false
    }

    function resolveCall(call) {
        // console.log('Resolving call:', call.name, symbols.has(call.name));
        if (symbols.has(call.name)) {
            const val = symbols.get(call.name)
            // console.log('Found symbol:', val);
            if (val.type === 'Ident') {
                return {...call, name: val.name}
            }
            if (val.type === 'Call') {
                const mergedArgs = val.args ? val.args.slice() : []
                // Merge positional args: call-site args override stored args by index?
                // Actually, partial application usually appends?
                // "Positional Arguments: Appended to the stored arguments." (LANGUAGE.md)
                // My previous logic was: mergedArgs[i] = call.args[i] (Override/Overlay)

                // Let's fix this to APPEND.
                const callArgs = call.args || []
                for (let i = 0; i < callArgs.length; i++) {
                    mergedArgs.push(callArgs[i])
                }

                let mergedKw = val.kwargs ? {...val.kwargs} : undefined
                if (call.kwargs) {
                    mergedKw = mergedKw || {}
                    for (const [k, v] of Object.entries(call.kwargs)) mergedKw[k] = v
                }
                const merged = {type:'Call', name: val.name, args: mergedArgs}
                if (mergedKw) merged.kwargs = mergedKw
                if (call.namespace) {
                    merged.namespace = {...call.namespace}
                } else if (val.namespace) {
                    merged.namespace = {...val.namespace}
                }
                return merged
            }
        }
        return call
    }

    function firstChainCall(node) {
        if (!node || typeof node !== 'object') return null
        if (node.type === 'Call') return node
        if (node.type === 'Chain') {
            const head = node.chain && node.chain[0]
            return head && head.type === 'Call' ? head : null
        }
        return null
    }

    function getStarterInfo(node) {
        if (!node || typeof node !== 'object') return null
        if (node.type === 'Call') {
            // Build namespaced name if namespace exists
            let name = node.name
            if (node.namespace && node.namespace.resolved) {
                name = `${node.namespace.resolved}.${node.name}`
            }
            return isStarterOp(name) ? {call: node, index: 0} : null
        }
        if (node.type === 'Chain' && Array.isArray(node.chain)) {
            for (let i = 0; i < node.chain.length; i++) {
                const entry = node.chain[i]
                if (entry && entry.type === 'Call') {
                    let name = entry.name
                    if (entry.namespace && entry.namespace.resolved) {
                        name = `${entry.namespace.resolved}.${entry.name}`
                    }
                    if (isStarterOp(name)) {
                        return {call: entry, index: i}
                    }
                }
            }
        }
        return null
    }

    function isStarterChain(node) {
        if (!node || node.type !== 'Chain') return false
        const starter = getStarterInfo(node)
        return !!(starter && starter.index === 0)
    }

    function substitute(node) {
        if (!node) return node
        if (node.type === 'Ident' && symbols.has(node.name)) {
            const result = substitute(clone(symbols.get(node.name)))
            if (result && typeof result === 'object') {
                result._varRef = node.name
            }
            return result
        }
        if (node.type === 'Chain') {
            const mapped = node.chain.map(c => {
                const mappedArgs = c.args.map(a => substitute(a))
                let mappedCall = {type:'Call', name:c.name, args:mappedArgs}
                if (c.kwargs) {
                    const kw = {}
                    for (const [k,v] of Object.entries(c.kwargs)) kw[k] = substitute(v)
                    mappedCall.kwargs = kw
                }
                return resolveCall(mappedCall)
            })
            return {type:'Chain', chain:mapped}
        }
        if (node.type === 'Call') {
            const mappedArgs = node.args.map(a => substitute(a))
            let mappedCall = {type:'Call', name:node.name, args:mappedArgs}
            if (node.kwargs) {
                const kw = {}
                for (const [k,v] of Object.entries(node.kwargs)) kw[k] = substitute(v)
                mappedCall.kwargs = kw
            }
            return resolveCall(mappedCall)
        }
        if (node.type === 'ArrayLiteral') {
            return {
                ...node,
                elements: node.elements.map(element => substitute(element))
            }
        }
        if (node.type === 'Object') {
            const properties = {}
            for (const [key, value] of Object.entries(node.properties || {})) {
                properties[key] = substitute(value)
            }
            return { ...node, properties }
        }
        if (node.type === 'Oscillator') {
            return {
                ...node,
                oscType: substitute(node.oscType),
                min: substitute(node.min),
                max: substitute(node.max),
                speed: substitute(node.speed),
                offset: substitute(node.offset),
                seed: substitute(node.seed)
            }
        }
        return node
    }

    if (Array.isArray(ast.vars)) {
        for (const v of ast.vars) {
            const expr = substitute(clone(v.expr))
            if (expr && isStarterChain(expr)) {
                const head = firstChainCall(expr)
                if (head) pushDiag('S006', head)
            }
            if (expr == null || (expr.type === 'Ident' && (expr.name === 'null' || expr.name === 'undefined'))) {
                pushDiag('S004', v)
                continue
            }
            if (expr.type === 'Ident' && !symbols.has(expr.name) && !stateValues.has(expr.name) && !ops[expr.name] && !canResolveOpName(expr.name)) {
                pushDiag('S003', expr)
                continue
            }
            if (expr.type === 'Chain' && expr.chain.length === 1) {
                symbols.set(v.name, expr.chain[0])
            } else if (expr.type === 'Member') {
                const resolved = resolveEnum(expr.path)
                if (typeof resolved === 'number') {
                    symbols.set(v.name, {type:'Number', value: resolved})
                } else if (resolved !== undefined) {
                    symbols.set(v.name, resolved)
                } else {
                    symbols.set(v.name, expr)
                }
            } else {
                symbols.set(v.name, expr)
            }
        }
    }

    function evalExpr(node) {
        const expr = substitute(clone(node))
        if (expr && isStarterChain(expr)) {
            const head = firstChainCall(expr)
            if (head) pushDiag('S006', head)
        }
        if (expr && expr.type === 'Member') {
            const resolved = resolveEnum(expr.path)
            if (typeof resolved === 'number') return {type:'Number', value: resolved}
            if (resolved !== undefined) return resolved
        }
        return expr
    }

    function evalCondition(node) {
        const expr = evalExpr(node)
        if (!expr) return false
        if (expr.type === 'Number') return toBoolean(expr.value)
        if (expr.type === 'Boolean') return !!expr.value
        if (expr.type === 'Func') {
            try {
                const fn = new Function('state', `with(state){ return ${expr.src}; }`)
                return {fn: (state) => toBoolean(fn(state))}
            } catch {
                pushDiag('S001', expr, `Invalid function expression: '${expr.src?.slice(0, 50) || 'unknown'}'`)
                return false
            }
        }
        if (expr.type === 'Ident') {
            if (symbols.has(expr.name)) return evalCondition(symbols.get(expr.name))
            if (stateValues.has(expr.name)) {
                const key = expr.name
                return {fn:(state)=>toBoolean(state[key])}
            }
            pushDiag('S003', expr)
            return false
        }
        if (expr.type === 'Member') {
            const cur = resolveEnum(expr.path)
            if (typeof cur === 'number') return toBoolean(cur)
            if (cur !== undefined) return toBoolean(cur)
            pushDiag('S001', expr, `Unknown enum path: '${expr.path?.join('.') || 'unknown'}'`)
            return false
        }
        return false
    }

        function buildNamespaceSnapshot(callNamespace) {
            if (!callNamespace || typeof callNamespace !== 'object') { return null }
            const snapshot = {
                call: {
                    name: typeof callNamespace.name === 'string' ? callNamespace.name : null,
                    resolved: typeof callNamespace.resolved === 'string' ? callNamespace.resolved : null,
                    explicit: !!callNamespace.explicit,
                    source: typeof callNamespace.source === 'string' ? callNamespace.source : null
                }
            }
            if (Array.isArray(callNamespace.searchOrder)) {
                snapshot.call.searchOrder = Object.freeze(callNamespace.searchOrder.slice())
            }
            if (callNamespace.fromOverride) {
                snapshot.call.fromOverride = true
            }
            // Copy resolved as top-level for downstream consumers
            if (callNamespace.resolved) {
                snapshot.resolved = callNamespace.resolved
            }
            return Object.freeze(snapshot)
        }

    function compileChainStatement(stmt) {
        const chain = []

        // Check for S006: Starter chain missing write() or write3d()
        const chainNode = { type: 'Chain', chain: stmt.chain }
        const hasWrite = stmt.write || stmt.write3d
        if (!hasWrite && isStarterChain(chainNode)) {
             pushDiag('S006', stmt.chain[0])
        }

        // write or write3d target must be explicit
        if (!hasWrite) {
            pushDiag('S001', stmt.chain[0], 'Chain must have explicit write() or write3d() target')
            return null
        }
        const writeName = stmt.write ? stmt.write.name : null
        const write3dTarget = stmt.write3d ? {
            tex3d: { kind: 'vol', name: stmt.write3d.tex3d?.name || stmt.write3d.tex3d },
            geo: { kind: 'geo', name: stmt.write3d.geo?.name || stmt.write3d.geo }
        } : null
        const states = []

        function processChain(calls, input, options = {}) {
            const allowStarterless = options.allowStarterless === true
            let current = input
            for (const original of calls) {
                // Handle Read node (pipeline built-in for reading 2D surfaces)
                if (original.type === 'Read') {
                    // GUARD: read() is a STARTER NODE. It MUST NOT be chained inline.
                    // If current !== null, someone wrote .read() which is semantically invalid.
                    if (current !== null) {
                        pushDiag('S001', original, 'read() is a starter node and cannot be chained inline. Use standalone read() to start a new chain.')
                        continue
                    }
                    const surface = toSurface(original.surface)
                    if (!surface) {
                        pushDiag('S001', original, 'read() requires a valid surface reference')
                        continue
                    }
                    const idx = tempIndex++
                    const stepArgs = { tex: surface }
                    // Preserve _skip flag from parsed node
                    if (original._skip === true) {
                        stepArgs._skip = true
                    }
                    const step = {
                        op: '_read',
                        args: stepArgs,
                        from: null,
                        temp: idx,
                        builtin: true
                    }
                    if (original.leadingComments) { step.leadingComments = original.leadingComments }
                    chain.push(step)
                    current = idx
                    continue
                }

                // Handle Read3D node (pipeline built-in for reading 3D textures)
                // Two-arg form: read3d(vol0, geo0) - starter node
                // Single-arg form is handled in param resolution, not here
                if (original.type === 'Read3D' && original.geo) {
                    // GUARD: read3d() is a STARTER NODE. It MUST NOT be chained inline.
                    // If current !== null, someone wrote .read3d() which is semantically invalid.
                    if (current !== null) {
                        pushDiag('S001', original, 'read3d() is a starter node and cannot be chained inline. Use standalone read3d() to start a new chain.')
                        continue
                    }
                    // Preserve the type for VolRef/GeoRef vs plain Ident
                    const tex3d = original.tex3d?.name
                        ? {
                            kind: original.tex3d.type === 'VolRef' ? 'vol' : 'tex3d',
                            name: original.tex3d.name
                        }
                        : null
                    const geo = original.geo?.name
                        ? {
                            kind: original.geo.type === 'GeoRef' ? 'geo' : 'geo',
                            name: original.geo.name
                        }
                        : null
                    if (!tex3d || !geo) {
                        pushDiag('S001', original, 'read3d() as starter requires tex3d and geo references')
                        continue
                    }
                    const idx = tempIndex++
                    const stepArgs = { tex3d, geo }
                    // Preserve _skip flag from parsed node
                    if (original._skip === true) {
                        stepArgs._skip = true
                    }
                    const step = {
                        op: '_read3d',
                        args: stepArgs,
                        from: null,
                        temp: idx,
                        builtin: true
                    }
                    if (original.leadingComments) { step.leadingComments = original.leadingComments }
                    chain.push(step)
                    current = idx
                    continue
                }

                // Handle Write node (pipeline built-in for writing to surfaces - chainable)
                if (original.type === 'Write') {
                    const surface = toSurface(original.surface)
                    if (!surface) {
                        pushDiag('S001', original, 'write() requires a valid surface reference')
                        continue
                    }
                    if (current === null) {
                        pushDiag('S005', original, 'write() requires an input - cannot be first in chain')
                        continue
                    }
                    const idx = tempIndex++
                    const step = {
                        op: '_write',
                        args: { tex: surface },
                        from: current,
                        temp: idx,
                        builtin: true
                    }
                    if (original.leadingComments) { step.leadingComments = original.leadingComments }
                    chain.push(step)
                    current = idx
                    continue
                }

                // Handle Write3D node (pipeline built-in for writing 3D volumes and geometry - chainable)
                if (original.type === 'Write3D') {
                    const tex3d = original.tex3d?.name
                        ? {
                            kind: original.tex3d.type === 'VolRef' ? 'vol' : 'tex3d',
                            name: original.tex3d.name
                        }
                        : null
                    const geo = original.geo?.name
                        ? {
                            kind: original.geo.type === 'GeoRef' ? 'geo' : 'geo',
                            name: original.geo.name
                        }
                        : null
                    if (!tex3d || !geo) {
                        pushDiag('S001', original, 'write3d() requires tex3d and geo references')
                        continue
                    }
                    if (current === null) {
                        pushDiag('S005', original, 'write3d() requires an input - cannot be first in chain')
                        continue
                    }
                    const idx = tempIndex++
                    const step = {
                        op: '_write3d',
                        args: { tex3d, geo },
                        from: current,
                        temp: idx,
                        builtin: true
                    }
                    if (original.leadingComments) { step.leadingComments = original.leadingComments }
                    chain.push(step)
                    current = idx
                    continue
                }

                // Handle Subchain node (first-class grouping of contiguous effects)
                if (original.type === 'Subchain') {
                    if (current === null) {
                        pushDiag('S005', original, 'subchain() requires an input - cannot be first in chain')
                        continue
                    }
                    // Add subchain begin marker
                    const beginIdx = tempIndex++
                    const beginStep = {
                        op: '_subchain_begin',
                        args: {
                            name: original.name || null,
                            id: original.id || null
                        },
                        from: current,
                        temp: beginIdx,
                        builtin: true
                    }
                    if (original.leadingComments) { beginStep.leadingComments = original.leadingComments }
                    chain.push(beginStep)
                    current = beginIdx

                    // Process the subchain body by recursively calling processChain
                    // This reuses all the existing argument resolution and validation logic
                    current = processChain(original.body, current)

                    // Add subchain end marker
                    const endIdx = tempIndex++
                    const endStep = {
                        op: '_subchain_end',
                        args: {
                            name: original.name || null,
                            id: original.id || null
                        },
                        from: current,
                        temp: endIdx,
                        builtin: true
                    }
                    chain.push(endStep)
                    current = endIdx
                    continue
                }

                const call = resolveCall({...original})
                const effectiveNamespace = call.namespace || { searchOrder: programSearchOrder }
                let opName = null
                let spec = null

                const candidateNames = []
                if (call.namespace && call.namespace.resolved) {
                    candidateNames.push(`${call.namespace.resolved}.${call.name}`)
                }
                const searchOrder = effectiveNamespace.searchOrder
                if (Array.isArray(searchOrder)) {
                    for (const ns of searchOrder) {
                        candidateNames.push(`${ns}.${call.name}`)
                    }
                }
                for (const candidate of candidateNames) {
                    if (candidate && ops[candidate]) {
                        opName = candidate
                        spec = ops[candidate]
                        break
                    }
                }
                if (!spec) {
                    // Scene DSL functions pass through the validator without ops registration.
                    // The scene compiler processes them in a later pipeline stage.
                    if (SCENE_FUNCTIONS.has(call.name)) {
                        const sceneAst = substitute(clone(original))
                        const idx = tempIndex++
                        const step = {
                            op: `_scene.${call.name}`,
                            args: { _ast: sceneAst },
                            from: current,
                            temp: idx,
                            scene: true
                        }
                        if (original.leadingComments) { step.leadingComments = original.leadingComments }
                        chain.push(step)
                        current = idx
                        continue
                    }
                    pushDiag('S001', original, `Unknown effect: '${call.name}'`)
                    continue
                }
                // Check for deprecated effect aliases
                const effectAliasWarning = checkEffectAlias(opName)
                if (effectAliasWarning) {
                    pushDiag('S008', original, effectAliasWarning)
                }
                if (opName === 'prev') {
                    const idx = tempIndex++
                    const args = {tex:{kind:'output', name: writeName}}
                    const namespaceSnapshot = buildNamespaceSnapshot(call.namespace)
                    const step = {op: opName, args, from: current, temp: idx}
                    if (namespaceSnapshot) { step.namespace = namespaceSnapshot }
                    if (original.leadingComments) { step.leadingComments = original.leadingComments }
                    chain.push(step)
                    current = idx
                    continue
                }
                const isStarter = isStarterOp(opName)
                const starterlessRoot = current === null
                const allowPassthroughRoot = allowStarterless && SURFACE_PASSTHROUGH_CALLS.has(opName)
                if (starterlessRoot && !isStarter && !allowPassthroughRoot) {
                    pushDiag('S005', original)
                    continue
                }
                // Use the already-resolved isStarter, not getStarterInfo which uses the bare name
                const starterHasInput = !!(isStarter && current !== null)
                const fromInput = starterHasInput ? null : current
                if (starterHasInput) {
                    pushDiag('S005', original)
                }
                const args = {}
                // Sidecar map remembering the source form of each arg
                // (e.g. 'array' when the source was a literal `[…]`).
                // Stays null until something sets a form, so existing
                // programs add no new keys to the compiled step.
                let argSources = null
                const kw = call.kwargs
                // Resolve deprecated param aliases
                if (kw) {
                    const aliasWarnings = resolveParamAliases(opName, kw)
                    for (const w of aliasWarnings) {
                        pushDiag('S007', call, w)
                    }
                }
                const seen = new Set()
                const specArgs = spec.args || []
                for (let i = 0; i < specArgs.length; i++) {
                    const def = specArgs[i]
                    let node = kw && kw[def.name] !== undefined ? kw[def.name] : call.args[i]
                    node = substitute(node)
                    const argKey = def.name
                    if (!kw && node && node.type === 'Color' && def.type !== 'color' && def.name === 'r' && specArgs[i + 1]?.name === 'g' && specArgs[i + 2]?.name === 'b') {
                        const [r, g, b] = node.value
                        args[argKey] = r
                        const defG = specArgs[i + 1]
                        args[defG.name] = g
                        const defB = specArgs[i + 2]
                        args[defB.name] = b
                        i += 2
                        continue
                    }
                    if (kw && kw[def.name] !== undefined) seen.add(def.name)
                    // Array literal — additive input form. Only fires when
                    // the source contains a literal `[…]`. Existing programs
                    // can never produce ArrayLiteral nodes (the lexer only
                    // emits LBRACKET when the source has `[`), so this
                    // branch is invisible to every program written before
                    // the array literal feature shipped. No length/type
                    // gating: pass the elements through as a numeric array
                    // and let the runtime decide what's valid. The source
                    // form is recorded so the unparser can round-trip back
                    // to `[…]` instead of any other form.
                    if (node && node.type === 'ArrayLiteral') {
                        const value = []
                        for (const el of node.elements) {
                            if (el.type === 'Number') {
                                value.push(el.value)
                            } else {
                                pushDiag('S002', el, `Array element must be a number for '${def.name}' in ${call.name}()`)
                                value.push(0)
                            }
                        }
                        args[argKey] = value
                        argSources = argSources || {}
                        argSources[argKey] = 'array'
                        continue
                    }
                    if (def.type === 'surface') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for surface parameter '${def.name}'`)
                            args[argKey] = def.default ? toSurface({ type: 'Ident', name: def.default }) : null
                            continue
                        }
                        let surf = null
                        let invalidStarterChain = false
                        const starter = node ? getStarterInfo(node) : null
                    // Handle Read nodes (parser creates special Read type for read() calls)
                    if (node && node.type === 'Read' && node.surface) {
                        surf = toSurface(node.surface)
                    }
                    const inlineSurface = surf || callToSurface(node)
                    if (inlineSurface) {
                        surf = inlineSurface
                    } else if (node && node.type === 'Chain') {
                        const idx = processChain(node.chain, null, {allowStarterless: true})
                        if (idx !== null && idx !== undefined) {
                            surf = {kind:'temp', index: idx}
                        }
                    } else if (node && node.type === 'Call') {
                        const idx = processChain([node], null, {allowStarterless: true})
                        if (idx !== null && idx !== undefined) {
                            surf = {kind:'temp', index: idx}
                        }
                    } else if (starter) {
                        pushDiag('S005', starter.call)
                        invalidStarterChain = true
                    } else {
                        surf = toSurface(node)
                    }
                        if (!surf) {
                            if (invalidStarterChain) {
                                args[argKey] = surf
                                continue
                            }
                            // Only report error if there's no default to fall back to
                            if (!def.default) {
                                if (!node) {
                                    pushDiag('S001', call, `Missing required surface argument '${def.name}' for ${call.name}()`)
                                } else if (node.type === 'Ident' && !symbols.has(node.name)) {
                                    pushDiag('S003', node, `Undefined variable '${node.name}' for '${def.name}' in ${call.name}()`)
                                } else {
                                    const nodeName = node.name || node.path?.join('.') || node.value || node.type || 'invalid'
                                    pushDiag('S001', node, `Invalid surface reference '${nodeName}' for '${def.name}' in ${call.name}()`)
                                }
                            }
                            // Fall back to default surface when resolution fails
                            if (def.default) {
                                surf = toSurface({ type: 'Ident', name: def.default }) || { kind: 'pipeline', name: def.default }
                            }
                        }
                        args[argKey] = surf
                    } else if (def.type === 'color') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for color parameter '${def.name}'`)
                            args[argKey] = def.default
                            continue
                        }
                        let value
                        if (node && node.type === 'Color') {
                            // Keep hex colors as hex strings (e.g., "#ff0000")
                            value = node.hex || node.value
                        } else {
                            if (node && node.type && node.type !== 'Ident') {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}()`)
                            }
                            value = def.default
                        }
                        args[argKey] = value
                    } else if (def.type === 'vec3') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for vec3 parameter '${def.name}'`)
                            args[argKey] = def.default ? def.default.slice() : [0,0,0]
                            continue
                        }
                        let value
                        if (node && node.type === 'Call' && node.name === 'vec3' && node.args && node.args.length === 3) {
                            value = []
                            for (const arg of node.args) {
                                if (arg.type === 'Number') {
                                    value.push(arg.value)
                                } else {
                                    pushDiag('S002', arg, `Argument out of range for '${def.name}' in ${call.name}()`)
                                    value.push(0)
                                }
                            }
                        } else if (node && node.type === 'Color') {
                            value = node.value.slice(0, 3)
                        } else {
                            if (node && node.type && node.type !== 'Ident') {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}()`)
                            }
                            value = def.default ? def.default.slice() : [0,0,0]
                        }
                        args[argKey] = value
                    } else if (def.type === 'vec4') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for vec4 parameter '${def.name}'`)
                            args[argKey] = def.default ? def.default.slice() : [0,0,0,1]
                            continue
                        }
                        let value
                        if (node && node.type === 'Call' && node.name === 'vec4' && node.args && node.args.length === 4) {
                            value = []
                            for (const arg of node.args) {
                                if (arg.type === 'Number') {
                                    value.push(arg.value)
                                } else {
                                    pushDiag('S002', arg, `Argument out of range for '${def.name}' in ${call.name}()`)
                                    value.push(0)
                                }
                            }
                        } else if (node && node.type === 'Color') {
                            // Color nodes already have 4 components [r, g, b, a]
                            value = node.value.slice()
                        } else {
                            if (node && node.type && node.type !== 'Ident') {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}()`)
                            }
                            value = def.default ? def.default.slice() : [0,0,0,1]
                        }
                        args[argKey] = value
                    } else if (def.type === 'boolean') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for boolean parameter '${def.name}'`)
                            args[argKey] = def.default !== undefined ? !!def.default : false
                            continue
                        }
                        let value
                        if (node && node.type === 'Boolean') {
                            value = !!node.value
                        } else if (node && node.type === 'Number') {
                            value = node.value !== 0
                        } else if (node && node.type === 'Func') {
                            try {
                                const fn = new Function('state', `with(state){ return ${node.src}; }`)
                                value = {fn: (state) => !!fn(state)}
                            } catch {
                                pushDiag('S001', node, `Invalid function for '${def.name}': '${node.src?.slice(0, 50) || 'unknown'}'`)
                                value = def.default !== undefined ? !!def.default : false
                            }
                        } else if (node && node.type === 'Ident' && stateValues.has(node.name)) {
                            const key = node.name
                            value = {fn: (state) => !!state[key]}
                        } else {
                            if (node && node.type === 'Ident' && !stateValues.has(node.name)) {
                                pushDiag('S003', node)
                            } else if (node && node.type && node.type !== 'Ident') {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}()`)
                            }
                            value = def.default !== undefined ? !!def.default : false
                        }
                        args[argKey] = value
                    } else if (def.type === 'member') {
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for member/enum parameter '${def.name}'`)
                            args[argKey] = def.default
                            continue
                        }
                        const prefix = normalizeMemberPath(def.enumPath || def.enum)
                        let path = null
                        if (node && node.type === 'Member') {
                            path = normalizeMemberPath(node.path)
                        } else if (node && (node.type === 'Number' || node.type === 'Boolean')) {
                            args[argKey] = node.type === 'Boolean' ? (node.value ? 1 : 0) : node.value
                            continue
                        } else if (node && node.type === 'Ident' && stateValues.has(node.name)) {
                            const key = node.name
                            args[argKey] = {fn: (state) => state[key]}
                            continue
                        } else if (node && node.type === 'Ident') {
                            path = [node.name]
                        }
                        if (!path) {
                            path = normalizeMemberPath(def.default)
                        }
                        let resolved = path ? resolveEnum(path) : undefined
                        if (resolved && resolved.type === 'Number') { resolved = resolved.value }
                        if (resolved && resolved.type === 'Boolean') { resolved = resolved.value ? 1 : 0 }
                        if (typeof resolved !== 'number') {
                            path = applyEnumPrefix(path || [], prefix)
                            if (prefix && path && !pathStartsWith(path, prefix)) {
                                pushDiag('S001', node || call, `Invalid enum value for '${def.name}': expected path starting with '${prefix.join('.')}'`)
                                path = prefix.slice()
                            }
                            resolved = path ? resolveEnum(path) : undefined
                            if (resolved && resolved.type === 'Number') { resolved = resolved.value }
                            if (resolved && resolved.type === 'Boolean') { resolved = resolved.value ? 1 : 0 }
                        }
                        if (typeof resolved !== 'number') {
                            const fallback = normalizeMemberPath(def.default)
                            let fallbackValue = fallback ? resolveEnum(fallback) : undefined
                            if (fallbackValue && fallbackValue.type === 'Number') {
                                fallbackValue = fallbackValue.value
                            }
                            if (fallbackValue && fallbackValue.type === 'Boolean') {
                                fallbackValue = fallbackValue.value ? 1 : 0
                            }
                            if (typeof fallbackValue === 'number') {
                                resolved = fallbackValue
                            } else {
                                resolved = 0
                            }
                        }
                        args[argKey] = resolved
                        if (node && node.type === 'Member' && path) {
                            node.path = path.slice()
                        }
                    } else if (def.type === 'volume') {
                        // Volume reference parameter (vol0-vol7 or "none")
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for volume parameter '${def.name}'`)
                            args[argKey] = def.default ? { kind: 'vol', name: def.default } : null
                            continue
                        }
                        let value = null
                        // Handle Read3D nodes with single arg (read3d(vol0) for param use)
                        if (node && node.type === 'Read3D' && node.tex3d && !node.geo) {
                            const volName = node.tex3d.name
                            if (/^vol[0-7]$/.test(volName)) {
                                value = { kind: 'vol', name: volName }
                            } else {
                                pushDiag('S001', node, `Invalid volume reference '${volName}' in read3d() for '${def.name}' - expected vol0-vol7`)
                                value = def.default ? { kind: 'vol', name: def.default } : null
                            }
                        } else if (node && node.type === 'VolRef') {
                            value = { kind: 'vol', name: node.name }
                        } else if (node && node.type === 'Ident') {
                            if (node.name === 'none') {
                                value = { kind: 'vol', name: 'none' }
                            } else if (/^vol[0-7]$/.test(node.name)) {
                                value = { kind: 'vol', name: node.name }
                            } else {
                                pushDiag('S001', node, `Invalid volume reference '${node.name}' for '${def.name}' - expected vol0-vol7 or none`)
                                value = def.default ? { kind: 'vol', name: def.default } : null
                            }
                        } else if (!node && def.default) {
                            value = { kind: 'vol', name: def.default }
                        }
                        args[argKey] = value
                    } else if (def.type === 'geometry') {
                        // Geometry reference parameter (geo0-geo7 or "none")
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for geometry parameter '${def.name}'`)
                            args[argKey] = def.default ? { kind: 'geo', name: def.default } : null
                            continue
                        }
                        let value = null
                        // Handle Read3D nodes with single arg (read3d(geo0) for param use)
                        if (node && node.type === 'Read3D' && node.tex3d && !node.geo) {
                            const geoName = node.tex3d.name
                            if (/^geo[0-7]$/.test(geoName)) {
                                value = { kind: 'geo', name: geoName }
                            } else {
                                pushDiag('S001', node, `Invalid geometry reference '${geoName}' in read3d() for '${def.name}' - expected geo0-geo7`)
                                value = def.default ? { kind: 'geo', name: def.default } : null
                            }
                        } else if (node && node.type === 'GeoRef') {
                            value = { kind: 'geo', name: node.name }
                        } else if (node && node.type === 'Ident') {
                            if (node.name === 'none') {
                                value = { kind: 'geo', name: 'none' }
                            } else if (/^geo[0-7]$/.test(node.name)) {
                                value = { kind: 'geo', name: node.name }
                            } else {
                                pushDiag('S001', node, `Invalid geometry reference '${node.name}' for '${def.name}' - expected geo0-geo7 or none`)
                                value = def.default ? { kind: 'geo', name: def.default } : null
                            }
                        } else if (!node && def.default) {
                            value = { kind: 'geo', name: def.default }
                        }
                        args[argKey] = value
                    } else if (def.type === 'string') {
                        // STRICT STRING PARAMETER VALIDATION
                        // Extract func name from opName (e.g., "filter.text" -> "text")
                        const funcName = opName.includes('.') ? opName.split('.').pop() : opName
                        const allowlistKey = `${funcName}.${def.name}`

                        if (!ALLOWED_STRING_PARAMS.has(allowlistKey)) {
                            pushDiag('S001', node || original, `String parameter '${def.name}' on effect '${funcName}' is NOT in the allowed string params list. String params are strictly controlled - use enums or choices instead.`)
                            args[argKey] = def.default
                            continue
                        }

                        // String type parameters - only accept String AST nodes or use default
                        let value
                        if (node && node.type === 'String') {
                            value = node.value
                        } else if (node && node.type === 'Ident' && def.choices) {
                            // Allow bare identifiers if they match a choice key
                            if (def.choices[node.name] !== undefined) {
                                value = def.choices[node.name]
                            } else {
                                pushDiag('S001', node, `Invalid choice '${node.name}' for string parameter '${def.name}'`)
                                value = def.default
                            }
                        } else if (node) {
                            pushDiag('S001', node, `String parameter '${def.name}' requires a quoted string literal, got ${node.type}`)
                            value = def.default
                        } else {
                            value = def.default
                        }
                        args[argKey] = value
                    } else {
                        // Numeric types - REJECT String nodes
                        if (node && node.type === 'String') {
                            pushDiag('S001', node, `String literal not allowed for numeric parameter '${def.name}' - strings are only valid for type: "string" parameters`)
                            args[argKey] = def.default
                            continue
                        }
                        let value
                        if (node && (node.type === 'Number' || node.type === 'Boolean')) {
                            value = node.type === 'Boolean' ? (node.value ? 1 : 0) : node.value
                            const clamped = clamp(value, def.min, def.max)
                            if (clamped !== value) {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}() (got ${value}, clamped to ${clamped})`)
                            }
                            value = clamped
                            // Preserve variable reference marker for unparser round-trip
                            if (node._varRef) {
                                value = { _varRef: node._varRef, value }
                            }
                        } else if (node && node.type === 'Func') {
                            try {
                                const fn = new Function('state', `with(state){ return ${node.src}; }`)
                                value = {fn, min:def.min, max:def.max}
                            } catch {
                                pushDiag('S001', node, `Invalid function for '${def.name}': '${node.src?.slice(0, 50) || 'unknown'}'`)
                                value = def.default
                            }
                        } else if (node && node.type === 'Oscillator') {
                            // Oscillator node - resolve the oscType enum value and pass through
                            // The oscillator will be evaluated at runtime by the pipeline
                            const oscTypeNode = node.oscType
                            let oscTypeValue = 0
                            if (oscTypeNode && oscTypeNode.type === 'Member') {
                                const resolved = resolveEnum(oscTypeNode.path)
                                if (typeof resolved === 'number') {
                                    oscTypeValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    oscTypeValue = resolved.value
                                }
                            } else if (oscTypeNode && oscTypeNode.type === 'Ident') {
                                // Try resolving as oscKind.{name}
                                const resolved = resolveEnum(['oscKind', oscTypeNode.name])
                                if (typeof resolved === 'number') {
                                    oscTypeValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    oscTypeValue = resolved.value
                                }
                            }
                            // Resolve min, max, speed, offset, seed from the oscillator node
                            const resolveOscParam = (param) => {
                                if (!param) return undefined
                                if (param.type === 'Number') return param.value
                                if (param.type === 'Boolean') return param.value ? 1 : 0
                                if (param.type === 'Member') {
                                    const r = resolveEnum(param.path)
                                    if (typeof r === 'number') return r
                                    if (r && r.type === 'Number') return r.value
                                }
                                return undefined
                            }
                            value = {
                                type: 'Oscillator',
                                oscType: oscTypeValue,
                                min: Math.max(0, Math.min(1, resolveOscParam(node.min) ?? 0)),
                                max: Math.max(0, Math.min(1, resolveOscParam(node.max) ?? 1)),
                                speed: resolveOscParam(node.speed) ?? 1,
                                offset: resolveOscParam(node.offset) ?? 0,
                                seed: resolveOscParam(node.seed) ?? 1,
                                // Keep original AST for unparsing
                                _ast: node,
                                // Preserve variable reference marker for unparser round-trip
                                ...(node._varRef && { _varRef: node._varRef })
                            }
                        } else if (node && node.type === 'Midi') {
                            // MIDI node - resolve the mode enum value and pass through
                            // The MIDI value will be evaluated at runtime by the pipeline
                            const modeNode = node.mode
                            let modeValue = 4 // default: velocity
                            if (modeNode && modeNode.type === 'Member') {
                                const resolved = resolveEnum(modeNode.path)
                                if (typeof resolved === 'number') {
                                    modeValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    modeValue = resolved.value
                                }
                            } else if (modeNode && modeNode.type === 'Ident') {
                                // Try resolving as midiMode.{name}
                                const resolved = resolveEnum(['midiMode', modeNode.name])
                                if (typeof resolved === 'number') {
                                    modeValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    modeValue = resolved.value
                                }
                            }
                            // Resolve channel, min, max, sensitivity from the MIDI node
                            const resolveMidiParam = (param) => {
                                if (!param) return undefined
                                if (param.type === 'Number') return param.value
                                if (param.type === 'Boolean') return param.value ? 1 : 0
                                if (param.type === 'Member') {
                                    const r = resolveEnum(param.path)
                                    if (typeof r === 'number') return r
                                    if (r && r.type === 'Number') return r.value
                                }
                                return undefined
                            }
                            value = {
                                type: 'Midi',
                                channel: resolveMidiParam(node.channel) ?? 1,
                                mode: modeValue,
                                min: Math.max(0, Math.min(1, resolveMidiParam(node.min) ?? 0)),
                                max: Math.max(0, Math.min(1, resolveMidiParam(node.max) ?? 1)),
                                sensitivity: resolveMidiParam(node.sensitivity) ?? 1,
                                // Keep original AST for unparsing
                                _ast: node,
                                // Preserve variable reference marker for unparser round-trip
                                ...(node._varRef && { _varRef: node._varRef })
                            }
                        } else if (node && node.type === 'Audio') {
                            // Audio node - resolve the band enum value and pass through
                            // The audio value will be evaluated at runtime by the pipeline
                            const bandNode = node.band
                            let bandValue = 0 // default: low
                            if (bandNode && bandNode.type === 'Member') {
                                const resolved = resolveEnum(bandNode.path)
                                if (typeof resolved === 'number') {
                                    bandValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    bandValue = resolved.value
                                }
                            } else if (bandNode && bandNode.type === 'Ident') {
                                // Try resolving as audioBand.{name}
                                const resolved = resolveEnum(['audioBand', bandNode.name])
                                if (typeof resolved === 'number') {
                                    bandValue = resolved
                                } else if (resolved && resolved.type === 'Number') {
                                    bandValue = resolved.value
                                }
                            }
                            // Resolve min, max from the Audio node
                            const resolveAudioParam = (param) => {
                                if (!param) return undefined
                                if (param.type === 'Number') return param.value
                                if (param.type === 'Boolean') return param.value ? 1 : 0
                                if (param.type === 'Member') {
                                    const r = resolveEnum(param.path)
                                    if (typeof r === 'number') return r
                                    if (r && r.type === 'Number') return r.value
                                }
                                return undefined
                            }
                            value = {
                                type: 'Audio',
                                band: bandValue,
                                min: Math.max(0, Math.min(1, resolveAudioParam(node.min) ?? 0)),
                                max: Math.max(0, Math.min(1, resolveAudioParam(node.max) ?? 1)),
                                // Keep original AST for unparsing
                                _ast: node,
                                // Preserve variable reference marker for unparser round-trip
                                ...(node._varRef && { _varRef: node._varRef })
                            }
                        } else if (node && node.type === 'Member') {
                            const cur = resolveEnum(node.path)
                            if (typeof cur === 'number') {
                                value = clamp(cur, def.min, def.max)
                                if (value !== cur) {
                                    pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}() (got ${cur}, clamped to ${value})`)
                                }
                            } else if (typeof cur === 'boolean') {
                                const num = cur ? 1 : 0
                                value = clamp(num, def.min, def.max)
                                if (value !== num) {
                                    pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}() (got ${num}, clamped to ${value})`)
                                }
                            } else {
                                pushDiag('S001', node, `Cannot resolve enum value for '${def.name}': '${node?.path?.join('.') || node?.name || 'unknown'}'`)
                                value = def.default
                            }
                        } else if (node && node.type === 'Ident' && stateValues.has(node.name)) {
                            const key = node.name
                            value = {fn: (state) => state[key], min:def.min, max:def.max}
                        } else if (node && node.type === 'Ident' && def.enum) {
                            // Try to resolve bare identifier as enum value within the param's enum path
                            const prefix = normalizeMemberPath(def.enum)
                            const path = prefix ? prefix.concat([node.name]) : [node.name]
                            const resolved = resolveEnum(path)
                            if (typeof resolved === 'number') {
                                value = clamp(resolved, def.min, def.max)
                            } else if (resolved && resolved.type === 'Number') {
                                value = clamp(resolved.value, def.min, def.max)
                            } else {
                                pushDiag('S003', node)
                                value = def.default
                            }
                        } else if (node && node.type === 'Ident' && def.choices) {
                            // Try to resolve bare identifier against inline choices
                            const choiceVal = def.choices[node.name]
                            if (typeof choiceVal === 'number') {
                                value = clamp(choiceVal, def.min, def.max)
                            } else {
                                pushDiag('S003', node)
                                value = def.default
                            }
                        } else {
                            if (node && node.type === 'Ident' && !stateValues.has(node.name)) {
                                pushDiag('S003', node)
                            } else if (node && node.type && node.type !== 'Ident') {
                                pushDiag('S002', node, `Argument out of range for '${def.name}' in ${call.name}()`)
                            }
                            if (def.defaultFrom) {
                                // Look up the referenced arg by its DSL name (def.name), NOT uniform name
                                const ref = spec.args.find(d => d.name === def.defaultFrom)
                                const refKey = ref ? ref.name : def.defaultFrom
                                if (args[refKey] !== undefined) {
                                    value = args[refKey]
                                } else {
                                    value = def.default
                                }
                            } else {
                                value = def.default
                            }
                        }
                        args[argKey] = value
                    }
                }

                // Handle _skip meta-argument (skip this step in the pipeline)
                if (kw && kw._skip !== undefined) {
                    const skipNode = kw._skip
                    if (skipNode && skipNode.type === 'Boolean') {
                        args._skip = skipNode.value
                    } else {
                        args._skip = false
                    }
                    seen.add('_skip')
                }

                if (kw) {
                    for (const key of Object.keys(kw)) {
                        if (!seen.has(key)) {
                            pushDiag('S001', kw[key], `Unknown argument '${key}' for ${call.name}()`)
                        }
                    }
                }
                const hook = typeof call.name === 'string' ? validatorHooks[call.name] : null
                if (typeof hook === 'function') {
                    const starterInfo = getStarterInfo(original)
                    const hookResult = hook({
                        call,
                        originalCall: original,
                        args,
                        writeName,
                        from: fromInput,
                        allocateTemp: () => tempIndex++,
                        addStep: (step) => {
                            if (step && typeof step === 'object') {
                                chain.push(step)
                            }
                        },
                        addState: (state) => {
                            if (state && typeof state === 'object') {
                                states.push(state)
                            }
                        },
                        pushDiagnostic: pushDiag,
                        states,
                        starter: starterInfo
                    })
                    if (hookResult && hookResult.handled) {
                        if (hookResult.current !== undefined && hookResult.current !== null) {
                            current = hookResult.current
                        }
                        continue
                    }
                }
                const idx = tempIndex++
                const namespaceSnapshot = buildNamespaceSnapshot(call.namespace)
                const step = {op: opName, args, from: fromInput, temp: idx}
                if (namespaceSnapshot) { step.namespace = namespaceSnapshot }
                if (original.leadingComments) { step.leadingComments = original.leadingComments }
                // Preserve raw kwargs from original AST for automation UI extraction
                if (original.kwargs && Object.keys(original.kwargs).length > 0) {
                    step.rawKwargs = original.kwargs
                }
                // Sidecar source-form metadata for unparser round-trip.
                // Absent when no arg used a source-tagged input form, so
                // existing programs add no new fields to compiled output.
                if (argSources) { step.argSources = argSources }
                chain.push(step)
                current = idx
            }
            return current
        }

        const finalIndex = processChain(stmt.chain, null)
        let writeSurf = null
        if (stmt.write) {
            writeSurf = {kind:'output', name: stmt.write.name}
        }
        const plan = {chain, write: writeSurf, write3d: write3dTarget, final: finalIndex, states}
        // Preserve plan-level leading comments (from the statement)
        if (stmt.leadingComments) { plan.leadingComments = stmt.leadingComments }
        return plan
    }

    function compileBlock(body) {
        const result = []
        for (const s of body || []) {
            const compiled = compileStmt(s)
            if (compiled) result.push(compiled)
        }
        return result
    }

    function compileStmt(stmt) {
        if (stmt.type === 'IfStmt') {
            const cond = evalCondition(stmt.condition)
            const thenBranch = compileBlock(stmt.then)
            const elif = []
            for (const e of stmt.elif || []) {
                elif.push({cond: evalCondition(e.condition), then: compileBlock(e.then)})
            }
            const elseBranch = compileBlock(stmt.else)
            return {type:'Branch', cond, then: thenBranch, elif, else: elseBranch}
        }
        if (stmt.type === 'Break') {
            return {type:'Break'}
        }
        if (stmt.type === 'Continue') {
            return {type:'Continue'}
        }
        if (stmt.type === 'Return') {
            const node = {type:'Return'}
            if (stmt.value) node.value = evalExpr(stmt.value)
            return node
        }
        return compileChainStatement(stmt)
    }

    for (const stmt of ast.plans || []) {
        const compiled = compileStmt(stmt)
        if (compiled) plans.push(compiled)
    }

    // Include original variable declarations for unparsing
    const vars = ast.vars || []

    // Include search order for transform operations
    const searchNamespaces = programSearchOrder || []

    // Preserve trailing comments from program
    const result = {plans, diagnostics: diagnosticsList, render, vars, searchNamespaces}
    if (ast.trailingComments) { result.trailingComments = ast.trailingComments }
    return result
}
