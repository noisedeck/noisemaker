/**
 * DSL Unparser - Converts AST back to source code.
 *
 * This module takes a parsed/validated AST and serializes it back to valid DSL source.
 * It preserves the semantic structure while regenerating the text representation.
 */

import { stdEnums } from './std_enums.js'
import { decodeJsonStringLiteralContent } from './stringLiterals.js'

/**
 * Map oscillator type number to oscKind enum name
 */
const oscKindNames = ['sine', 'tri', 'saw', 'sawInv', 'square', 'noise1d', 'noise2d']

/**
 * Map MIDI mode number to midiMode enum name
 */
const midiModeNames = ['noteChange', 'gateNote', 'gateVelocity', 'triggerNote', 'velocity']

/**
 * Map audio band number to audioBand enum name
 */
const audioBandNames = ['low', 'mid', 'high', 'vol', 'raw']

/**
 * Format an AST expression node back to DSL
            if (expr.oscType?.type === 'Ident') {
                typeName = expr.oscType.name;
            } else if (expr.oscType?.type === 'Member') {
                typeName = expr.oscType.path[expr.oscType.path.length - 1];
            }
            const parts = [`type: oscKind.${typeName}`];
            if (expr.min?.type === 'Number' && expr.min.value !== 0) {
                parts.push(`min: ${expr.min.value}`);
            }
            if (expr.max?.type === 'Number' && expr.max.value !== 1) {
                parts.push(`max: ${expr.max.value}`);
            }
            if (expr.speed?.type === 'Number' && expr.speed.value !== 1) {
                parts.push(`speed: ${expr.speed.value}`);
            }
            if (expr.offset?.type === 'Number' && expr.offset.value !== 0) {
                parts.push(`offset: ${expr.offset.value}`);
            }
            if (expr.seed?.type === 'Number' && expr.seed.value !== 1) {
                parts.push(`seed: ${expr.seed.value}`);
            }
            return `osc(${parts.join(', ')})`;
        }
        default:
            // Fallback for other expression types
            return String(expr);
    }
}

/**
 * Format an oscillator value for DSL output
 * @param {object} osc - Oscillator configuration object
 * @returns {string} DSL representation of the oscillator
 */
function formatOscillator(osc) {
    if (osc._ast?.type === 'Oscillator') {
        return formatLetExpr(osc._ast)
    }
    const typeName = oscKindNames[osc.oscType] || 'sine'
    const parts = [`type: oscKind.${typeName}`]

    // Only include non-default values
    if (osc.min !== 0) {
        parts.push(`min: ${osc.min}`)
    }
    if (osc.max !== 1) {
        parts.push(`max: ${osc.max}`)
    }
    if (osc.speed !== 1) {
        parts.push(`speed: ${osc.speed}`)
    }
    if (osc.offset !== 0) {
        parts.push(`offset: ${osc.offset}`)
    }
    if (osc.seed !== 1 && osc.oscType === 5) {  // Only include seed for noise type
        parts.push(`seed: ${osc.seed}`)
    }

    return `osc(${parts.join(', ')})`
}

/**
 * Format a MIDI value for DSL output
 * @param {object} midi - MIDI configuration object
 * @returns {string} DSL representation of the midi() call
 */
function formatMidi(midi) {
    if (midi._ast?.type === 'Midi') {
        return formatLetExpr(midi._ast)
    }
    const parts = [`channel: ${midi.channel}`]

    // Only include non-default values
    const modeName = midiModeNames[midi.mode] || 'velocity'
    if (modeName !== 'velocity') {
        parts.push(`mode: midiMode.${modeName}`)
    }
    if (midi.min !== 0) {
        parts.push(`min: ${midi.min}`)
    }
    if (midi.max !== 1) {
        parts.push(`max: ${midi.max}`)
    }
    if (midi.sensitivity !== 1) {
        parts.push(`sensitivity: ${midi.sensitivity}`)
    }
    if (typeof midi.name === 'string' && midi.name.length > 0) {
        parts.push(`name: ${JSON.stringify(midi.name)}`)
    }
    if (typeof midi.id === 'string' && midi.id.length > 0) {
        parts.push(`id: ${JSON.stringify(midi.id)}`)
    }

    return `midi(${parts.join(', ')})`
}

/**
 * Format an audio value for DSL output
 * @param {object} audio - Audio configuration object
 * @returns {string} DSL representation of the audio() call
 */
function formatAudio(audio) {
    if (audio._ast?.type === 'Audio') {
        return formatLetExpr(audio._ast)
    }
    const bandName = audioBandNames[audio.band] || 'low'
    const parts = [`band: audioBand.${bandName}`]

    // Only include non-default values
    if (audio.min !== 0) {
        parts.push(`min: ${audio.min}`)
    }
    if (audio.max !== 1) {
        parts.push(`max: ${audio.max}`)
    }
    if (Number.isInteger(audio.channel) && audio.channel >= 1) {
        parts.push(`channel: ${audio.channel}`)
    }
    if (typeof audio.name === 'string' && audio.name.length > 0) {
        parts.push(`name: ${JSON.stringify(audio.name)}`)
    }
    if (typeof audio.id === 'string' && audio.id.length > 0) {
        parts.push(`id: ${JSON.stringify(audio.id)}`)
    }

    return `audio(${parts.join(', ')})`
}

