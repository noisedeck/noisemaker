#!/usr/bin/env node

/**
 * standardize-params.js
 *
 * Transforms all definition.js files to apply parameter standardization:
 * 1. Rename param keys (from param-rename-map.js)
 * 2. Fix non-standard types and cross-effect type consistency
 * 3. Standardize UI labels (lowercase, fill missing, fix divergences)
 * 4. Add paramAliases for effects that had renames
 *
 * CRITICAL: Does NOT change `uniform` field values. Only changes the
 * globals object key, `type`, `ui.label`, and adds `paramAliases`.
 *
 * Usage:
 *   node shaders/scripts/standardize-params.js           # apply changes
 *   node shaders/scripts/standardize-params.js --dry-run  # preview only
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { renameMap } from './param-rename-map.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DRY_RUN = process.argv.includes('--dry-run')

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Non-standard type names -> canonical type names.
 * Applied globally to every param.
 */
const TYPE_ALIASES = {
  'bool': 'boolean',
  'integer': 'int',
  'number': 'int',
  'enum': 'int',
}

/**
 * Cross-effect type standardization.
 * paramKey -> canonical type.
 * Applied globally: if a param has this key, its type is forced.
 */
const PARAM_TYPE_OVERRIDES = {
  seed:       'int',
  rotation:   'float',
  speed:      'int',
  loopAmp:    'int',
  levels:     'int',
  octaves:    'int',
  smoothing:  'float',
  brightness: 'float',
  contrast:   'float',
  saturation: 'float',
  intensity:  'float',
  offsetX:    'float',
  offsetY:    'float',
  flip:       'int',
  sides:      'int',
  splineOrder: 'int',
  // zoom is NOT included (pipeline param exception)
}

/**
 * Custom label overrides for specific param keys.
 * These take precedence over the camelCase derivation.
 */
const LABEL_OVERRIDES = {
  bgColor:    'background color',
  bgAlpha:    'background opacity',
  bgOpacity:  'background opacity',
  resetState: 'reset',
  blendMode:  'blend mode',
  colorMode:  'color mode',
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Convert camelCase to space-separated lowercase.
 * e.g. "offsetX" -> "offset x", "bgColor" -> "bg color"
 */
function camelToLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
}

/**
 * Derive a label for a param key.
 * Uses LABEL_OVERRIDES first, then camelCase conversion.
 */
function deriveLabel(paramKey) {
  if (LABEL_OVERRIDES[paramKey]) return LABEL_OVERRIDES[paramKey]
  return camelToLabel(paramKey)
}

/**
 * Recursively glob definition.js files.
 */
function globDefinitions(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      results.push(...globDefinitions(full))
    } else if (entry === 'definition.js') {
      results.push(full)
    }
  }
  return results
}

/**
 * Extract namespace and func from a definition.js file's text.
 * Works for both `new Effect({...})` and `class ... extends Effect` patterns.
 */
function extractIdentity(text) {
  // new Effect({ namespace: "...", func: "..." })
  let nsMatch = text.match(/namespace\s*[:=]\s*["']([^"']+)["']/)
  let fnMatch = text.match(/func\s*[:=]\s*["']([^"']+)["']/)
  return {
    namespace: nsMatch ? nsMatch[1] : null,
    func: fnMatch ? fnMatch[1] : null,
  }
}

/**
 * Parse the globals block from file text, extracting param info.
 * Returns an array of { key, startIndex, endIndex, type, hasUi, hasLabel, labelValue, hasControlFalse, uniformValue }
 *
 * We do a simplified parse: find each top-level key in the globals object,
 * then extract metadata from its block.
 */
