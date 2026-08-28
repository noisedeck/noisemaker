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

import { resolveDescriptorEnum } from '../lang/descriptorEnums.js'

/** Texture the scene renderer presents into. */
export const SCENE_COLOR_TEXTURE = 'scene_color'

/** Primitives MeshRenderer._createPrimitive can build. */
const MESH_TYPES = new Set(['sphere', 'box', 'plane', 'cylinder', 'torus'])

/** Light types the deferred lighting pass understands. */
const LIGHT_TYPES = new Set(['directional', 'point', 'spot'])

/** Keyword args that describe placement rather than geometry. */
const TRANSFORM_KEYS = new Set(['id', 'pos', 'rot', 'scale'])

/** The only chain links a mesh/volume/group node accepts. */
const NODE_LINKS = new Set(['material', 'reflector'])

/** The eight global volume atlases the pipeline allocates. */
const VOLUME_REF = /^vol[0-7]$/

/**
 * Keywords each scene node accepts. Anything outside these is a typo: without
 * the check a mistyped keyword is dropped in silence and the node renders with
 * a default in its place.
 */
const CAMERA_KEYS = new Set(['fov', 'near', 'far', 'pos', 'target'])
const ENVIRONMENT_KEYS = new Set(['intensity'])
/**
 * volume() takes placement, the iso level and the marching mode. `threshold`
 * matches the range render3d's own uniform declares (0..1, default 0.5) so a
 * program moved from the marcher to the scene graph keeps its value.
 */
const VOLUME_KEYS = new Set(['id', 'pos', 'rot', 'scale', 'threshold', 'mode'])

/**
 * The two ways a volume() can be marched, mirroring render3d's two branches.
 *
 * `smooth` is its FILTERING == 0 path: trilinear sampling, a sign change in
 * `threshold - density` bracketed by bisection, and a central-difference
 * gradient for the normal. `voxel` is FILTERING == 1: a 3D-DDA walk of the
 * atlas grid that stops at the first cell whose density EXCEEDS the threshold
 * and takes the normal from the cell wall it entered through.
 *
 * A closed set with the members named in the diagnostic. Left open, `mode:
 * "blocky"` fell through to the default and rendered smooth without a word.
 */
const VOLUME_MODES = ['smooth', 'voxel']
const DEFAULT_VOLUME_MODE = 'smooth'
const SCENE_SETTING_KEYS = new Set([
    'ambient', 'background', 'exposure', 'ground', 'sky',
    'reflections', 'reflectionProbe', 'reflectionProbeSize',
    'ssao', 'ssaoRadius'
])
/** Light keywords, by light type — `angle`/`penumbra` are spot-only. */
const LIGHT_KEYS = {
    directional: new Set(['type', 'color', 'intensity', 'dir']),
    point: new Set(['type', 'color', 'intensity', 'pos', 'falloff']),
    spot: new Set(['type', 'color', 'intensity', 'pos', 'falloff', 'dir', 'angle', 'penumbra'])
}
/**
 * How each mesh shape parameter is validated. Unchecked, these reach the
 * geometry builders verbatim: `tube: 0` divides by zero and fills the buffer
 * with NaN, and `segments: 100000` asks for ~5e9 vertices on the main thread.
 */
const MESH_PARAM_SPEC = {
    radius: { kind: 'number', min: 1e-6, label: 'greater than zero' },
    tube: { kind: 'number', min: 1e-6, label: 'greater than zero' },
    width: { kind: 'number', min: 1e-6, label: 'greater than zero' },
    height: { kind: 'number', min: 1e-6, label: 'greater than zero' },
    segments: { kind: 'int', min: 3, max: 512, label: 'an integer between 3 and 512' },
    tubeSegments: { kind: 'int', min: 3, max: 512, label: 'an integer between 3 and 512' },
    size: { kind: 'vec3', label: 'a vec3 of finite numbers' }
}

