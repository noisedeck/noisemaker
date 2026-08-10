// shaders/src/rendering/scene-compiler.js
/**
 * Scene compiler: validated DSL chain -> scene IR.
 *
 * The validator emits scene DSL calls as passthrough steps shaped
 * `{ op: '_scene.<name>', args: { _ast }, scene: true }`, preserving the
 * original AST. This module walks that AST and produces the IR consumed by
 * SceneTree.fromIR().
 *
 * The scene renders into SCENE_COLOR_TEXTURE rather than the canvas, so a
 * trailing .write(oN) blits it into the pipeline like any other source.
 */

import { stdEnums } from '../lang/std_enums.js'

/** Texture the scene renderer presents into. */
export const SCENE_COLOR_TEXTURE = 'scene_color'

/** Primitives MeshRenderer._createPrimitive can build. */
const MESH_TYPES = new Set(['sphere', 'box', 'plane', 'cylinder', 'torus'])

/** Light types the deferred lighting pass understands. */
const LIGHT_TYPES = new Set(['directional', 'point', 'spot'])

/** Keyword args that describe placement rather than geometry. */
const TRANSFORM_KEYS = new Set(['id', 'pos', 'rot', 'scale'])

function locOf(node) {
    const loc = node?.loc
    return { line: loc?.line ?? 0, col: loc?.col ?? 0 }
}

function sceneError(message, node) {
    const { line, col } = locOf(node)
    return new SyntaxError(`${message} at line ${line} col ${col}`)
}

function oscillatorNumber(node, name, fallback, oscillatorNode) {
    if (node === undefined) return fallback
    if (node?.type === 'Number') return node.value
    if (node?.type === 'Boolean') return node.value ? 1 : 0
    throw sceneError(`osc() ${name} must be a number`, oscillatorNode)
}

function oscillatorType(node, oscillatorNode) {
    if (node?.type === 'Number') return node.value
    if (node?.type === 'Member' && node.path?.length === 2) {
        const [enumName, memberName] = node.path
        const resolved = stdEnums[enumName]?.[memberName]
        if (resolved?.type === 'Number') return resolved.value
    }
    throw sceneError('osc() type must be an oscKind value', oscillatorNode)
}

function canonicalOscillator(node) {
    const clampPercentage = value => Math.max(0, Math.min(1, value))
    return {
        type: 'Oscillator',
        oscType: oscillatorType(node.oscType, node),
        min: clampPercentage(oscillatorNumber(node.min, 'min', 0, node)),
        max: clampPercentage(oscillatorNumber(node.max, 'max', 1, node)),
        speed: oscillatorNumber(node.speed, 'speed', 1, node),
        offset: oscillatorNumber(node.offset, 'offset', 0, node),
        seed: oscillatorNumber(node.seed, 'seed', 1, node)
    }
}

/**
 * Evaluate a value AST node to a plain JS value.
 * Canonical osc() nodes become the same descriptors used by effect uniforms.
 */
function litValue(node) {
    if (node == null) return undefined
    switch (node.type) {
        case 'Number':
        case 'String':
        case 'Boolean':
            return node.value
        case 'ArrayLiteral':
            return node.elements.map(litValue)
        case 'Oscillator':
            return canonicalOscillator(node)
        case 'Object': {
            const out = {}
            for (const [key, val] of Object.entries(node.properties)) {
                out[key] = litValue(val)
            }
            if (out.type === 'Oscillator') {
                throw sceneError('Oscillator object literals are invalid; use osc()', node)
            }
            return out
        }
        default:
            throw sceneError(`Unsupported scene value '${node.type}'`, node)
    }
}

/** Read a keyword arg off a call node, or undefined. */
function kw(call, name) {
    return litValue(call.kwargs?.[name])
}

function assertKnownKeywords(call, allowed) {
    for (const name of Object.keys(call.kwargs ?? {})) {
        if (!allowed.has(name)) {
            throw sceneError(`Unknown keyword '${name}' for ${call.name}()`, call.kwargs[name])
        }
    }
}