/**
 * Format an enum name - remove 'Enum' suffix if present
 * @param {string} name - Enum constant name
 * @returns {string} Cleaned name
 */
function formatEnumName(name) {
    if (name.endsWith('Enum')) {
        return name.slice(0, -4)
    }
    return name
}

/**
 * Format a finite number without rounding and without exponent notation,
 * which is not part of the DSL's numeric literal grammar.
 */
function formatLosslessNumber(value) {
    const text = String(value)
    if (!/[eE]/.test(text)) return text

    const [coefficient, exponentText] = text.toLowerCase().split('e')
    const exponent = Number(exponentText)
    const negative = coefficient.startsWith('-')
    const unsigned = negative ? coefficient.slice(1) : coefficient
    const [integerPart, fractionPart = ''] = unsigned.split('.')
    const digits = integerPart + fractionPart
    const decimalIndex = integerPart.length + exponent
    const sign = negative ? '-' : ''

    if (decimalIndex <= 0) {
        return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`
    }
    if (decimalIndex >= digits.length) {
        return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`
    }
    return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
}

/**
 * Format a value for DSL output
 * @param {any} value - The value to format
 * @param {object} spec - Optional parameter spec for type hints
 * @param {object} options - Optional options { customFormatter, enums }
 * @returns {string} Formatted string representation
 */