/** Shape parameters per mesh type, mirroring geometry/primitives.js. */
const MESH_PARAM_KEYS = {
    sphere: new Set(['radius', 'segments']),
    box: new Set(['size']),
    plane: new Set(['width', 'height']),
    cylinder: new Set(['radius', 'height', 'segments']),
    torus: new Set(['radius', 'tube', 'segments', 'tubeSegments'])
}

function locOf(node) {
    const loc = node?.loc
    return { line: loc?.line ?? 0, col: loc?.col ?? 0 }
}

function sceneError(message, node) {
    const { line, col } = locOf(node)
    return new SyntaxError(`${message} at line ${line} col ${col}`)
}

/**
 * Reference nodes — VolRef, OutputRef, GeoRef, MeshRef and friends — carry no
 * `loc` of their own, so an error about one anchors to the enclosing call
 * rather than reporting line 0 col 0. Every error that anchors to a keyword's
 * VALUE, or to a bare positional, routes through here.
 */
function located(node, fallback) {
    return node?.loc ? node : fallback
}

/**
 * osc(), midi() and audio() are one feature with three sources, so they share
 * every rule: the same argument reader, the same enum resolution, the same
 * [0, 1] clamp on the min/max sub-range, and the same defaults the 2D uniform
 * path applies (see the Oscillator/Midi/Audio branches in lang/validator.js).
 * A midi() call must mean the same thing in a scene transform as in an effect
 * uniform, or the DSL has two dialects.
 */
const DESCRIPTOR_FUNCTION = Object.freeze({
    Oscillator: 'osc',
    Midi: 'midi',
    Audio: 'audio'
})

/** The canonical field each descriptor kind is identified by once compiled. */
const DESCRIPTOR_DISCRIMINANT = Object.freeze({
    Oscillator: 'oscType',
    Midi: 'channel',
    Audio: 'band'
})

/**
 * Is this compiled value one of the three animation descriptors?
 *
 * Shared with scene/bindings.js so the compiler and the per-frame evaluator
 * cannot disagree about what animates: a value the compiler let through but
 * bindings did not recognize would sit in a transform as an object and reach
 * the matrix math as NaN.
 *
 * @param {*} value - A value produced by litValue()
 * @returns {boolean}
 */
export function isAnimationDescriptor(value) {
    if (value === null || typeof value !== 'object') return false
    const discriminant = DESCRIPTOR_DISCRIMINANT[value.type]
    return discriminant !== undefined && Number.isFinite(value[discriminant])
}

function descriptorNumber(node, name, fallback, descriptorNode) {
    if (node === undefined) return fallback
    if (node?.type === 'Number') return node.value
    if (node?.type === 'Boolean') return node.value ? 1 : 0
    const fn = DESCRIPTOR_FUNCTION[descriptorNode.type]
    throw sceneError(`${fn}() ${name} must be a number`, descriptorNode)
}

/**
 * Resolve a descriptor's enum-valued argument (osc() type, midi() mode,
 * audio() band).
 *
 * The three accepted spellings — `oscKind.saw`, `saw`, `2` — are defined once,
 * in lang/descriptorEnums.js, and read from there by the effect-uniform path
 * too, so the same descriptor text cannot mean two things. What is local here
 * is the failure: a scene refuses a value it cannot resolve rather than
 * substituting a default, because a transform quietly falling back to
 * oscKind.sine moves geometry in a way nothing reports.
 */
function descriptorEnum(node, name, enumName, descriptorNode) {
    const resolved = resolveDescriptorEnum(node, enumName)
    if (resolved !== undefined) return resolved
    const fn = DESCRIPTOR_FUNCTION[descriptorNode.type]
    throw sceneError(`${fn}() ${name} must be a ${enumName} value`, descriptorNode)
}

const clampPercentage = value => Math.max(0, Math.min(1, value))