function numberKw(call, name, fallback, { min = -Infinity, max = Infinity, rangeLabel = null } = {}) {
    const value = kw(call, name)
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw sceneError(`${name} must be a finite number`, call.kwargs?.[name] ?? call)
    }
    if (value < min || value > max) {
        const requirement = rangeLabel ?? `between ${min} and ${max}`
        throw sceneError(`${name} must be ${requirement}`, call.kwargs?.[name] ?? call)
    }
    return value
}

function vectorKw(call, name, fallback, length, { nonNegative = false } = {}) {
    const value = kw(call, name)
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.length !== length) {
        throw sceneError(`${name} must contain exactly ${length} values`, call.kwargs?.[name] ?? call)
    }
    if (!value.every(component => typeof component === 'number' && Number.isFinite(component))) {
        throw sceneError(`${name} must contain finite numbers`, call.kwargs?.[name] ?? call)
    }
    if (nonNegative && value.some(component => component < 0)) {
        throw sceneError(`${name} values must be non-negative`, call.kwargs?.[name] ?? call)
    }
    return value
}

/**
 * A scene child is either a bare Call (`camera(...)`) or a Chain when methods
 * are attached (`mesh(...).material(...)`). Normalize both to
 * { head, links } where head is the first Call and links are the rest.
 */
function asCallChain(node) {
    if (!node) return null
    if (node.type === 'Call') return { head: node, links: [] }
    if (node.type === 'Chain' && Array.isArray(node.chain) && node.chain.length > 0) {
        return { head: node.chain[0], links: node.chain.slice(1) }
    }
    return null
}

function buildCamera(call) {
    return {
        fov: kw(call, 'fov') ?? 60,
        near: kw(call, 'near') ?? 0.1,
        far: kw(call, 'far') ?? 1000,
        position: kw(call, 'pos') ?? [0, 0, 5],
        target: kw(call, 'target') ?? [0, 0, 0]
    }
}

function buildLight(call) {
    const type = kw(call, 'type') ?? 'directional'
    if (!LIGHT_TYPES.has(type)) {
        throw sceneError(`Unknown light type '${type}'`, call.kwargs?.type ?? call)
    }
    const light = {
        type,
        color: kw(call, 'color') ?? [1, 1, 1],
        intensity: kw(call, 'intensity') ?? 1
    }
    if (type === 'directional') {
        light.direction = kw(call, 'dir') ?? [0, -1, 0]
    } else {
        light.position = kw(call, 'pos') ?? [0, 0, 0]
        light.falloff = numberKw(call, 'falloff', 1, {
            min: 0,
            rangeLabel: 'non-negative'
        })
        if (type === 'spot') {
            light.direction = kw(call, 'dir') ?? [0, -1, 0]
            light.angle = kw(call, 'angle') ?? 45
            light.penumbra = kw(call, 'penumbra') ?? 0.1
        }
    }
    return light
}

function buildEnvironment(call) {
    const arg = call.args?.[0]
    if (!arg || arg.type !== 'OutputRef') {
        throw sceneError('environment() expects a surface reference (o0..o7)', arg ?? call)
    }
    return {
        surface: arg.name,
        intensity: kw(call, 'intensity') ?? 1
    }
}

/**
 * Resolve an inline `.material(...)` link into a material record, interning it
 * under a generated key. Returns the key, or undefined when absent.
 */