function formatValue(value, spec, options = {}, sourceForm) {
    const { customFormatter, enums = {} } = typeof options === 'function'
        ? { customFormatter: options } // Legacy: 3rd arg was customFormatter
        : options

    // Try custom formatter first if provided
    if (customFormatter) {
        const custom = customFormatter(value, spec)
        if (custom !== null && custom !== undefined) {
            return custom
        }
    }

    if (value === null || value === undefined) {
        return 'null'
    }

    const isLosslessVector = spec?.type === 'vec4'
        && spec?.ui?.format === 'vector'
        && (Array.isArray(value) || ArrayBuffer.isView(value))
        && value.length === 4
        && Array.from(value).every(Number.isFinite)
    if (isLosslessVector) {
        return `[${Array.from(value).map(formatLosslessNumber).join(', ')}]`
    }

    // Round-trip array literal source form: when the validator tagged an
    // arg as having come from a `[…]` source, emit it back as `[…]`.
    // Existing programs never tag args this way, so this branch is
    // invisible to every program written before the array-literal
    // feature. The `vecN(...)` and hex-color paths below are not
    // touched.
    if (sourceForm === 'array' && (Array.isArray(value) || ArrayBuffer.isView(value))) {
        const arr = Array.isArray(value) ? value : Array.from(value)
        return `[${arr.map(v => formatValue(v, null, options)).join(', ')}]`
    }

    // Handle variable reference marker - output just the variable name
    if (value && typeof value === 'object' && value._varRef) {
        return value._varRef
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
    }

    const type = spec?.type

    // Handle inline choices - look up enum name from numeric value
    if (spec?.choices && typeof value === 'number') {
        for (const [name, val] of Object.entries(spec.choices)) {
            if (name.endsWith(':')) continue // skip group labels
            if (val === value) {
                return formatEnumName(name)
            }
        }
    }

    // Handle global enum reference (e.g., spec.enum = "palette")
    if (spec?.enum && typeof value === 'number') {
        const enumPath = spec.enum
        const parts = enumPath.split('.')
        let node = enums
        for (const part of parts) {
            if (node && node[part]) {
                node = node[part]
            } else {
                node = null
                break
            }
        }
        if (node && typeof node === 'object') {
            for (const [name, val] of Object.entries(node)) {
                const numVal = (val && typeof val === 'object' && 'value' in val) ? val.value : val
                if (numVal === value) {
                    return name
                }
            }
        }
    }

    // Handle enum string values — strip namespace prefix (e.g., "oscType.sine" → "sine")
    if (spec?.enum && typeof value === 'string') {
        const prefix = spec.enum + '.'
        if (value.startsWith(prefix)) {
            return value.slice(prefix.length)
        }
    }

    // Handle surface type
    if (type === 'surface') {
        // Handle object surface references (e.g., {kind: 'output', name: 'o1'})
        if (value && typeof value === 'object' && value.name) {
            if (value.name === 'none') {
                return 'none'
            }
            return `read(${value.name})`
        }
        if (typeof value !== 'string' || value.length === 0) {
            const defaultSurface = spec?.default || 'inputTex'
            if (defaultSurface === 'none') {
                return 'none'
            }
            return `read(${defaultSurface})`
        }
        if (value === 'none') {
            return 'none'
        }
        if (value.includes('(')) {
            return value
        }
        return `read(${value})`
    }

    // Handle volume type
    if (type === 'volume') {
        if (value && typeof value === 'object' && value.name) {
            return value.name
        }
        if (typeof value !== 'string' || value.length === 0) {
            return spec?.default || 'vol0'
        }
        return value
    }

    // Handle geometry type
    if (type === 'geometry') {
        if (value && typeof value === 'object' && value.name) {
            return value.name
        }
        if (typeof value !== 'string' || value.length === 0) {
            return spec?.default
        }
        return value
    }

    // Handle member type (enum path already formatted)
    if (type === 'member') {
        return value
    }

    // Handle palette type
    if (type === 'palette') {
        return value
    }

    // Handle automation objects (Oscillator, Midi, Audio)
    if (value && typeof value === 'object') {
        if (value.type === 'Oscillator' || value.oscillator === true) {
            return formatOscillator(value)
        }
        if (value.type === 'Midi') {
            return formatMidi(value)
        }
        if (value.type === 'Audio') {
            return formatAudio(value)
        }
    }

    if (typeof value === 'number') {
        // Format numbers nicely - limit to 3 decimal places
        if (Number.isInteger(value)) {
            return String(value)
        }
        // Round to 3 decimal places
        const rounded = Math.round(value * 1000) / 1000
        return String(rounded)
    }

    if (typeof value === 'string') {
        // Colors (hex strings like #ffffff) must NOT be quoted even though they're strings
        if (value.startsWith('#')) {
            return value
        }

        // Check if this looks like a valid unquoted identifier
        // Valid identifiers: start with letter/underscore, contain only alphanumeric/underscore
        const isValidIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)

        // Check if it's an enum path (like oscKind.sine)
        const isEnumPath = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(value)

        // Quote strings when:
        // 1. spec.type is 'string' (freeform text like text content)
        // 2. The value contains whitespace or special characters that would break parsing
        // 3. The value is not a valid identifier or enum path
        const needsQuoting = type === 'string' || (!isValidIdentifier && !isEnumPath)

        if (needsQuoting) {
            // Use triple-quotes for multi-line strings
            if (value.includes('\n')) {
                return `"""${value}"""`
            }
            // Escape any quotes in the string
            const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            return `"${escaped}"`
        }
        return value
    }

    // Handle both regular arrays and typed arrays (Float32Array, etc.)
    const isArrayLike = Array.isArray(value) || ArrayBuffer.isView(value)
    if (isArrayLike) {
        // Convert typed arrays to regular arrays for processing
        const arr = Array.isArray(value) ? value : Array.from(value)

        // Handle vec2 explicitly if spec says so
        if (type === 'vec2' && arr.length === 2 && arr.every(v => typeof v === 'number')) {
            return `vec2(${arr.map(v => formatValue(v, null, options)).join(', ')})`
        }

        // Check if this is a color param (should format as hex regardless of vec3/vec4 type)
        const isColorControl = spec?.type === 'color'

        // Handle vec3 explicitly if spec says so
        if (type === 'vec3' && arr.length === 3 && arr.every(v => typeof v === 'number')) {
            // If it's a color control, format as hex (6-digit, no alpha)
            if (isColorControl) {
                const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
                return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}`
            }
            return `vec3(${arr.map(v => formatValue(v, null, options)).join(', ')})`
        }

        // Handle vec4 explicitly if spec says so - format as hex color
        if (type === 'vec4' && arr.length === 4 && arr.every(v => typeof v === 'number')) {
            const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0')
            return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}${toHex(arr[3])}`
        }

        // Infer type from array length for numeric arrays
        if (arr.every(v => typeof v === 'number')) {
            if (arr.length === 2) {
                return `vec2(${arr.map(v => formatValue(v, null, options)).join(', ')})`
            }
            if (arr.length === 3) {
                // If it's a color control, format as hex (6-digit, no alpha)
                if (isColorControl) {
                    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
                    return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}`
                }
                return `vec3(${arr.map(v => formatValue(v, null, options)).join(', ')})`
            }
            if (arr.length === 4) {
                // 4 elements - hex color
                const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
                return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}${toHex(arr[3])}`
            }
        }
        // Fallback for other arrays - this should not happen in valid DSL
        // If it's a color control, format as hex
        if (isColorControl && arr.length >= 3) {
            const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
            return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}`
        }
        return `vec3(${arr.slice(0, 3).map(v => formatValue(v, null, options)).join(', ')})`
    }

    if (typeof value === 'object') {
        // Handle String AST node
        if (value.type === 'String') {
            const escaped = value.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            return `"${escaped}"`
        }
        // Handle oscillator configuration
        if (value.type === 'Oscillator') {
            return formatOscillator(value)
        }
        // Handle oscillator AST from _ast property
        if (value._ast && value._ast.type === 'Oscillator') {
            return formatOscillator(value)
        }
        // Handle MIDI configuration
        if (value.type === 'Midi' && typeof value.channel === 'number') {
            return formatMidi(value)
        }
        // Handle MIDI AST from _ast property
        if (value._ast && value._ast.type === 'Midi') {
            return formatMidi(value)
        }
        // Handle Audio configuration
        if (value.type === 'Audio' && typeof value.band === 'number') {
            return formatAudio(value)
        }
        // Handle Audio AST from _ast property
        if (value._ast && value._ast.type === 'Audio') {
            return formatAudio(value)
        }
        // Handle special AST node types
        if (value.type === 'Oscillator') {
            // This is a raw Oscillator AST node - format it
            const typePath = value.oscType
            let typeName = 'sine'
            if (typePath && typePath.type === 'Member' && typePath.path) {
                typeName = typePath.path[typePath.path.length - 1]
            } else if (typePath && typePath.type === 'Ident') {
                typeName = typePath.name
            }
            const parts = [`type: oscKind.${typeName}`]
            if (value.min && value.min.type === 'Number' && value.min.value !== 0) {
                parts.push(`min: ${value.min.value}`)
            }
            if (value.max && value.max.type === 'Number' && value.max.value !== 1) {
                parts.push(`max: ${value.max.value}`)
            }
            if (value.speed && value.speed.type === 'Number' && value.speed.value !== 1) {
                parts.push(`speed: ${value.speed.value}`)
            }
            if (value.offset && value.offset.type === 'Number' && value.offset.value !== 0) {
                parts.push(`offset: ${value.offset.value}`)
            }
            if (value.seed && value.seed.type === 'Number' && value.seed.value !== 1) {
                parts.push(`seed: ${value.seed.value}`)
            }
            return `osc(${parts.join(', ')})`
        }
        // Handle raw Midi AST node
        if (value.type === 'Midi') {
            const parts = []
            if (value.channel && value.channel.type === 'Number') {
                parts.push(`channel: ${value.channel.value}`)
            }
            const modePath = value.mode
            let modeName = 'velocity'
            if (modePath && modePath.type === 'Member' && modePath.path) {
                modeName = modePath.path[modePath.path.length - 1]
            } else if (modePath && modePath.type === 'Ident') {
                modeName = modePath.name
            }
            if (modeName !== 'velocity') {
                parts.push(`mode: midiMode.${modeName}`)
            }
            if (value.min && value.min.type === 'Number' && value.min.value !== 0) {
                parts.push(`min: ${value.min.value}`)
            }
            if (value.max && value.max.type === 'Number' && value.max.value !== 1) {
                parts.push(`max: ${value.max.value}`)
            }
            if (value.sensitivity && value.sensitivity.type === 'Number' && value.sensitivity.value !== 1) {
                parts.push(`sensitivity: ${value.sensitivity.value}`)
            }
            return `midi(${parts.join(', ')})`
        }
        // Handle raw Audio AST node
        if (value.type === 'Audio') {
            const bandPath = value.band
            let bandStr = 'audioBand.low'
            if (bandPath && bandPath.type === 'Member' && bandPath.path) {
                bandStr = `audioBand.${bandPath.path[bandPath.path.length - 1]}`
            } else if (bandPath && bandPath.type === 'Ident') {
                bandStr = bandPath.name
            } else if (bandPath && bandPath.type === 'Number') {
                bandStr = String(bandPath.value)
            }
            const parts = [`band: ${bandStr}`]
            if (value.min && value.min.type === 'Number' && value.min.value !== 0) {
                parts.push(`min: ${value.min.value}`)
            }
            if (value.max && value.max.type === 'Number' && value.max.value !== 1) {
                parts.push(`max: ${value.max.value}`)
            }
            if (value.channel?.type === 'Number') parts.push(`channel: ${value.channel.value}`)
            if (value.name?.type === 'String') {
                parts.push(`name: ${JSON.stringify(decodeJsonStringLiteralContent(value.name.value))}`)
            }
            if (value.id?.type === 'String') {
                parts.push(`id: ${JSON.stringify(decodeJsonStringLiteralContent(value.id.value))}`)
            }
            return `audio(${parts.join(', ')})`
        }
        // Handle Read node (pipeline built-in)
        if (value.type === 'Read') {
            const surfaceName = value.surface?.name || value.surface
            return `read(${surfaceName})`
        }
        // Handle Read3D node (pipeline built-in)
        // 1 arg: read3d(vol0) - for param use
        // 2 args: read3d(vol0, geo0) - starter node
        if (value.type === 'Read3D') {
            const tex3dName = value.tex3d?.name || value.tex3d
            if (value.geo) {
                const geoName = value.geo?.name || value.geo
                return `read3d(${tex3dName}, ${geoName})`
            } else {
                return `read3d(${tex3dName})`
            }
        }
        if (value.type === 'OutputRef') {
            return value.name
        }
        if (value.type === 'SourceRef') {
            return value.name
        }
        if (value.type === 'VolRef') {
            return value.name
        }
        if (value.type === 'GeoRef') {
            return value.name
        }
        if (value.type === 'Member') {
            return value.path.join('.')
        }
        if (value.type === 'Number') {
            return formatValue(value.value, spec, options)
        }
        if (value.type === 'Boolean') {
            return value.value ? 'true' : 'false'
        }
        // Surface reference - wrap in read() if spec indicates surface type
        if (value.kind === 'output' || value.kind === 'feedback' || value.kind === 'source') {
            if (spec && spec.type === 'surface') {
                return `read(${value.name})`
            }
            return value.name
        }
    }

    // SAFETY: Never let arrays become raw comma-separated strings
    // This catches any array-like that slipped through earlier checks
    if (value && typeof value === 'object' && typeof value.length === 'number') {
        const arr = Array.from(value)
        const isColorControl = spec?.type === 'color'
        if (arr.length >= 2 && arr.length <= 4 && arr.every(v => typeof v === 'number')) {
            if (arr.length === 2) return `vec2(${arr.join(', ')})`
            if (arr.length === 3) {
                // If it's a color control, format as hex (6-digit, no alpha)
                if (isColorControl) {
                    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
                    return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}`
                }
                return `vec3(${arr.join(', ')})`
            }
            // 4 elements - hex color
            const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
            return `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}${toHex(arr[3])}`
        }
    }

    return String(value)
}

