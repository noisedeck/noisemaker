#!/usr/bin/env node
/**
 * Playwright visual verification for the scene viewer.
 *
 * Launches a local server, opens demo/shaders/scenes/viewer.html for both
 * WebGL2 and WebGPU, takes screenshots, and verifies the scene actually
 * rendered — a scene that fails silently produces a flat frame, which is
 * exactly what this exists to catch.
 *
 * Requires system Chrome (channel: 'chrome') for float texture FBO support.
 * Set SHADE_HEADLESS=1 to run headless with a software GL backend instead,
 * matching the shade harness convention.
 *
 * Usage: node shaders/tests/test_visual_playwright.js
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '../..')

const HEADLESS = process.env.SHADE_HEADLESS === '1' || process.env.SHADE_HEADLESS === 'true'
const DEMO_ONLY = process.argv.includes('--demo-only')
const PLANAR_REFLECTION_ONLY = process.argv.includes('--planar-reflection-only')
  || process.argv.includes('--planar-contact-only')
const MATERIAL_BANDING_ONLY = process.argv.includes('--material-banding-only')
const SCENE_ANIMATION_ONLY = process.argv.includes('--scene-animation-only')

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.dsl': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const filePath = ROOT + req.url.split('?')[0]
      try {
        const data = await readFile(filePath)
        const ext = extname(filePath)
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

function screenshotStats(data) {
  const png = PNG.sync.read(data)
  const total = png.width * png.height
  let nonBlack = 0
  let sum = 0
  let sumSquares = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]
    const g = png.data[i + 1]
    const b = png.data[i + 2]
    const luminance = (r + g + b) / 3
    if (r > 5 || g > 5 || b > 5) nonBlack++
    sum += luminance
    sumSquares += luminance * luminance
  }
  const mean = sum / total
  const variance = Math.max(0, sumSquares / total - mean * mean)
  return {
    nonBlack,
    total,
    pct: Number(((nonBlack / total) * 100).toFixed(1)),
    luminanceStdDev: Number(Math.sqrt(variance).toFixed(2))
  }
}

async function testCase(browser, port, backend, scene) {
  const url = `http://127.0.0.1:${port}/demo/shaders/scenes/viewer.html?backend=${backend}&scene=${encodeURIComponent(scene)}`
  console.log(`\n--- Testing ${scene} on ${backend.toUpperCase()} ---`)

  const context = await browser.newContext({ viewport: { width: 800, height: 600 } })
  const page = await context.newPage()

  const errors = []
  page.on('pageerror', e => errors.push(e.message || String(e)))
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Wait for at least one render frame
    await page.waitForFunction(
      () => document.getElementById('info')?.dataset.ready === 'true'
        || Boolean(document.getElementById('error')?.textContent?.trim()),
      { timeout: 30000 }
    )

    await page.waitForTimeout(1500)

    const infoText = await page.$eval('#info', el => el.textContent)
    console.log(`  Info: ${infoText}`)

    // The viewer reports compile and fetch failures in its own error panel.
    const errorText = await page.$eval('#error', el => el.textContent).catch(() => '')
    if (errorText && errorText.trim()) {
      await context.close()
      return { scene, backend, status: 'fail', reason: errorText.trim().split('\n').slice(0, 3).join(' / ') }
    }

    // Save the canvas only. Scene-specific names keep one case from
    // overwriting another, and excluding the info overlay lets the pixel
    // statistics detect a genuinely flat render on WebGPU too.
    const sceneName = scene.replace(/\.dsl$/, '')
    const screenshotPath = resolve(ROOT, `demo/shaders/scenes/screenshot-${sceneName}-${backend}.png`)
    await page.$eval('#info', el => { el.style.display = 'none' })
    await page.locator('#canvas').screenshot({ path: screenshotPath })
    console.log(`  Screenshot saved`)

    const pixelStats = screenshotStats(await readFile(screenshotPath))

    console.log(`  Pixels:`, pixelStats)

    await context.close()

    if (pixelStats.pct < 1 || pixelStats.luminanceStdDev < 2) {
      return { scene, backend, status: 'fail', reason: 'Canvas is black or flat', screenshotPath, errors }
    }

    if (errors.length > 0) {
      return { scene, backend, status: 'fail', reason: errors.slice(0, 3).join(' / '), screenshotPath, errors }
    }

    return { scene, backend, status: 'pass', screenshotPath, pixelStats }

  } catch (e) {
    await context.close()
    return { scene, backend, status: 'error', reason: e.message }
  }
}

async function testMainDemoSceneProgram(browser, port) {
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html`
  console.log('\n--- Testing scene program in main demo ---')

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const errors = []

  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill([
      'search synth',
      'scene(',
      '  camera(pos: [0, 0, -4], target: [0, 0, 0]),',
      '  mesh("sphere")',
      ').write(o0)',
      'render(o0)'
    ].join('\n'))
    await page.getByRole('button', { name: 'run', exact: true }).click()

    await page.waitForFunction(() => {
      const status = document.getElementById('status')?.textContent || ''
      return status === 'compiled successfully' || status.startsWith('compilation failed:')
    }, { timeout: 15000 })
    const statusText = await page.locator('#status').textContent()
    const result = statusText === 'compiled successfully'
      ? { status: 'pass' }
      : { status: 'fail', reason: statusText }

    await context.close()
    if (result.status !== 'pass') {
      return { scene: 'main demo scene program', backend: 'webgl2', ...result, errors }
    }
    if (errors.length > 0) {
      return {
        scene: 'main demo scene program',
        backend: 'webgl2',
        status: 'fail',
        reason: errors.slice(0, 3).join(' / '),
        errors
      }
    }
    return { scene: 'main demo scene program', backend: 'webgl2', status: 'pass' }
  } catch (error) {
    await context.close()
    return {
      scene: 'main demo scene program',
      backend: 'webgl2',
      status: 'error',
      reason: [error.message, ...errors].filter(Boolean).join(' / '),
      errors
    }
  }
}

async function testFlatPlanarReflection(browser, port, backendName, shape = 'sphere') {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  const sceneName = `flat planar ${shape} reflection`
  const reflectedMesh = shape === 'box'
    ? '  mesh("box", size: [1.5, 1.5, 1.5], pos: [0, 0.75, 0])'
    : '  mesh("sphere", radius: 1, segments: 64, pos: [0, 1, 0])'
  console.log(`\n--- Testing ${sceneName} on ${backendName.toUpperCase()} ---`)

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const errors = []

  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill(`search synth
scene(
  background: [0.02, 0.02, 0.02],
  reflections: 1,
  camera(fov: 52, pos: [0, 3, -7], target: [0, 0.7, 0]),
  mesh("plane", width: 16, height: 16, pos: [0, 0, 0])
    .reflector()
    .material(solid(color: [0.25, 0.25, 0.25]).pbr(metallic: 1, roughness: 0.045)),
${reflectedMesh}
    .material(solid(color: [1, 1, 1]).emit(strength: 1))
).write(o0)
render(o0)`)
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'compiled successfully',
      { timeout: 15000 }
    )
    await page.waitForTimeout(500)

    const contact = await page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      const backend = renderer.sceneRenderer.backend
      const [pixels, lit, planar, planarNormalRoughness] = await Promise.all([
        backend.readPixels('scene_reflect_color'),
        backend.readPixels('scene_lit_color'),
        backend.readPixels('scene_planar_lit'),
        backend.readPixels('scene_planar_gbuf_normal_roughness')
      ])
      const x = Math.floor(pixels.width / 2)
      const redAt = (y) => pixels.data[(y * pixels.width + x) * 4]
      const maxRed = (image) => {
        let max = 0
        for (let i = 0; i < image.data.length; i += 4) {
          max = Math.max(max, image.data[i])
        }
        return max
      }

      let objectStart = -1
      let objectEnd = -1
      for (let y = 0; y < pixels.height; y++) {
        if (redAt(y) >= 240) {
          if (objectStart < 0) objectStart = y
        } else if (objectStart >= 0) {
          objectEnd = y - 1
          break
        }
      }

      let reflectionStart = -1
      let expectedRows = 0
      let missingRows = 0
      let interiorHoles = 0
      let maxEdgeError = 0
      let expectedPixels = 0
      let missingPixels = 0
      let downwardContactPixels = 0

      for (let offset = 0; offset < planarNormalRoughness.data.length; offset += 4) {
        const occupied = planarNormalRoughness.data[offset + 3] > 0
        const pointsDown = planarNormalRoughness.data[offset + 1] < 16
        if (occupied && pointsDown) downwardContactPixels++
      }

      for (let y = objectEnd + 1; y < pixels.height; y++) {
        let expectedLeft = pixels.width
        let expectedRight = -1
        let actualLeft = pixels.width
        let actualRight = -1

        for (let px = 0; px < pixels.width; px++) {
          const offset = (y * pixels.width + px) * 4
          // Below the tangent point this fixture contains only the planar
          // receiver. Its mirrored source must map onto the same pixels.
          const expected = planar.data[offset] >= 200
          const reflectedContribution = pixels.data[offset] - lit.data[offset]
          const actual = reflectedContribution >= 16

          if (expected) {
            expectedLeft = Math.min(expectedLeft, px)
            expectedRight = Math.max(expectedRight, px)
            expectedPixels++
            if (!actual) missingPixels++
          }
          if (actual) {
            actualLeft = Math.min(actualLeft, px)
            actualRight = Math.max(actualRight, px)
          }
        }

        if (expectedRight >= 0) {
          expectedRows++
          if (actualRight < 0) {
            missingRows++
            continue
          }
          if (reflectionStart < 0) reflectionStart = y
          maxEdgeError = Math.max(
            maxEdgeError,
            Math.abs(actualLeft - expectedLeft),
            Math.abs(actualRight - expectedRight)
          )
          for (let px = actualLeft; px <= actualRight; px++) {
            const offset = (y * pixels.width + px) * 4
            if (pixels.data[offset] - lit.data[offset] < 16) interiorHoles++
          }
        }
      }

      return {
        objectStart,
        objectEnd,
        reflectionStart,
        gap: reflectionStart - objectEnd - 1,
        expectedRows,
        missingRows,
        interiorHoles,
        maxEdgeError,
        expectedPixels,
        missingPixels,
        downwardContactPixels,
        activeBackend: renderer.backend,
        maxRed: {
          reflected: maxRed(pixels),
          lit: maxRed(lit),
          planar: maxRed(planar)
        }
      }
    })

    await context.close()
    if (contact.objectEnd < 0 || contact.reflectionStart < 0) {
      return {
        scene: sceneName,
        backend: backendName,
        status: 'fail',
        reason: `could not locate contact silhouettes: ${JSON.stringify(contact)}`,
        errors
      }
    }
    const missingRatio = contact.missingPixels / Math.max(contact.expectedPixels, 1)
    if (contact.gap !== 0
        || contact.missingRows !== 0
        || contact.interiorHoles !== 0
        || contact.maxEdgeError > 1
        || missingRatio > 0.005
        || (shape === 'box' && contact.downwardContactPixels !== 0)) {
      return {
        scene: sceneName,
        backend: backendName,
        status: 'fail',
        reason: `${contact.gap}px contact gap, ${contact.missingRows} missing rows, `
          + `${contact.interiorHoles} interior holes, ${contact.maxEdgeError}px max edge error, `
          + `${(missingRatio * 100).toFixed(2)}% missing planar pixels, `
          + `${contact.downwardContactPixels} coplanar downward-face pixels`,
        contact,
        errors
      }
    }
    if (errors.length > 0) {
      return {
        scene: sceneName,
        backend: backendName,
        status: 'fail',
        reason: errors.slice(0, 3).join(' / '),
        errors
      }
    }
    return {
      scene: sceneName,
      backend: backendName,
      status: 'pass',
      contact
    }
  } catch (error) {
    await context.close()
    return {
      scene: sceneName,
      backend: backendName,
      status: 'error',
      reason: [error.message, ...errors].filter(Boolean).join(' / '),
      errors
    }
  }
}

async function testRoughMaterialReflectionStability(browser, port, backendName) {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  console.log(`\n--- Testing rough material reflection stability on ${backendName.toUpperCase()} ---`)

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const errors = []

  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill(`search synth
scene(
  background: [0.02, 0.02, 0.02],
  reflections: 1,
  camera(fov: 52, pos: [0, 3, -7], target: [0, 0.7, 0]),
  light(type: "directional", dir: [0.6, -1, 0.4], intensity: 1.5),
  mesh("plane", width: 16, height: 16, pos: [0, 0, 0])
    .material(solid(color: [0.25, 0.25, 0.25]).pbr(metallic: 0.5, roughness: 0.35)),
  mesh("box", size: [1.5, 1.5, 1.5], pos: [0, 0.75, 0])
    .material(solid(color: [0.8, 0.2, 0.12]).pbr(metallic: 0.3, roughness: 0.35))
).write(o0)
render(o0)`)
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'compiled successfully',
      { timeout: 15000 }
    )
    await page.waitForTimeout(500)

    const readReflectionDelta = async () => page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      const backend = renderer.sceneRenderer.backend
      const [lit, reflected] = await Promise.all([
        backend.readPixels('scene_lit_color'),
        backend.readPixels('scene_reflect_color')
      ])
      let changedPixels = 0
      let maxChannelDelta = 0
      for (let i = 0; i < lit.data.length; i += 4) {
        const delta = Math.max(
          Math.abs(reflected.data[i] - lit.data[i]),
          Math.abs(reflected.data[i + 1] - lit.data[i + 1]),
          Math.abs(reflected.data[i + 2] - lit.data[i + 2])
        )
        if (delta > 1) changedPixels++
        maxChannelDelta = Math.max(maxChannelDelta, delta)
      }
      renderer.start()
      return { changedPixels, maxChannelDelta }
    })
    const roughComparison = await readReflectionDelta()

    const roughDsl = await page.getByRole('textbox').inputValue()
    await page.getByRole('textbox').fill(roughDsl.replaceAll('roughness: 0.35', 'roughness: 0.15'))
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'compiled successfully',
      { timeout: 15000 }
    )
    await page.waitForTimeout(500)
    const polishedComparison = await readReflectionDelta()

    await context.close()
    if (roughComparison.changedPixels > 0) {
      return {
        scene: 'rough material reflection stability',
        backend: backendName,
        status: 'fail',
        reason: `${roughComparison.changedPixels} unstable SSR pixels, max delta ${roughComparison.maxChannelDelta}`,
        roughComparison,
        polishedComparison,
        errors
      }
    }
    if (polishedComparison.changedPixels < 100) {
      return {
        scene: 'rough material reflection stability',
        backend: backendName,
        status: 'fail',
        reason: `polished SSR path inactive: ${polishedComparison.changedPixels} changed pixels`,
        roughComparison,
        polishedComparison,
        errors
      }
    }
    if (errors.length > 0) {
      return {
        scene: 'rough material reflection stability',
        backend: backendName,
        status: 'fail',
        reason: errors.slice(0, 3).join(' / '),
        errors
      }
    }
    return {
      scene: 'rough material reflection stability',
      backend: backendName,
      status: 'pass',
      roughComparison,
      polishedComparison
    }
  } catch (error) {
    await context.close()
    return {
      scene: 'rough material reflection stability',
      backend: backendName,
      status: 'error',
      reason: [error.message, ...errors].filter(Boolean).join(' / '),
      errors
    }
  }
}

async function testRoughMetalEnvironmentLighting(browser, port, backendName) {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  console.log(`\n--- Testing rough-metal environment lighting on ${backendName.toUpperCase()} ---`)

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const errors = []

  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill(`search filter, synth
gradient(color1: [0.5, 0.65, 0.95], color2: [0.14, 0.1, 0.2], colorCount: 2).write(o3)
scene(
  background: [0.015, 0.02, 0.04],
  exposure: 1.25,
  reflections: 0,
  camera(fov: 52, pos: [0, 0, -5], target: [0, 0, 0]),
  environment(o3, intensity: 0.55),
  mesh("sphere", radius: 1.3, segments: 128)
    .material(solid(color: [0.75, 0.55, 0.3]).pbr(metallic: 0.95, roughness: 0.78))
).write(o0)
render(o0)`)
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'compiled successfully',
      { timeout: 15000 }
    )
    await page.waitForTimeout(500)

    const metrics = await page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      const backend = renderer.sceneRenderer.backend
      const [lit, normalRoughness] = await Promise.all([
        backend.readPixels('scene_lit_color'),
        backend.readPixels('scene_gbuf_normal_roughness')
      ])
      const width = lit.width
      const height = lit.height
      const luminance = new Float32Array(width * height)
      const occupied = new Uint8Array(width * height)
      let luminanceSum = 0
      let occupiedPixels = 0

      for (let pixel = 0; pixel < width * height; pixel++) {
        const offset = pixel * 4
        if (normalRoughness.data[offset + 3] < 128) continue
        const value = lit.data[offset] * 0.2126
          + lit.data[offset + 1] * 0.7152
          + lit.data[offset + 2] * 0.0722
        occupied[pixel] = 1
        luminance[pixel] = value
        luminanceSum += value
        occupiedPixels++
      }

      const curvature = []
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const center = y * width + x
          const neighbors = [
            center - 2,
            center - 1,
            center + 1,
            center + 2,
            center - width * 2,
            center - width,
            center + width,
            center + width * 2
          ]
          if (!occupied[center] || neighbors.some(pixel => !occupied[pixel])) continue
          const horizontal = Math.abs(
            luminance[center - 2] - 4 * luminance[center - 1]
            + 6 * luminance[center] - 4 * luminance[center + 1]
            + luminance[center + 2]
          )
          const vertical = Math.abs(
            luminance[center - width * 2] - 4 * luminance[center - width]
            + 6 * luminance[center] - 4 * luminance[center + width]
            + luminance[center + width * 2]
          )
          curvature.push(Math.max(horizontal, vertical))
        }
      }
      curvature.sort((a, b) => a - b)
      return {
        activeBackend: renderer.backend,
        occupiedPixels,
        averageLuminance: luminanceSum / Math.max(occupiedPixels, 1),
        curvatureP995: curvature[Math.floor(curvature.length * 0.995)] || 0,
        curvatureMax: curvature[curvature.length - 1] || 0
      }
    })

    await context.close()
    if (metrics.occupiedPixels < 1000 || metrics.averageLuminance < 20) {
      return {
        scene: 'rough-metal environment lighting',
        backend: backendName,
        status: 'fail',
        reason: `metallic environment response is missing or too dark: ${JSON.stringify(metrics)}`,
        metrics,
        errors
      }
    }
    if (metrics.curvatureP995 > 10) {
      return {
        scene: 'rough-metal environment lighting',
        backend: backendName,
        status: 'fail',
        reason: `visible rough-metal banding: ${JSON.stringify(metrics)}`,
        metrics,
        errors
      }
    }
    if (errors.length > 0) {
      return {
        scene: 'rough-metal environment lighting',
        backend: backendName,
        status: 'fail',
        reason: errors.slice(0, 3).join(' / '),
        metrics,
        errors
      }
    }
    return {
      scene: 'rough-metal environment lighting',
      backend: backendName,
      status: 'pass',
      metrics
    }
  } catch (error) {
    await context.close()
    return {
      scene: 'rough-metal environment lighting',
      backend: backendName,
      status: 'error',
      reason: [error.message, ...errors].filter(Boolean).join(' / '),
      errors
    }
  }
}

async function testMaterialsLabOscillatorAnimation(browser, port) {
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=glsl`
  console.log('\n--- Testing Materials Lab osc() animation ---')

  const context = await browser.newContext({ viewport: { width: 1024, height: 1024 } })
  const page = await context.newPage()
  const errors = []

  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    const dsl = await readFile(resolve(ROOT, 'demo/shaders/scenes/materials-lab.dsl'), 'utf8')
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill(dsl)
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => {
        const status = document.getElementById('status')?.textContent || ''
        return status === 'compiled successfully' || status.startsWith('compilation failed:')
      },
      { timeout: 15000 }
    )
    const statusText = await page.locator('#status').textContent()
    if (statusText !== 'compiled successfully') {
      await context.close()
      return {
        scene: 'Materials Lab osc() animation',
        backend: 'webgl2',
        status: 'fail',
        reason: statusText
      }
    }

    const rotation = await page.evaluate(() => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      renderer._clock.reset()
      renderer.render(0)
      const spinner = renderer._sceneTree.getById('spinner')
      const sceneMeshes = renderer._sceneTree.getMeshNodes()
        .filter(mesh => !mesh.planarReflection)
      const ungroupedMeshes = sceneMeshes
        .filter(mesh => mesh.parent !== spinner)
        .map(mesh => mesh.meshType)
      const start = spinner.rotation[1]
      renderer.render(0.25)
      const quarterLoop = spinner.rotation[1]
      return {
        start,
        quarterLoop,
        spinnerMeshCount: sceneMeshes.length - ungroupedMeshes.length,
        ungroupedMeshes
      }
    })
    await context.close()

    if (Math.abs(rotation.start) > 0.001
        || Math.abs(rotation.quarterLoop - 90) > 0.001
        || rotation.ungroupedMeshes.length > 0) {
      return {
        scene: 'Materials Lab osc() animation',
        backend: 'webgl2',
        status: 'fail',
        reason: `spinner did not follow canonical loop time: ${JSON.stringify(rotation)}`,
        rotation,
        errors
      }
    }
    if (errors.length > 0) {
      return {
        scene: 'Materials Lab osc() animation',
        backend: 'webgl2',
        status: 'fail',
        reason: errors.slice(0, 3).join(' / '),
        rotation,
        errors
      }
    }
    return {
      scene: 'Materials Lab osc() animation',
      backend: 'webgl2',
      status: 'pass',
      rotation
    }
  } catch (error) {
    await context.close()
    return {
      scene: 'Materials Lab osc() animation',
      backend: 'webgl2',
      status: 'error',
      reason: [error.message, ...errors].filter(Boolean).join(' / '),
      errors
    }
  }
}

async function main() {
  const { server, port } = await startServer()
  console.log(`Server on port ${port}`)

  const browser = await chromium.launch(HEADLESS
    ? {
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu']
      }
    : {
        channel: 'chrome',
        headless: false,
        args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan']
      })

  const results = []
  if (SCENE_ANIMATION_ONLY) {
    results.push(await testMaterialsLabOscillatorAnimation(browser, port))
  } else if (MATERIAL_BANDING_ONLY) {
    results.push(await testRoughMaterialReflectionStability(browser, port, 'webgl2'))
    results.push(await testRoughMaterialReflectionStability(browser, port, 'webgpu'))
    results.push(await testRoughMetalEnvironmentLighting(browser, port, 'webgl2'))
    results.push(await testRoughMetalEnvironmentLighting(browser, port, 'webgpu'))
  } else if (PLANAR_REFLECTION_ONLY) {
    results.push(await testFlatPlanarReflection(browser, port, 'webgl2'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgpu'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgl2', 'box'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgpu', 'box'))
  } else {
    results.push(await testMainDemoSceneProgram(browser, port))
    results.push(await testMaterialsLabOscillatorAnimation(browser, port))
    results.push(await testFlatPlanarReflection(browser, port, 'webgl2'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgpu'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgl2', 'box'))
    results.push(await testFlatPlanarReflection(browser, port, 'webgpu', 'box'))
    results.push(await testRoughMaterialReflectionStability(browser, port, 'webgl2'))
    results.push(await testRoughMaterialReflectionStability(browser, port, 'webgpu'))
    results.push(await testRoughMetalEnvironmentLighting(browser, port, 'webgl2'))
    results.push(await testRoughMetalEnvironmentLighting(browser, port, 'webgpu'))
  }
  if (!DEMO_ONLY && !PLANAR_REFLECTION_ONLY && !MATERIAL_BANDING_ONLY && !SCENE_ANIMATION_ONLY) {
    const scenes = ['hello-engine.dsl', 'materials-lab.dsl']
    const backends = ['webgl2', 'webgpu']
    for (const scene of scenes) {
      for (const backend of backends) {
        results.push(await testCase(browser, port, backend, scene))
      }
    }
  }

  await browser.close()
  server.close()

  console.log('\n=== RESULTS ===')
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : 'FAIL'
    console.log(`  [${icon}] ${r.scene} / ${r.backend}: ${r.reason || 'OK'}`)
  }

  const failures = results.filter(result => result.status !== 'pass')
  if (failures.length > 0) {
    console.error(`\n${failures.length} scene/backend case(s) failed.`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