function internMaterial(materialCall, materials) {
    const spec = asCallChain(materialCall.args?.[0])
    if (!spec) {
        throw sceneError(
            'material() expects one material source (solid() or surface())',
            materialCall.args?.[0] ?? materialCall
        )
    }

    const material = {
        baseColor: [1, 1, 1],
        uvScale: [1, 1],
        uvOffset: [0, 0],
        pbr: { metallic: 0, roughness: 1 },
        emission: 0
    }
    let sourceSeen = null

    for (const link of [spec.head, ...spec.links]) {
        if (link.name === 'solid' || link.name === 'surface') {
            if (sourceSeen) {
                throw sceneError(
                    `A material takes one material source; found '${sourceSeen}' and '${link.name}'`,
                    link
                )
            }
            sourceSeen = link.name
            if (link.name === 'solid') {
                assertKnownKeywords(link, new Set(['color']))
                material.baseColor = vectorKw(link, 'color', material.baseColor, 3, {
                    nonNegative: true
                })
            } else {
                assertKnownKeywords(link, new Set(['tint', 'uvScale', 'uvOffset']))
                const arg = link.args?.[0]
                if (!arg || arg.type !== 'OutputRef') {
                    throw sceneError('surface() expects a surface reference (o0..o7)', arg ?? link)
                }
                material.albedoSurface = arg.name
                material.baseColor = vectorKw(link, 'tint', material.baseColor, 3, {
                    nonNegative: true
                })
                material.uvScale = vectorKw(link, 'uvScale', material.uvScale, 2)
                material.uvOffset = vectorKw(link, 'uvOffset', material.uvOffset, 2)
            }
        } else if (link.name === 'pbr') {
            assertKnownKeywords(link, new Set(['metallic', 'roughness']))
            material.pbr.metallic = numberKw(link, 'metallic', material.pbr.metallic, {
                min: 0,
                max: 1
            })
            material.pbr.roughness = numberKw(link, 'roughness', material.pbr.roughness, {
                min: 0,
                max: 1
            })
        } else if (link.name === 'emit') {
            assertKnownKeywords(link, new Set(['strength']))
            material.emission = numberKw(link, 'strength', 1, {
                min: 0,
                rangeLabel: 'non-negative'
            })
        } else {
            throw sceneError(`Unknown material term '${link.name}'`, link)
        }
    }

    if (!sourceSeen) {
        throw sceneError(
            'material() expects one material source (solid() or surface())',
            spec.head
        )
    }

    const key = `mat_${Object.keys(materials).length}`
    materials[key] = material
    return key
}

function buildTransform(call) {
    const transform = {}
    const readVector = (name) => {
        const value = kw(call, name)
        if (value === undefined) return undefined
        if (!Array.isArray(value) || value.length !== 3) {
            throw sceneError(`${name} must contain exactly 3 values`, call.kwargs?.[name] ?? call)
        }
        for (const component of value) {
            const number = typeof component === 'number' && Number.isFinite(component)
            const oscillator = component?.type === 'Oscillator'
                && Number.isFinite(component.oscType)
            if (!number && !oscillator) {
                throw sceneError(`${name} values must be finite numbers or osc()`, call.kwargs?.[name] ?? call)
            }
        }
        return value
    }
    const position = readVector('pos')
    const rotation = readVector('rot')
    const scale = readVector('scale')
    if (position !== undefined) transform.position = position
    if (rotation !== undefined) transform.rotation = rotation
    if (scale !== undefined) transform.scale = scale
    return transform
}

/**
 * Flatten a mesh/group child into the node array, returning its index.
 * Nodes are pushed before recursing so parent indices stay stable.
 */
function walkNode(
    child,
    parentIndex,
    nodes,
    materials,
    inheritedMaterial = undefined,
    reflectorState = { seen: false }
) {
    const resolved = asCallChain(child)
    if (!resolved) return null

    const { head, links } = resolved
    if (head.name !== 'mesh' && head.name !== 'group') return null

    const materialLinks = links.filter(link => link.name === 'material')
    if (materialLinks.length > 1) {
        throw sceneError('A node accepts only one material()', materialLinks[1])
    }
    const ownMaterial = materialLinks[0]
        ? internMaterial(materialLinks[0], materials)
        : undefined
    const material = ownMaterial ?? inheritedMaterial
    const reflectorLinks = links.filter(link => link.name === 'reflector')
    if (reflectorLinks.length > 1 || (reflectorLinks.length === 1 && reflectorState.seen)) {
        throw sceneError('Only one reflector() is supported per scene', reflectorLinks.at(-1))
    }

    const node = {
        id: kw(head, 'id'),
        type: head.name === 'mesh' ? 'mesh' : 'group',
        transform: buildTransform(head),
        children: [],
        parent: parentIndex
    }

    if (head.name === 'mesh') {
        const meshType = litValue(head.args?.[0])
        if (!MESH_TYPES.has(meshType)) {
            throw sceneError(`Unknown mesh type '${meshType}'`, head.args?.[0] ?? head)
        }
        node.meshType = meshType
        node.meshParams = {}
        for (const [key, val] of Object.entries(head.kwargs ?? {})) {
            if (TRANSFORM_KEYS.has(key)) continue
            node.meshParams[key] = litValue(val)
        }
    }
    if (reflectorLinks.length === 1) {
        const reflector = reflectorLinks[0]
        if ((reflector.args?.length ?? 0) > 0 || Object.keys(reflector.kwargs ?? {}).length > 0) {
            throw sceneError('reflector() takes no arguments', reflector)
        }
        if (node.meshType !== 'plane') {
            throw sceneError('reflector() requires a plane mesh', reflector)
        }
        node.planarReflection = true
        reflectorState.seen = true
    }
    if (material !== undefined) node.material = material

    const index = nodes.length
    nodes.push(node)

    if (head.name === 'group') {
        for (const grandchild of head.args ?? []) {
            const childIndex = walkNode(
                grandchild,
                index,
                nodes,
                materials,
                material,
                reflectorState
            )
            if (childIndex !== null) node.children.push(childIndex)
        }
    }

    return index
}