/**
 * Unparse a Call node
 * @param {object} call - Call AST node
 * @param {object} options - Unparse options (includes customFormatter, multilineKwargs)
 * @returns {string} DSL source for the call
 */
function unparseCall(call, options = {}) {
    const name = call.name
    const parts = []
    const specs = options.specs || {}
    const multilineKwargs = options.multilineKwargs !== false // default true
    const baseIndent = Number.isFinite(options.indent) ? options.indent : 0
    const parentIndent = ' '.repeat(Math.max(0, baseIndent))
    const childIndent = ' '.repeat(Math.max(0, baseIndent + 2))

    // Handle kwargs (named arguments)
    if (call.kwargs && Object.keys(call.kwargs).length > 0) {
        for (const [key, value] of Object.entries(call.kwargs)) {
            // Skip _skip: false
            if (key === '_skip' && value === false) continue

            // Get spec from options if available
            const spec = specs[key] || null
            // Round-trip the source form for this key when the compiled
            // step carries a sidecar `argSources` (added when the source
            // contained a literal `[…]`). Absent for every existing
            // program — vec3()/vec4()/hex paths run unchanged.
            const sourceForm = call.argSources?.[key]

            // Check against default value
            if (spec && spec.default !== undefined) {
                const formattedValue = formatValue(value, spec, options, sourceForm)
                const formattedDefault = formatValue(spec.default, spec, options)

                // For surface params, 'none' must always be explicit when set
                // (so the expander binds the blank texture) — unless the default IS 'none'
                const isExplicitNone = spec.type === 'surface' && formattedValue === 'none' && formattedDefault !== 'none'

                if (formattedValue === formattedDefault && !isExplicitNone) {
                    continue
                }
            }

            parts.push(`${key}: ${formatValue(value, spec, options, sourceForm)}`)
        }
    }

    // Handle positional args
    if (call.args && call.args.length > 0) {
        for (const arg of call.args) {
            parts.push(formatValue(arg, null, options))
        }
    }

    // Use multiline formatting only if more than 2 kwargs; 1-2 params stay inline
    const hasKwargs = call.kwargs && Object.keys(call.kwargs).length > 0 && parts.length > 0
    if (multilineKwargs && hasKwargs && parts.length > 2) {
        // Multiline format: args indented 1 level (2 spaces) below parent's indent level
        // Parent indent is 0 for first call in chain, 2 for subsequent chained calls.
        return `${name}(\n${parts.map(p => `${childIndent}${p}`).join(',\n')}\n${parentIndent})`
    }

    return `${name}(${parts.join(', ')})`
}