function canonicalOscillator(node) {
    return {
        type: 'Oscillator',
        oscType: descriptorEnum(node.oscType, 'type', 'oscKind', node),
        min: clampPercentage(descriptorNumber(node.min, 'min', 0, node)),
        max: clampPercentage(descriptorNumber(node.max, 'max', 1, node)),
        speed: descriptorNumber(node.speed, 'speed', 1, node),
        offset: descriptorNumber(node.offset, 'offset', 0, node),
        seed: descriptorNumber(node.seed, 'seed', 1, node)
    }
}

function canonicalMidi(node) {
    return {
        type: 'Midi',
        channel: descriptorNumber(node.channel, 'channel', 1, node),
        // The parser fills `mode` with midiMode.velocity when it is omitted;
        // the fallback here is the same mode by value, for a node built
        // without it.
        mode: node.mode === undefined ? 4 : descriptorEnum(node.mode, 'mode', 'midiMode', node),
        min: clampPercentage(descriptorNumber(node.min, 'min', 0, node)),
        max: clampPercentage(descriptorNumber(node.max, 'max', 1, node)),
        sensitivity: descriptorNumber(node.sensitivity, 'sensitivity', 1, node)
    }
}

function canonicalAudio(node) {
    return {
        type: 'Audio',
        band: node.band === undefined ? 0 : descriptorEnum(node.band, 'band', 'audioBand', node),
        min: clampPercentage(descriptorNumber(node.min, 'min', 0, node)),
        max: clampPercentage(descriptorNumber(node.max, 'max', 1, node))
    }
}

/**
 * Evaluate a value AST node to a plain JS value.
 * Canonical osc() nodes become the same descriptors used by effect uniforms.
 *
 * `anchor` is the nearest node known to carry a position; it is what a loc-less
 * value (a reference, an array element) reports against.
 */
function litValue(node, anchor) {
    if (node == null) return undefined
    const here = located(node, anchor)
    switch (node.type) {
        case 'Number':
        case 'String':
        case 'Boolean':
            return node.value
        case 'ArrayLiteral':
            return node.elements.map(element => litValue(element, here))
        case 'Oscillator':
            return canonicalOscillator(node)
        case 'Midi':
            return canonicalMidi(node)
        case 'Audio':
            return canonicalAudio(node)
        case 'Object': {
            const out = {}
            for (const [key, val] of Object.entries(node.properties)) {
                out[key] = litValue(val, here)
            }
            const impostor = DESCRIPTOR_FUNCTION[out.type]
            if (impostor) {
                throw sceneError(
                    `${out.type} object literals are invalid; use ${impostor}()`,
                    here
                )
            }
            return out
        }
        default:
            throw sceneError(`Unsupported scene value '${node.type}'`, here)
    }
}

/** Read a keyword arg off a call node, or undefined. */
function kw(call, name) {
    return litValue(call.kwargs?.[name], call)
}

function assertKnownKeywords(call, allowed) {
    for (const name of Object.keys(call.kwargs ?? {})) {
        if (!allowed.has(name)) {
            throw sceneError(
                `Unknown keyword '${name}' for ${call.name}()`,
                located(call.kwargs[name], call)
            )
        }
    }
}

function numberKw(call, name, fallback, { min = -Infinity, max = Infinity, rangeLabel = null } = {}) {
    const value = kw(call, name)
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw sceneError(`${name} must be a finite number`, located(call.kwargs?.[name], call))
    }
    if (value < min || value > max) {
        const requirement = rangeLabel ?? `between ${min} and ${max}`
        throw sceneError(`${name} must be ${requirement}`, located(call.kwargs?.[name], call))
    }
    return value
}

function vectorKw(call, name, fallback, length, { nonNegative = false } = {}) {
    const value = kw(call, name)
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.length !== length) {
        throw sceneError(`${name} must contain exactly ${length} values`, located(call.kwargs?.[name], call))
    }
    if (!value.every(component => typeof component === 'number' && Number.isFinite(component))) {
        throw sceneError(`${name} must contain finite numbers`, located(call.kwargs?.[name], call))
    }
    if (nonNegative && value.some(component => component < 0)) {
        throw sceneError(`${name} values must be non-negative`, located(call.kwargs?.[name], call))
    }
    return value
}

