/**
 * Docs static-asset path contract.
 *
 * docs.noisemaker.app is built with `sphinx-build -b dirhtml`, so every
 * page except index lands one directory deep: composer-api.rst is served
 * as /composer-api/, not /composer-api.html.
 *
 * Sphinx rewrites the assets it owns (html_js_files, html_css_files) per
 * page depth, emitting ../_static/... where needed. It does NOT touch the
 * contents of a `.. raw:: html` block, and it has no idea what a runtime
 * fetch inside docs/_static/*.js is going to ask for. Any '_static/...'
 * written by hand in those two places is resolved by the browser against
 * the page URL, so on /composer-api/ it becomes /composer-api/_static/...
 * and 404s.
 *
 * The contract, therefore: hand-written _static references are
 * root-absolute ('/_static/...'), which resolves identically at every
 * page depth, and they point at a file that exists.
 */

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const docsDir = path.join(repoRoot, 'docs')
const staticDir = path.join(docsDir, '_static')

/** Directories that hold build output rather than source. */
const IGNORED_DIRS = new Set(['_build', '__pycache__', 'node_modules'])

function walk(dir, predicate, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), predicate, found)
      }
    } else if (predicate(entry.name)) {
      found.push(path.join(dir, entry.name))
    }
  }
  return found
}

/** Report a repo-relative path, so failures name a file you can open. */
function rel(file) {
  return path.relative(repoRoot, file)
}

/** Resolve a '/_static/foo.js?v=1' reference to its file on disk. */
function staticFileFor(reference) {
  const withoutQuery = reference.split(/[?#]/)[0]
  return path.join(staticDir, withoutQuery.replace(/^\/?_static\//, ''))
}

/**
 * src="..." / href="..." attribute values that mention _static, as written
 * in a `.. raw:: html` block. Sphinx passes these through verbatim.
 */
function rawHtmlAssetRefs(source) {
  const refs = []
  const attr = /\b(?:src|href)\s*=\s*(["'])([^"']*_static\/[^"']*)\1/g
  let match
  while ((match = attr.exec(source)) !== null) {
    refs.push(match[2])
  }
  return refs
}

/**
 * Drop block comments and whole-line // comments, so prose describing the
 * wrong form does not read as a use of it. Deliberately leaves trailing
 * comments alone rather than risk cutting into a string literal.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * String literals that mention _static inside a docs script. These are URLs
 * the script hands to the browser at runtime, resolved against the page.
 */
function scriptAssetRefs(source) {
  const refs = []
  const literal = /(["'])([^"'\n]*_static\/[^"'\n]*)\1/g
  let match
  while ((match = literal.exec(stripComments(source))) !== null) {
    refs.push(match[2])
  }
  return refs
}

const rstFiles = walk(docsDir, (name) => name.endsWith('.rst'))
const scriptFiles = fs.existsSync(staticDir)
  ? walk(staticDir, (name) => name.endsWith('.js') && !name.endsWith('.min.js'))
  : []

test('docs sources exist to check', () => {
  assert.ok(rstFiles.length > 0, `no .rst files found under ${rel(docsDir)}`)
  assert.ok(scriptFiles.length > 0, `no scripts found under ${rel(staticDir)}`)
})

test('raw-HTML _static references are root-absolute', () => {
  const offenders = []
  for (const file of rstFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const ref of rawHtmlAssetRefs(source)) {
      if (!ref.startsWith('/_static/')) {
        offenders.push(`${rel(file)}: ${ref}`)
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'These resolve against the page URL, so under the dirhtml builder they ' +
      '404 on every page below the root. Write them as /_static/...:\n  ' +
      offenders.join('\n  ')
  )
})

test('runtime _static references in docs scripts are root-absolute', () => {
  const offenders = []
  for (const file of scriptFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const ref of scriptAssetRefs(source)) {
      if (!ref.startsWith('/_static/')) {
        offenders.push(`${rel(file)}: ${ref}`)
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'A docs script resolves these against the page that loaded it, not ' +
      'against itself. Write them as /_static/...:\n  ' + offenders.join('\n  ')
  )
})

/**
 * Assets build-docs.sh drops into _static, plus the alternate bundle names
 * the viewers probe for as a fallback. None of these are in a clean
 * checkout, so their absence says nothing about whether a reference is
 * correct. Everything else is checked in and must be there.
 */
const GENERATED_ASSETS = new Set([
  'noisemaker.min.js',
  'noisemaker.bundle.js',
  'noisemaker.umd.js',
  'noisemaker.js',
  'noisemaker-shaders-core.min.js'
])

test('every referenced _static asset exists', () => {
  const missing = []
  for (const file of [...rstFiles, ...scriptFiles]) {
    const source = fs.readFileSync(file, 'utf8')
    const refs = file.endsWith('.rst')
      ? rawHtmlAssetRefs(source)
      : scriptAssetRefs(source)
    for (const ref of refs) {
      const target = staticFileFor(ref)
      if (GENERATED_ASSETS.has(path.basename(target))) continue
      if (!fs.existsSync(target)) {
        missing.push(`${rel(file)}: ${ref} -> ${rel(target)}`)
      }
    }
  }
  assert.deepStrictEqual(missing, [], `missing:\n  ${missing.join('\n  ')}`)
})