/**
 * Compile a validated program into scene IR.
 * @param {object} compilationResult - Output of compile() from lang/index.js
 * @returns {object|null} Scene IR, or null when the program has no scene()
 */
const SCENE_CHILDREN = ['camera', 'light', 'environment', 'mesh', 'group']

export function compileScene(compilationResult) {
    const sceneSteps = []
    for (const plan of compilationResult?.plans ?? []) {
        for (const step of plan.chain ?? []) {
            if (step.op === '_scene.scene') {
                sceneSteps.push(step)
            }
        }
    }
    if (sceneSteps.length === 0) return null
    if (sceneSteps.length > 1) {
        throw sceneError(
            'Only one scene() per program is supported',
            sceneSteps[1].args?._ast
        )
    }
    const sceneAst = sceneSteps[0].args?._ast

    const settings = {}
    for (const [key, val] of Object.entries(sceneAst.kwargs ?? {})) {
        settings[key] = litValue(val)
    }
    const reflectionProbe = settings.reflectionProbe
    const reflectionProbeNode = sceneAst.kwargs?.reflectionProbe ?? sceneAst
    if (reflectionProbe !== undefined) {
        const validProbe = Array.isArray(reflectionProbe) &&
            reflectionProbe.length === 3 &&
            reflectionProbe.every(value => typeof value === 'number' && Number.isFinite(value))
        if (!validProbe) {
            throw sceneError('reflectionProbe must be a finite vec3', reflectionProbeNode)
        }
    }
    if (settings.reflectionProbeSize !== undefined) {
        if (reflectionProbe === undefined) {
            throw sceneError(
                'reflectionProbeSize requires reflectionProbe',
                sceneAst.kwargs?.reflectionProbeSize ?? sceneAst
            )
        }
        const size = settings.reflectionProbeSize
        if (!Number.isInteger(size) || size < 16 || size > 512) {
            throw sceneError(
                'reflectionProbeSize must be an integer between 16 and 512',
                sceneAst.kwargs?.reflectionProbeSize ?? sceneAst
            )
        }
    }

    const ir = {
        camera: null,
        lights: [],
        settings,
        materials: {},
        nodes: [],
        environment: null
    }
    const reflectorState = { seen: false }

    for (const child of sceneAst.args ?? []) {
        const resolved = asCallChain(child)
        if (!resolved) continue

        switch (resolved.head.name) {
            case 'camera':
                ir.camera = buildCamera(resolved.head)
                break
            case 'light':
                ir.lights.push(buildLight(resolved.head))
                break
            case 'environment':
                ir.environment = buildEnvironment(resolved.head)
                break
            case 'mesh':
            case 'group':
                walkNode(child, null, ir.nodes, ir.materials, undefined, reflectorState)
                break
            default:
                throw sceneError(
                    `Unknown scene child '${resolved.head.name}' (allowed: ${SCENE_CHILDREN.join(', ')})`,
                    resolved.head
                )
        }
    }

    return ir
}