function validateMeshParam(name, value, node) {
    const spec = MESH_PARAM_SPEC[name]
    if (!spec) return value
    if (spec.kind === 'vec3') {
        if (!Array.isArray(value) || value.length !== 3 ||
            !value.every(c => typeof c === 'number' && Number.isFinite(c))) {
            throw sceneError(`${name} must be ${spec.label}`, node)
        }
        return value
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw sceneError(`${name} must be ${spec.label}`, node)
    }
    if (spec.kind === 'int' && !Number.isInteger(value)) {
        throw sceneError(`${name} must be ${spec.label}`, node)
    }
    if (value < (spec.min ?? -Infinity) || value > (spec.max ?? Infinity)) {
        throw sceneError(`${name} must be ${spec.label}`, node)
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

/** The camera a scene gets when it declares none. Every keyword defaults, so
 *  an absent camera() is not an error — it is this. */
const DEFAULT_CAMERA = Object.freeze({
    fov: 60, near: 0.1, far: 1000,
    position: Object.freeze([0, 0, 5]),
    target: Object.freeze([0, 0, 0])
})

function defaultCamera() {
    return {
        fov: DEFAULT_CAMERA.fov,
        near: DEFAULT_CAMERA.near,
        far: DEFAULT_CAMERA.far,
        position: [...DEFAULT_CAMERA.position],
        target: [...DEFAULT_CAMERA.target]
    }
}

function buildCamera(call) {
    assertKnownKeywords(call, CAMERA_KEYS)
    // Validated rather than read bare: an osc() descriptor or a wrong-arity
    // array used to travel all the way to the view matrix and turn it to NaN,
    // with nothing reporting why the scene had gone black.
    const near = numberKw(call, 'near', DEFAULT_CAMERA.near, { min: 1e-6, rangeLabel: 'greater than zero' })
    const far = numberKw(call, 'far', DEFAULT_CAMERA.far, { min: 1e-6, rangeLabel: 'greater than zero' })
    if (far <= near) {
        throw sceneError('far must be greater than near', located(call.kwargs?.far, call))
    }
    return {
        fov: numberKw(call, 'fov', DEFAULT_CAMERA.fov, { min: 1e-6, max: 179, rangeLabel: 'between 0 and 179 degrees' }),
        near,
        far,
        position: vectorKw(call, 'pos', DEFAULT_CAMERA.position, 3),
        target: vectorKw(call, 'target', DEFAULT_CAMERA.target, 3)
    }
}

function buildLight(call) {
    const type = kw(call, 'type') ?? 'directional'
    if (!LIGHT_TYPES.has(type)) {
        throw sceneError(`Unknown light type '${type}'`, located(call.kwargs?.type, call))
    }
    assertKnownKeywords(call, LIGHT_KEYS[type])
    // Vectors and scalars are validated here for the same reason as the camera:
    // an osc() descriptor read bare reached uniform3fv and NaN'd the light.
    // Intensity is the one channel bindings can animate, so it stays permissive
    // and is sanitized by collectBindings instead.
    const light = {
        type,
        color: vectorKw(call, 'color', [1, 1, 1], 3, { nonNegative: true }),
        intensity: kw(call, 'intensity') ?? 1
    }
    if (type === 'directional') {
        light.direction = vectorKw(call, 'dir', [0, -1, 0], 3)
    } else {
        light.position = vectorKw(call, 'pos', [0, 0, 0], 3)
        light.falloff = numberKw(call, 'falloff', 1, {
            min: 0,
            rangeLabel: 'non-negative'
        })
        if (type === 'spot') {
            light.direction = vectorKw(call, 'dir', [0, -1, 0], 3)
            light.angle = numberKw(call, 'angle', 45, { min: 0, max: 180, rangeLabel: 'between 0 and 180 degrees' })
            light.penumbra = numberKw(call, 'penumbra', 0.1, { min: 0, max: 1, rangeLabel: 'between 0 and 1' })
        }
    }
    return light
}

function buildEnvironment(call) {
    const arg = call.args?.[0]
    if (!arg || arg.type !== 'OutputRef') {
        throw sceneError('environment() expects a surface reference (o0..o7)', located(arg, call))
    }
    assertKnownKeywords(call, ENVIRONMENT_KEYS)
    return {
        surface: arg.name,
        intensity: kw(call, 'intensity') ?? 1
    }
}

/**
 * Read volume()'s positional argument: one of the eight global volume atlases.
 * The lexer accepts any `vol<digits>`, so the index is range-checked here for
 * the same reason read3d() checks it — `vol9` names no allocated surface.
 */
function volumeReference(call) {
    const args = call.args ?? []
    if (args.length > 1) {
        throw sceneError(
            'volume() takes one positional argument, the volume reference',
            located(args[1], call)
        )
    }
    const arg = args[0]
    if (!arg || arg.type !== 'VolRef' || !VOLUME_REF.test(arg.name)) {
        throw sceneError('volume() expects a volume reference (vol0..vol7)', located(arg, call))
    }
    return arg.name
}

/**
 * Read volume()'s `mode` keyword against the closed set of marching modes.
 *
 * Anchored at the keyword's VALUE (falling back to the call) for the same
 * reason every other volume diagnostic is: a value node without a `loc` would
 * otherwise report line 0 col 0. A non-string value is the same mistake as a
 * misspelled one and gets the same message — the set is what the author needs
 * to see, not the JavaScript type of what they wrote.
 */
function volumeMode(call) {
    const value = kw(call, 'mode')
    if (value === undefined) return DEFAULT_VOLUME_MODE
    if (typeof value !== 'string' || !VOLUME_MODES.includes(value)) {
        throw sceneError(
            `Unknown volume mode '${value}' (expected: ${VOLUME_MODES.join(', ')})`,
            located(call.kwargs?.mode, call)
        )
    }
    return value
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
            located(materialCall.args?.[0], materialCall)
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
                    throw sceneError('surface() expects a surface reference (o0..o7)', located(arg, link))
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
            throw sceneError(`${name} must contain exactly 3 values`, located(call.kwargs?.[name], call))
        }
        for (const component of value) {
            const number = typeof component === 'number' && Number.isFinite(component)
            if (!number && !isAnimationDescriptor(component)) {
                throw sceneError(
                    `${name} values must be finite numbers or osc(), midi() or audio()`,
                    located(call.kwargs?.[name], call)
                )
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
 * Flatten a mesh/volume/group child into the node array, returning its index.
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
    if (head.name !== 'mesh' && head.name !== 'group' && head.name !== 'volume') return null

    // group() takes only placement keywords; its positionals are its children.
    // Unchecked, a mistyped keyword was dropped in silence and the group
    // rendered at the origin with nothing reporting why.
    if (head.name === 'group') assertKnownKeywords(head, TRANSFORM_KEYS)

    // Links are filtered down to the two the scene graph understands, so
    // anything else used to be dropped without a word: `mesh("sphere")
    // .pos([0, 0, -4])` compiled clean and left the mesh at the origin.
    for (const link of links) {
        if (!NODE_LINKS.has(link.name)) {
            throw sceneError(
                `Unknown link '${link.name}()' on ${head.name}(); ` +
                `a scene node accepts only .material() and .reflector()`,
                located(link, head)
            )
        }
    }

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
        type: head.name,
        transform: buildTransform(head),
        children: [],
        parent: parentIndex
    }

    if (head.name === 'mesh') {
        // mesh() takes exactly one positional, the type. Anything after it was
        // read past and ignored, so `mesh("box", "sphere")` compiled clean.
        if ((head.args?.length ?? 0) > 1) {
            throw sceneError(
                'mesh() takes one positional argument, the mesh type',
                located(head.args[1], head)
            )
        }
        const meshType = litValue(head.args?.[0], head)
        if (!MESH_TYPES.has(meshType)) {
            throw sceneError(`Unknown mesh type '${meshType}'`, located(head.args?.[0], head))
        }
        node.meshType = meshType
        node.meshParams = {}
        const shapeKeys = MESH_PARAM_KEYS[meshType]
        for (const [key, val] of Object.entries(head.kwargs ?? {})) {
            if (TRANSFORM_KEYS.has(key)) continue
            const anchor = located(val, head)
            if (!shapeKeys.has(key)) {
                throw sceneError(`Unknown keyword '${key}' for mesh("${meshType}")`, anchor)
            }
            node.meshParams[key] = validateMeshParam(key, litValue(val, head), anchor)
        }
    }
    if (head.name === 'volume') {
        assertKnownKeywords(head, VOLUME_KEYS)
        node.surface = volumeReference(head)
        node.threshold = numberKw(head, 'threshold', 0.5, { min: 0, max: 1 })
        node.mode = volumeMode(head)
        // A raymarched isosurface has no UVs, so surface() has nothing to map
        // onto it. Rejecting here beats binding an albedo texture the volume
        // pass would silently ignore. An inherited material is rejected too,
        // and reported at the volume rather than at the group that declares it.
        if (material !== undefined && materials[material].albedoSurface !== undefined) {
            throw sceneError(
                'volume() cannot take a surface() material; an isosurface has no UVs',
                ownMaterial !== undefined ? materialLinks[0] : head
            )
        }
    }
    if (reflectorLinks.length === 1) {
        const reflector = reflectorLinks[0]
        if ((reflector.args?.length ?? 0) > 0 || Object.keys(reflector.kwargs ?? {}).length > 0) {
            throw sceneError('reflector() takes no arguments', reflector)
        }
        // Two distinct rejections. A volume or a group is not "not a plane" —
        // it is a node kind planar reflection does not apply to at all, and
        // naming the plane constraint there sent authors hunting for a mesh
        // keyword that was never the problem.
        if (head.name !== 'mesh') {
            throw sceneError(
                `reflector() is not supported on ${head.name}() nodes; ` +
                `planar reflection applies to a plane mesh`,
                located(reflector, head)
            )
        }
        if (node.meshType !== 'plane') {
            throw sceneError('reflector() requires a plane mesh', located(reflector, head))
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
const SCENE_CHILDREN = ['camera', 'light', 'environment', 'mesh', 'volume', 'group']

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
        if (!SCENE_SETTING_KEYS.has(key)) {
            throw sceneError(`Unknown keyword '${key}' for scene()`, located(val, sceneAst))
        }
        settings[key] = litValue(val, sceneAst)
    }
    const reflectionProbe = settings.reflectionProbe
    const reflectionProbeNode = located(sceneAst.kwargs?.reflectionProbe, sceneAst)
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
                located(sceneAst.kwargs?.reflectionProbeSize, sceneAst)
            )
        }
        const size = settings.reflectionProbeSize
        if (!Number.isInteger(size) || size < 16 || size > 512) {
            throw sceneError(
                'reflectionProbeSize must be an integer between 16 and 512',
                located(sceneAst.kwargs?.reflectionProbeSize, sceneAst)
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
            case 'volume':
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

    // A scene may legitimately declare no camera — every camera keyword has a
    // default, so the node as a whole is optional too. Filling it in here keeps
    // the renderer's contract simple: ir.camera is always present. Leaving it
    // null made mesh-renderer dereference it once per frame, which surfaced as
    // a black canvas and a console.error inside the render loop.
    if (!ir.camera) ir.camera = defaultCamera()

    return ir
}
