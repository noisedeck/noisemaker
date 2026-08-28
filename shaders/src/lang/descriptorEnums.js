// shaders/src/lang/descriptorEnums.js
/**
 * How the enum argument of an animation descriptor resolves.
 *
 * osc(), midi() and audio() are canonicalized twice, by two modules that must
 * not disagree: lang/validator.js turns them into effect-uniform descriptors,
 * rendering/scene-compiler.js turns them into scene-transform descriptors. Each
 * had its own reading of `osc(type:)`, `midi(mode:)` and `audio(band:)`, and the
 * two drifted apart in both directions — the scene side honoured a bare number
 * and rejected a bare identifier, the 2D side honoured a bare identifier and
 * silently dropped a bare number. `audio(2)` meant band 2 in a scene transform
 * and band 0 in an effect uniform, from the same source text.
 *
 * The rule lives here so there is one of it. The TABLES each caller resolves
 * against stay with the caller: the validator's resolver also sees program
 * symbols and effect-registered enums, which a scene AST has no access to.
 */

import { stdEnums } from './std_enums.js'

/**
 * Unwrap whatever an enum table holds at a path into a plain number.
 * Enum members are stored as `{ type: 'Number', value }` nodes, but a resolver
 * that walked through program symbols may already have produced the number.
 * @param {*} resolved - Value from an enum resolver
 * @returns {number|undefined} The numeric value, or undefined if there is none
 */
function asEnumNumber(resolved) {
    if (typeof resolved === 'number') return resolved
    if (resolved && resolved.type === 'Number') return resolved.value
    if (resolved && resolved.type === 'Boolean') return resolved.value ? 1 : 0
    return undefined
}

/**
 * Walk a member path through the standard enum tables.
 *
 * The scene compiler's resolver: stdEnums only, since a scene AST reaches the
 * compiler with let-bindings already substituted and has no symbol table of its
 * own. The validator passes its own resolver instead.
 * @param {Array<string>} path - Member path, e.g. ['oscKind', 'saw']
 * @returns {*} The enum entry, or undefined
 */
export function resolveStdEnumPath(path) {
    if (!Array.isArray(path) || path.length === 0) return undefined
    let cur = stdEnums
    for (const part of path) {
        if (!cur || typeof cur !== 'object') return undefined
        if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined
        cur = cur[part]
    }
    return cur
}

/**
 * Resolve a descriptor's enum argument to its numeric value.
 *
 * Three spellings are accepted, and all three mean the same thing:
 *   audio(audioBand.high)   Member — the fully qualified enum member
 *   audio(high)             Ident  — the member name, qualified by `enumName`
 *   audio(2)                Number — the member's value, written out
 *
 * A bare number is passed through unchecked, which is what the validator
 * already does for every other enum-typed effect argument and what the scene
 * compiler already did here; the runtime evaluators all have a `default:` arm,
 * so an out-of-range number degrades to a defined value rather than a NaN.
 *
 * Returns undefined when the node names nothing resolvable. Callers decide what
 * that means: the scene compiler raises a positioned error, the 2D path keeps
 * the descriptor's default.
 *
 * @param {object|undefined} node - The argument's AST node
 * @param {string} enumName - Enum an unqualified Ident is resolved against
 * @param {(path: Array<string>) => *} [resolvePath] - Path resolver, defaults to stdEnums
 * @returns {number|undefined} The enum's numeric value, or undefined
 */
export function resolveDescriptorEnum(node, enumName, resolvePath = resolveStdEnumPath) {
    if (!node || typeof node !== 'object') return undefined
    if (node.type === 'Number') return node.value
    if (node.type === 'Member') return asEnumNumber(resolvePath(node.path))
    if (node.type === 'Ident') return asEnumNumber(resolvePath([enumName, node.name]))
    return undefined
}