/**
 * Unparse a chain of calls
 * @param {Array} chain - Array of Call nodes
 * @param {object} options - Unparse options
 * @returns {string} DSL source for the chain
 */
function unparseChain(chain, options = {}) {
    const parts = chain.map((call, idx) => unparseCall(call, { ...options, indent: idx === 0 ? 0 : 2 }))
    // Join with line break after closing paren, 2-space indent on next line
    return parts.join('\n  .')
}

/**
 * Format a let expression AST node back to DSL source
 * @param {object} expr - Expression AST node from a VarAssign
 * @param {object} options - Unparse options
 * @returns {string} DSL source for the expression
 */
function formatLetExpr(expr, options = {}) {
    if (!expr) return 'null'
    if (expr._varRef) return expr._varRef

    // Helper: extract numeric value from an AST Number node
    const numVal = (node) => (node && node.type === 'Number') ? node.value : undefined

    switch (expr.type) {
        case 'Number':
            return String(expr.value)
        case 'String':
            return JSON.stringify(expr.value)
        case 'Boolean':
            return expr.value ? 'true' : 'false'
        case 'Ident':
            return expr.name
        case 'Member':
            return expr.path.join('.')
        case 'Oscillator': {
            // Raw AST Oscillator: sub-fields are AST nodes
            let typeStr = 'oscKind.sine'
            if (expr.oscType?.type === 'Member' && expr.oscType.path) {
                typeStr = `oscKind.${expr.oscType.path[expr.oscType.path.length - 1]}`
            } else if (expr.oscType?.type === 'Ident') {
                typeStr = expr.oscType.name  // variable reference, no prefix
            } else if (expr.oscType?.type === 'Number' &&
                Number.isInteger(expr.oscType.value) && expr.oscType.value >= 0 && expr.oscType.value <= 5) {
                typeStr = `oscKind.${oscKindNames[expr.oscType.value]}`
            }
            const parts = [`type: ${typeStr}`]
            const pushIfNonDefault = (name, node, def) => {
                if (!node) return
                const v = numVal(node)
                if (v !== undefined && v === def) return
                parts.push(`${name}: ${formatLetExpr(node, options)}`)
            }
            pushIfNonDefault('min', expr.min, 0)
            pushIfNonDefault('max', expr.max, 1)
            pushIfNonDefault('speed', expr.speed, 1)
            pushIfNonDefault('offset', expr.offset, 0)
            pushIfNonDefault('seed', expr.seed, 1)
            return `osc(${parts.join(', ')})`
        }
        case 'Midi': {
            // Raw AST Midi: sub-fields are AST nodes
            const parts = []
            if (expr.channel) parts.push(`channel: ${formatLetExpr(expr.channel, options)}`)
            let modeStr = null
            if (expr.mode?.type === 'Member' && expr.mode.path) {
                const name = expr.mode.path[expr.mode.path.length - 1]
                if (name !== 'velocity') modeStr = `midiMode.${name}`
            } else if (expr.mode?.type === 'Ident') {
                modeStr = expr.mode.name  // variable reference, no prefix
            } else if (expr.mode?.type === 'Number' && expr.mode.value !== 4) {
                modeStr = String(expr.mode.value)
            }
            if (modeStr) parts.push(`mode: ${modeStr}`)
            const pushMidiField = (name, node, def) => {
                if (!node) return
                const v = numVal(node)
                if (v !== undefined && v === def) return
                parts.push(`${name}: ${formatLetExpr(node, options)}`)
            }
            pushMidiField('min', expr.min, 0)
            pushMidiField('max', expr.max, 1)
            pushMidiField('sensitivity', expr.sensitivity, 1)
            // MIDI identity accepts either DSL quote style. Normalize the
            // decoded value through JSON escaping so every result reparses.
            if (expr.name?.type === 'String') {
                parts.push(`name: ${JSON.stringify(decodeJsonStringLiteralContent(expr.name.value))}`)
            }
            if (expr.id?.type === 'String') {
                parts.push(`id: ${JSON.stringify(decodeJsonStringLiteralContent(expr.id.value))}`)
            }
            return `midi(${parts.join(', ')})`
        }
        case 'Audio': {
            // Raw AST Audio: sub-fields are AST nodes
            const formatAudioField = (node) => node?.type === 'String'
                ? JSON.stringify(decodeJsonStringLiteralContent(node.value))
                : formatLetExpr(node, options)
            const bandStr = expr.band ? formatAudioField(expr.band) : 'audioBand.low'
            const parts = [`band: ${bandStr}`]
            const pushAudioField = (name, node, defaultValue) => {
                if (!node) return
                const numeric = numVal(node)
                if (numeric !== undefined && numeric === defaultValue) return
                parts.push(`${name}: ${formatAudioField(node)}`)
            }
            pushAudioField('min', expr.min, 0)
            pushAudioField('max', expr.max, 1)
            pushAudioField('channel', expr.channel, undefined)
            if (expr.name?.type === 'String') {
                parts.push(`name: ${formatAudioField(expr.name)}`)
            }
            if (expr.id?.type === 'String') {
                parts.push(`id: ${formatAudioField(expr.id)}`)
            }
            return `audio(${parts.join(', ')})`
        }
        case 'Call':
            return unparseCall(expr, options)
        case 'Chain':
            return unparseChain(expr.chain, options)
        case 'Func':
            return `() => ${formatLetExpr(expr.body, options)}`
        default:
            return formatValue(expr, null, options)
    }
}