function parseGlobalsParams(text) {
  // Find the globals block
  // Support both `globals = {` (class) and `globals: {` (object literal)
  const globalsStartMatch = text.match(/globals\s*[=:]\s*\{/)
  if (!globalsStartMatch) return []

  const globalsStart = globalsStartMatch.index + globalsStartMatch[0].length
  // Find the matching closing brace
  let depth = 1
  let i = globalsStart
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
  }
  const globalsEnd = i - 1 // points to the closing }
  const globalsText = text.substring(globalsStart, globalsEnd)

  const params = []
  // Match param keys: either `key: {` or `"key": {`
  // We need to find them at the correct nesting level (depth 0 within globalsText)
  let pos = 0
  while (pos < globalsText.length) {
    // Skip whitespace and comments
    const remaining = globalsText.substring(pos)
    // Match: key: { or "key": {
    const keyMatch = remaining.match(/^[\s,]*(\/\/[^\n]*\n\s*)*(["']?)(\w+)\2\s*:\s*\{/)
    if (!keyMatch) {
      pos++
      continue
    }

    const key = keyMatch[3]
    const keyStartInGlobals = pos + keyMatch.index + keyMatch[0].length - 1 // points to {
    // Find matching } for this param block
    let paramDepth = 1
    let j = keyStartInGlobals + 1
    while (j < globalsText.length && paramDepth > 0) {
      if (globalsText[j] === '{') paramDepth++
      else if (globalsText[j] === '}') paramDepth--
      j++
    }
    const paramBlockEnd = j // one past the closing }
    const paramBlock = globalsText.substring(keyStartInGlobals, paramBlockEnd)

    // Extract type
    const typeMatch = paramBlock.match(/["']?type["']?\s*:\s*["']([^"']+)["']/)
    const type = typeMatch ? typeMatch[1] : null

    // Extract uniform
    const uniformMatch = paramBlock.match(/["']?uniform["']?\s*:\s*["']([^"']+)["']/)
    const uniformValue = uniformMatch ? uniformMatch[1] : null

    // Check for ui block
    const hasUi = /["']?ui["']?\s*:\s*\{/.test(paramBlock)

    // Check for label in ui block
    const labelMatch = paramBlock.match(/["']?label["']?\s*:\s*["']([^"']*)["']/)
    const hasLabel = labelMatch !== null
    const labelValue = hasLabel ? labelMatch[1] : null

    // Check for control: false (hidden params)
    const hasControlFalse = /["']?control["']?\s*:\s*false/.test(paramBlock)

    params.push({
      key,
      globalOffset: globalsStart,  // offset of globals content in original text
      startInGlobals: pos + keyMatch.index, // start of key line in globalsText
      endInGlobals: paramBlockEnd,
      type,
      hasUi,
      hasLabel,
      labelValue,
      hasControlFalse,
      uniformValue,
    })

    pos = keyStartInGlobals + (paramBlockEnd - keyStartInGlobals)
  }

  return params
}

// ─── Transformation Logic ───────────────────────────────────────────

function transformFile(filePath, text) {
  const { namespace, func } = extractIdentity(text)
  if (!namespace || !func) {
    return { text, changes: [] }
  }

  const mapKey = `${namespace}/${func}`
  const renames = renameMap[mapKey] || {}

  const changes = []
  let result = text

  // Track all renames (old -> new) for paramAliases
  const appliedRenames = {}

  // ── 1. Rename param keys ──
  // We process renames by replacing the key in the globals object.
  // We do this carefully, one at a time, re-reading positions after each change.
  for (const [oldKey, newKey] of Object.entries(renames)) {
    // Find the param key declaration in globals.
    // Match patterns like:
    //   oldKey: {       (unquoted)
    //   "oldKey": {     (double-quoted)
    //   'oldKey': {     (single-quoted)
    // But ONLY within the globals block, and at the right indent level.
    // We use a regex that matches the key at the beginning of a property.

    // First, verify this key actually exists in the file
    const keyRegex = new RegExp(`(["']?)${escapeRegex(oldKey)}\\1(\\s*:\\s*\\{)`)
    // We need to make sure we're replacing within globals, not elsewhere (e.g., uniformLayout)
    const globalsMatch = result.match(/globals\s*[=:]\s*\{/)
    if (!globalsMatch) continue

    const globalsIdx = globalsMatch.index
    // Find all occurrences of the key pattern and pick the one inside globals
    let searchFrom = globalsIdx
    while (searchFrom < result.length) {
      const slice = result.substring(searchFrom)
      const match = slice.match(keyRegex)
      if (!match) break

      const matchIdx = searchFrom + match.index
      // Verify this is inside the globals block (roughly: after `globals` and before the block ends)
      // A simple heuristic: it should be after globalsIdx and the line should look like param indentation
      if (matchIdx > globalsIdx) {
        // Replace old key with new key
        const fullMatch = match[0]
        const quote = match[1]
        const colonPart = match[2]
        const replacement = `${quote}${newKey}${quote}${colonPart}`
        result = result.substring(0, matchIdx) + replacement + result.substring(matchIdx + fullMatch.length)
        appliedRenames[oldKey] = newKey
        changes.push(`rename: ${oldKey} -> ${newKey}`)
        break
      }
      searchFrom = matchIdx + 1
    }
  }

  // ── 2. Fix types ──
  // Re-parse params after renames
  const paramsAfterRename = parseGlobalsParams(result)

  for (const param of paramsAfterRename) {
    if (!param.type) continue

    let newType = param.type

    // Fix non-standard type names
    if (TYPE_ALIASES[param.type]) {
      newType = TYPE_ALIASES[param.type]
    }

    // Apply cross-effect type overrides
    // Use the current key (might have been renamed)
    if (PARAM_TYPE_OVERRIDES[param.key] && newType !== PARAM_TYPE_OVERRIDES[param.key]) {
      // Don't override certain special types (palette, color, vec2, vec3, vec4, surface, member, string)
      const SPECIAL_TYPES = ['palette', 'color', 'vec2', 'vec3', 'vec4', 'surface', 'member', 'string']
      if (!SPECIAL_TYPES.includes(newType)) {
        newType = PARAM_TYPE_OVERRIDES[param.key]
      }
    }

    if (newType !== param.type) {
      // Replace the type in the file
      // We need to find this specific param's type declaration
      const typePattern = new RegExp(
        `(["']?)type\\1\\s*:\\s*["']${escapeRegex(param.type)}["']`
      )
      // Find within the param's block area
      const globalsMatch = result.match(/globals\s*[=:]\s*\{/)
      if (globalsMatch) {
        const searchStart = globalsMatch.index
        // Find the param key
        const keyPattern = new RegExp(`(["']?)${escapeRegex(param.key)}\\1\\s*:\\s*\\{`)
        const keySlice = result.substring(searchStart)
        const keyMatch = keySlice.match(keyPattern)
        if (keyMatch) {
          const keyIdx = searchStart + keyMatch.index
          // Find the type within this param's block (next ~500 chars should be enough)
          const blockSlice = result.substring(keyIdx, keyIdx + 1000)
          const typeInBlock = blockSlice.match(typePattern)
          if (typeInBlock) {
            const typeIdx = keyIdx + typeInBlock.index
            const oldTypeStr = typeInBlock[0]
            // Preserve the quoting style
            const quoteChar = oldTypeStr.includes('"') ? '"' : "'"
            const typeQuote = typeInBlock[1] || ''
            const newTypeStr = `${typeQuote}type${typeQuote}: ${quoteChar}${newType}${quoteChar}`
            result = result.substring(0, typeIdx) + newTypeStr + result.substring(typeIdx + oldTypeStr.length)
            changes.push(`type: ${param.key} ${param.type} -> ${newType}`)
          }
        }
      }
    }
  }

  // ── 3. Standardize UI labels ──
  // Re-parse after type fixes
  const paramsAfterTypes = parseGlobalsParams(result)

  for (const param of paramsAfterTypes) {
    // Skip params with control: false (hidden/internal params)
    if (param.hasControlFalse) continue

    const desiredLabel = LABEL_OVERRIDES[param.key] || null

    if (param.hasLabel && param.labelValue !== null) {
      // Label exists -- lowercase it and apply overrides
      let newLabel = desiredLabel || param.labelValue.toLowerCase()

      if (newLabel !== param.labelValue) {
        // Replace the label value in the file
        result = replaceParamLabel(result, param.key, param.labelValue, newLabel)
        changes.push(`label: ${param.key} "${param.labelValue}" -> "${newLabel}"`)
      }
    } else if (!param.hasLabel && param.hasUi) {
      // Has ui block but no label -- add label
      const newLabel = desiredLabel || deriveLabel(param.key)
      result = addLabelToUiBlock(result, param.key, newLabel)
      changes.push(`label+: ${param.key} added "${newLabel}"`)
    } else if (!param.hasUi) {
      // No ui block at all -- add ui block with label
      const newLabel = desiredLabel || deriveLabel(param.key)
      result = addUiBlockWithLabel(result, param.key, newLabel)
      changes.push(`ui+: ${param.key} added ui with "${newLabel}"`)
    }
  }

  // ── 4. Add paramAliases ──
  if (Object.keys(appliedRenames).length > 0) {
    result = addParamAliases(result, appliedRenames)
    changes.push(`aliases: added paramAliases for ${Object.keys(appliedRenames).length} renames`)
  }

  return { text: result, changes }
}

/**
 * Replace a label value for a specific param key.
 */
function replaceParamLabel(text, paramKey, oldLabel, newLabel) {
  // Find the param's globals block
  const globalsMatch = text.match(/globals\s*[=:]\s*\{/)
  if (!globalsMatch) return text

  const searchStart = globalsMatch.index
  const keyPattern = new RegExp(`(["']?)${escapeRegex(paramKey)}\\1\\s*:\\s*\\{`)
  const keySlice = text.substring(searchStart)
  const keyMatch = keySlice.match(keyPattern)
  if (!keyMatch) return text

  const keyIdx = searchStart + keyMatch.index

  // Find the label within this param's block
  const blockSlice = text.substring(keyIdx, keyIdx + 2000)
  // Match: label: "oldLabel" or label: 'oldLabel' or "label": "oldLabel"
  const labelPattern = new RegExp(
    `(["']?label["']?\\s*:\\s*)(["'])${escapeRegex(oldLabel)}\\2`
  )
  const labelMatch = blockSlice.match(labelPattern)
  if (!labelMatch) return text

  const labelIdx = keyIdx + labelMatch.index
  const oldStr = labelMatch[0]
  const prefix = labelMatch[1]
  const quote = labelMatch[2]
  const newStr = `${prefix}${quote}${newLabel}${quote}`

  return text.substring(0, labelIdx) + newStr + text.substring(labelIdx + oldStr.length)
}

/**
 * Add a label field to an existing ui block for a specific param key.
 */
function addLabelToUiBlock(text, paramKey, label) {
  const globalsMatch = text.match(/globals\s*[=:]\s*\{/)
  if (!globalsMatch) return text

  const searchStart = globalsMatch.index
  const keyPattern = new RegExp(`(["']?)${escapeRegex(paramKey)}\\1\\s*:\\s*\\{`)
  const keySlice = text.substring(searchStart)
  const keyMatch = keySlice.match(keyPattern)
  if (!keyMatch) return text

  const keyIdx = searchStart + keyMatch.index

  // Find the ui: { within this param's block
  const blockSlice = text.substring(keyIdx, keyIdx + 2000)
  const uiMatch = blockSlice.match(/(["']?ui["']?\s*:\s*\{)(\s*)/)
  if (!uiMatch) return text

  const uiIdx = keyIdx + uiMatch.index
  const insertAfter = uiIdx + uiMatch[0].length

  // Determine indentation
  const lineStart = text.lastIndexOf('\n', uiIdx) + 1
  const existingLine = text.substring(lineStart, uiIdx)
  const baseIndent = existingLine.match(/^(\s*)/)[1]
  // Add one more level of indent for the label
  const labelIndent = baseIndent + '    '

  const insertion = `\n${labelIndent}label: "${label}",`

  return text.substring(0, insertAfter) + insertion + text.substring(insertAfter)
}

/**
 * Add a ui block with label to a param that has no ui block.
 */
function addUiBlockWithLabel(text, paramKey, label) {
  const globalsMatch = text.match(/globals\s*[=:]\s*\{/)
  if (!globalsMatch) return text

  const searchStart = globalsMatch.index
  const keyPattern = new RegExp(`(["']?)${escapeRegex(paramKey)}\\1\\s*:\\s*\\{`)
  const keySlice = text.substring(searchStart)
  const keyMatch = keySlice.match(keyPattern)
  if (!keyMatch) return text

  const keyIdx = searchStart + keyMatch.index

  // Find the end of this param's block (matching })
  const blockStart = keyIdx + keyMatch[0].length - 1 // points to {
  let depth = 1
  let pos = blockStart + 1
  while (pos < text.length && depth > 0) {
    if (text[pos] === '{') depth++
    else if (text[pos] === '}') depth--
    pos++
  }
  const blockEnd = pos - 1 // points to closing }

  // Determine indentation from the param key line
  const lineStart = text.lastIndexOf('\n', keyIdx) + 1
  const existingLine = text.substring(lineStart, keyIdx)
  const baseIndent = existingLine.match(/^(\s*)/)[1]
  const propIndent = baseIndent + '    '
  const uiPropIndent = propIndent + '    '

  // Insert ui block before the closing }
  // Check what's before the closing }
  const beforeClose = text.substring(blockStart + 1, blockEnd)

  let insertion
  // Check if the last line before } ends with a comma
  const trimmedBefore = beforeClose.trimEnd()
  const needsComma = trimmedBefore.length > 0 && !trimmedBefore.endsWith(',')

  if (needsComma) {
    // Add comma to the last property, then add ui block
    const lastNonWhitespace = text.lastIndexOf(trimmedBefore.charAt(trimmedBefore.length - 1), blockEnd)
    insertion = `,\n${propIndent}ui: {\n${uiPropIndent}label: "${label}"\n${propIndent}}`
    return text.substring(0, lastNonWhitespace + 1) + insertion + text.substring(blockEnd)
  } else {
    insertion = `\n${propIndent}ui: {\n${uiPropIndent}label: "${label}"\n${propIndent}}`
    return text.substring(0, blockEnd) + insertion + '\n' + baseIndent + text.substring(blockEnd)
  }
}

/**
 * Add paramAliases field to an Effect definition.
 * Inserts right before the `passes` field.
 */
function addParamAliases(text, renames) {
  // Build the aliases object string (oldKey -> newKey)
  const entries = Object.entries(renames)
    .map(([oldKey, newKey]) => `${oldKey}: '${newKey}'`)
    .join(', ')

  const aliasLine = `paramAliases: { ${entries} },`

  // Determine if this is a class-based or object-based definition
  const isClass = /class \w+ extends Effect/.test(text)

  if (isClass) {
    // For class-based: insert `paramAliases = { ... }` before `passes = [`
    const passesMatch = text.match(/(\n(\s*))passes\s*=\s*\[/)
    if (!passesMatch) return text

    const indent = passesMatch[2]
    const classAliasLine = `\n${indent}paramAliases = { ${entries} }\n`
    const insertIdx = passesMatch.index
    return text.substring(0, insertIdx) + classAliasLine + text.substring(insertIdx)
  } else {
    // For object-based: insert `paramAliases: { ... },` before `passes: [`
    const passesMatch = text.match(/(\n(\s*))passes\s*:\s*\[/)
    if (!passesMatch) return text

    const indent = passesMatch[2]
    const insertIdx = passesMatch.index
    return text.substring(0, insertIdx) + `\n${indent}${aliasLine}` + text.substring(insertIdx)
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Main ───────────────────────────────────────────────────────────

const effectsDir = join(__dirname, '..', 'effects')
const files = globDefinitions(effectsDir)

console.log(`Found ${files.length} definition.js files`)
if (DRY_RUN) console.log('=== DRY RUN MODE ===\n')

let totalModified = 0
let totalRenames = 0
let totalTypeFixes = 0
let totalLabelFixes = 0
let totalAliases = 0

for (const filePath of files.sort()) {
  const relPath = relative(join(__dirname, '..', '..'), filePath)
  const original = readFileSync(filePath, 'utf8')
  const { text: transformed, changes } = transformFile(filePath, original)

  if (changes.length === 0) continue

  totalModified++
  const renames = changes.filter(c => c.startsWith('rename:'))
  const types = changes.filter(c => c.startsWith('type:'))
  const labels = changes.filter(c => c.startsWith('label:') || c.startsWith('label+:') || c.startsWith('ui+:'))
  const aliases = changes.filter(c => c.startsWith('aliases:'))

  totalRenames += renames.length
  totalTypeFixes += types.length
  totalLabelFixes += labels.length
  totalAliases += aliases.length

  if (DRY_RUN) {
    console.log(`\n--- ${relPath} ---`)
    for (const c of changes) console.log(`  ${c}`)
  } else {
    writeFileSync(filePath, transformed, 'utf8')
    console.log(`${relPath}: ${changes.length} changes`)
  }
}

console.log(`\n=== Summary ===`)
console.log(`Files modified: ${totalModified}`)
console.log(`Renames applied: ${totalRenames}`)
console.log(`Type fixes: ${totalTypeFixes}`)
console.log(`Label fixes: ${totalLabelFixes}`)
console.log(`Alias additions: ${totalAliases}`)
if (DRY_RUN) console.log('\n(no files written -- dry run)')