/**
 * Unparse an entire program
 * @param {object} compiled - Compiled result from compile()
 * @param {object} overrides - Map of stepIndex -> parameter overrides
 * @param {object} options - Unparse options
 *   - customFormatter: function(value, spec) => string|null
 *   - getEffectDef: function(effectName, namespace) => effectDef|null
 * @returns {string} Complete DSL source
 */
export function unparse(compiled, overrides = {}, options = {}) {
    // Ensure enum definitions are available for formatting
    options = options.enums ? options : { ...options, enums: stdEnums }
    const lines = []
    const getEffectDef = options.getEffectDef || null
    const searchNamespaces = compiled.searchNamespaces || []

    // Add search directive if present (with two line breaks after)
    if (searchNamespaces.length > 0) {
        lines.push(`search ${searchNamespaces.join(', ')}`)
        lines.push('') // First blank line after search
    }

    // Emit let declarations
    if (compiled.vars && compiled.vars.length > 0) {
        for (const v of compiled.vars) {
            if (v.leadingComments && v.leadingComments.length > 0) {
                for (const c of v.leadingComments) {
                    lines.push(c)
                }
            }
            const exprStr = formatLetExpr(v.expr, options)
            lines.push(`let ${v.name} = ${exprStr}`)
        }
        lines.push('') // blank line separator after let block
    }

    // Track global step index across all plans
    let globalStepIndex = 0

    // Process each plan
    const plans = compiled.plans || []
    for (let planIndex = 0; planIndex < plans.length; planIndex++) {
        const plan = plans[planIndex]
        if (!plan.chain || plan.chain.length === 0) continue

        // Emit plan-level leading comments
        if (plan.leadingComments && plan.leadingComments.length > 0) {
            for (const comment of plan.leadingComments) {
                lines.push(comment)
            }
        }

        // Build chains from steps, tracking comments
        // read() is a starter node unless marked as chained
        const chains = []  // Array of chain arrays (each element has { code, leadingComments? })
        let currentChain = []
        let inSubchain = false  // Track subchain context for proper indentation

        for (const step of plan.chain) {
            // Helper to build a chain element with optional comments
            const makeChainElement = (code) => {
                const elem = { code }
                if (step.leadingComments && step.leadingComments.length > 0) {
                    elem.leadingComments = step.leadingComments
                }
                return elem
            }

            // Handle builtin read operations - always starts a new chain
            if (step.builtin && step.op === '_read') {
                // Flush current chain if not empty
                if (currentChain.length > 0) {
                    chains.push(currentChain)
                    currentChain = []
                }
                const texName = step.args?.tex?.name || step.args?.tex
                // Check for _skip: overrides take precedence over step.args
                const hasOverride = overrides[globalStepIndex]?._skip !== undefined
                const isSkipped = hasOverride
                    ? overrides[globalStepIndex]._skip === true
                    : step.args?._skip === true
                // Use positional form when no _skip, keyword form when _skip is present
                let readCode
                if (isSkipped) {
                    readCode = `read(surface: ${texName}, _skip: true)`
                } else {
                    readCode = `read(${texName})`
                }
                currentChain.push(makeChainElement(readCode))
                globalStepIndex++
                continue
            }
            // Handle builtin read3d operations - always starts a new chain
            if (step.builtin && step.op === '_read3d') {
                // Flush current chain if not empty
                if (currentChain.length > 0) {
                    chains.push(currentChain)
                    currentChain = []
                }
                const tex3d = step.args?.tex3d?.name || step.args?.tex3d
                const geo = step.args?.geo?.name || step.args?.geo
                // Check for _skip: overrides take precedence over step.args
                const hasOverride = overrides[globalStepIndex]?._skip !== undefined
                const isSkipped = hasOverride
                    ? overrides[globalStepIndex]._skip === true
                    : step.args?._skip === true
                // Use positional form when no _skip, keyword form when _skip is present
                let read3dCode
                if (isSkipped) {
                    read3dCode = `read3d(tex3d: ${tex3d}, geo: ${geo}, _skip: true)`
                } else {
                    read3dCode = `read3d(${tex3d}, ${geo})`
                }
                currentChain.push(makeChainElement(read3dCode))
                globalStepIndex++
                continue
            }
            // Handle builtin write operations (mid-chain writes)
            if (step.builtin && step.op === '_write') {
                const texName = step.args?.tex?.name || step.args?.tex
                currentChain.push(makeChainElement(`write(${texName})`))
                globalStepIndex++
                continue
            }
            // Handle builtin write3d operations (mid-chain write3d)
            if (step.builtin && step.op === '_write3d') {
                const tex3dName = step.args?.tex3d?.name || step.args?.tex3d
                const geoName = step.args?.geo?.name || step.args?.geo
                currentChain.push(makeChainElement(`write3d(${tex3dName}, ${geoName})`))
                globalStepIndex++
                continue
            }

            // Handle subchain begin marker - starts a subchain block
            if (step.builtin && step.op === '_subchain_begin') {
                const name = step.args?.name
                const id = step.args?.id
                const parts = []
                if (name) parts.push(`name: "${name}"`)
                if (id) parts.push(`id: "${id}"`)
                const argsStr = parts.length > 0 ? parts.join(', ') : ''
                const elem = { code: `subchain(${argsStr}) {`, isSubchainBegin: true }
                if (step.leadingComments && step.leadingComments.length > 0) {
                    elem.leadingComments = step.leadingComments
                }
                currentChain.push(elem)
                inSubchain = true
                globalStepIndex++
                continue
            }

            // Handle subchain end marker - ends a subchain block
            if (step.builtin && step.op === '_subchain_end') {
                currentChain.push({ code: '}', isSubchainEnd: true })
                inSubchain = false
                globalStepIndex++
                continue
            }

            // Check for parameter overrides for this step
            const stepOverrides = overrides[globalStepIndex] || {}

            // Get effect definition if callback provided
            let effectDef = null
            if (getEffectDef) {
                const namespace = step.namespace?.namespace || step.namespace?.resolved || null
                effectDef = getEffectDef(step.op, namespace)
            }

            // Determine the call name - strip namespace prefix if it's in search namespaces
            let callName = step.op
            const nsInfo = step.namespace?.call || step.namespace
            const isFromOverride = nsInfo?.fromOverride === true
            const fromNamespace = isFromOverride ? (nsInfo?.resolved || nsInfo?.name || step.namespace?.resolved) : null
            for (const ns of searchNamespaces) {
                const prefix = `${ns}.`
                if (callName.startsWith(prefix)) {
                    callName = callName.slice(prefix.length)
                    break
                }
            }
            // For from() overrides, strip the override namespace prefix from the call name
            if (isFromOverride && fromNamespace) {
                const fromPrefix = `${fromNamespace}.`
                if (callName.startsWith(fromPrefix)) {
                    callName = callName.slice(fromPrefix.length)
                }
            }

            const call = {
                name: callName,
                kwargs: {},
                args: []
            }
            // Carry the validator's source-form sidecar through so the
            // kwarg formatter can round-trip array literals back to
            // `[…]`. Absent for steps that didn't use any source-tagged
            // input form, so existing programs see no behavior change.
            if (step.argSources) call.argSources = step.argSources

            // Start with original args (already keyed by param names)
            if (step.args) {
                for (const [key, value] of Object.entries(step.args)) {
                    // Skip internal properties
                    if (key === 'from' || key === 'temp') continue

                    // Skip _skip: false (only include when true)
                    if (key === '_skip' && value !== true) continue

                    // Handle surface references
                    if (value && typeof value === 'object' && value.kind) {
                        call.kwargs[key] = value.name
                    } else {
                        call.kwargs[key] = value
                    }
                }
            }

            // Build specs map from effect definition
            const specs = effectDef?.globals || {}

            // Apply overrides - filter to only include valid DSL parameters
            // When we have an effect definition, only include keys defined in globals
            // This prevents internal tracking values or stale values from leaking to DSL
            // Exception: internal _ prefixed args like _skip are always allowed
            for (const [key, value] of Object.entries(stepOverrides)) {
                // Always allow internal _ prefixed args (e.g., _skip)
                if (key.startsWith('_')) {
                    call.kwargs[key] = value
                } else if (effectDef) {
                    // Effect definition exists - only include keys that are defined in globals
                    // This handles effects with empty globals (like loopEnd) correctly
                    if (specs[key] !== undefined) {
                        call.kwargs[key] = value
                    }
                } else {
                    // No effect definition available - include all overrides (fallback for unknown effects)
                    // This should rarely happen since getEffectDef is usually provided
                    call.kwargs[key] = value
                }
            }

            // Calculate indent: 4 spaces inside subchain, 2 outside; 0 for first element
            const callIndent = currentChain.length === 0 ? 0 : (inSubchain ? 4 : 2)
            let callCode = unparseCall(call, { ...options, specs, indent: callIndent })
            // Wrap in from(namespace, call) for cross-namespace references
            if (isFromOverride && fromNamespace) {
                callCode = `from(${fromNamespace}, ${callCode})`
            }
            currentChain.push(makeChainElement(callCode))
            globalStepIndex++
        }

        // Flush final chain
        if (currentChain.length > 0) {
            chains.push(currentChain)
        }

        // Join each chain's parts with line break and 2-space indent, including comments
        // Then join chains with blank line (read() starts new chain)
        // Handle subchain blocks with proper indentation
        function joinChainWithComments(chain) {
            const parts = []
            let inSubchain = false
            for (let i = 0; i < chain.length; i++) {
                const elem = chain[i]
                const isFirst = i === 0
                const baseIndent = inSubchain ? '    ' : '  '  // 4 spaces inside subchain, 2 outside

                // Emit leading comments for this element
                if (elem.leadingComments && elem.leadingComments.length > 0) {
                    for (const comment of elem.leadingComments) {
                        if (isFirst) {
                            // Comments before first element go on their own line
                            parts.push(comment)
                        } else {
                            // Comments before chained elements get indented
                            parts.push(`${baseIndent}${comment}`)
                        }
                    }
                }

                // Handle subchain begin
                if (elem.isSubchainBegin) {
                    if (isFirst) {
                        parts.push(elem.code)
                    } else {
                        parts.push(`  .${elem.code}`)
                    }
                    inSubchain = true
                    continue
                }

                // Handle subchain end
                if (elem.isSubchainEnd) {
                    parts.push(`  ${elem.code}`)
                    inSubchain = false
                    continue
                }

                // Emit the code
                if (isFirst) {
                    parts.push(elem.code)
                } else if (inSubchain) {
                    // Inside subchain: 4-space indent with dot
                    parts.push(`    .${elem.code}`)
                } else {
                    parts.push(`  .${elem.code}`)
                }
            }
            return parts.join('\n')
        }
        let line = chains.map(joinChainWithComments).join('\n\n')

        // Check if chain already ends with a _write step (chainable writes are now inline)
        const lastStep = plan.chain[plan.chain.length - 1]
        const chainEndsWithWrite = lastStep && lastStep.builtin && lastStep.op === '_write'
        const chainEndsWithWrite3d = lastStep && lastStep.builtin && lastStep.op === '_write3d'

        // Add write directive only if chain doesn't already end with _write
        if (plan.write && !chainEndsWithWrite) {
            const writeName = typeof plan.write === 'string' ? plan.write : plan.write.name
            line += `\n  .write(${writeName})`
        }
        // Add write3d directive only if chain doesn't already end with _write3d
        if (plan.write3d && !chainEndsWithWrite3d) {
            const tex3d = plan.write3d.tex3d?.name || plan.write3d.tex3d
            const geo = plan.write3d.geo?.name || plan.write3d.geo
            line += `\n  .write3d(${tex3d}, ${geo})`
        }

        lines.push(line)

        // Add blank line after chain statement (two line breaks between chains)
        // Don't add after the last plan
        if (planIndex < plans.length - 1) {
            lines.push('')
        }
    }

    // Add render directive if present (surface name: o0-o7)
    if (compiled.render) {
        lines.push('')
        lines.push(`render(${compiled.render})`)
    }

    // Add trailing comments if present
    if (compiled.trailingComments && compiled.trailingComments.length > 0) {
        for (const comment of compiled.trailingComments) {
            lines.push(comment)
        }
    }

    return lines.join('\n')
}

/**
 * Apply parameter updates to a compiled DSL and regenerate source
 * @param {string} originalDsl - Original DSL source
 * @param {object} compile - The compile function
 * @param {object} parameterUpdates - Map of stepIndex -> {paramName: value}
 * @returns {string} Updated DSL source
 */
export function applyParameterUpdates(originalDsl, compileFn, parameterUpdates) {
    // Parse the original DSL
    const compiled = compileFn(originalDsl)
    if (!compiled || !compiled.plans) {
        return originalDsl
    }

    // Extract search namespaces from original source
    const searchMatch = originalDsl.match(/^search\s+(\S.*?)$/m)
    if (searchMatch) {
        compiled.searchNamespaces = searchMatch[1].split(/\s*,\s*/)
    }

    // Generate new source with overrides
    return unparse(compiled, parameterUpdates, {})
}

export { formatValue, unparseCall, unparseChain }
