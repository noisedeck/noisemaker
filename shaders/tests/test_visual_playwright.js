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
import { readFile, mkdir } from 'node:fs/promises'
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
const CROSS_BACKEND_ONLY = process.argv.includes('--cross-backend-only')
const VOLUME_ONLY = process.argv.includes('--volume-only')

/**
 * Cross-backend maxDelta ceiling for the volume scene's lit colour.
 *
 * Measured 7 over 0.0026% of channels. The marcher itself contributes nothing:
 * diffing the four G-buffer targets directly (allowing for the MRT readback's
 * row-order difference — WebGL2's readPixels flips rows, the WGSL vertex stage
 * having already flipped clip Y) gives maxDelta 0 on albedo, position and
 * depth, and 1 on 0.00005% of the normal buffer. The residual is the same SSAO
 * effect the mesh case documents: samples crossing the hard
 * `gbufDist < sampleDist - 0.02` occlusion test land on either side depending
 * on float reassociation between the two shader compilers, quantising AO by one
 * twelfth of the kernel. The mesh case's own ceiling stays at 6.
 */
const VOLUME_PARITY_CEILING = 8

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
    // Test output, not a fixture: writing into demo/shaders/scenes/ overwrote the
    // committed reference screenshots on every run and left the tree dirty.
    const artifactDir = resolve(ROOT, 'shaders/tests/.artifacts/scene-visual')
    await mkdir(artifactDir, { recursive: true })
    const screenshotPath = resolve(artifactDir, `screenshot-${sceneName}-${backend}.png`)
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

    const rotation = await page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      renderer._clock.reset()
      // render() is awaited: the scene must finish drawing before the pipeline
      // reads its texture, so animation bindings are applied inside that
      // promise rather than synchronously on the way in.
      await renderer.render(0)
      const spinner = renderer._sceneTree.getById('spinner')
      const sceneMeshes = renderer._sceneTree.getMeshNodes()
        .filter(mesh => !mesh.planarReflection)
      const ungroupedMeshes = sceneMeshes
        .filter(mesh => mesh.parent !== spinner)
        .map(mesh => mesh.meshType)
      const start = spinner.rotation[1]
      await renderer.render(0.25)
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

/**
 * Render one fixed scene on both backends and compare the lit colour buffer.
 *
 * The scene work claimed bit-identical output between WebGL2 and WebGPU, but
 * nothing compared them: every other case runs one backend at a time and
 * asserts only that the canvas is not flat. This reads scene_lit_color from
 * both and reports the real delta.
 */
const CROSS_BACKEND_SCENE = `search synth
scene(
  background: [0.02, 0.02, 0.03],
  ambient: 0.2,
  camera(fov: 55, pos: [0, 2.5, -6], target: [0, 0.5, 0]),
  light(type: "directional", dir: [1, -1, 1], intensity: 2),
  mesh("sphere", radius: 1.2, segments: 48, pos: [-1.4, 1, 0])
    .material(solid(color: [0.9, 0.3, 0.2]).pbr(metallic: 0.1, roughness: 0.5)),
  mesh("box", size: [1.4, 1.4, 1.4], pos: [1.4, 0.7, 0])
    .material(solid(color: [0.2, 0.5, 0.9]).pbr(metallic: 0.8, roughness: 0.3)),
  mesh("plane", width: 12, height: 12)
    .material(solid(color: [0.35, 0.35, 0.35]).pbr(metallic: 0, roughness: 0.9))
).write(o0)
render(o0)`

async function litColorFor(browser, port, backendName) {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
    await page.getByRole('textbox').fill(CROSS_BACKEND_SCENE)
    await page.getByRole('button', { name: 'run', exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'compiled successfully',
      { timeout: 15000 }
    )
    await page.waitForTimeout(500)
    return await page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      // Reset the clock first: u_time reaches the scene passes through
      // frameState, so an unreset clock makes "a fixed time" depend on how
      // long the page happened to run before this point.
      renderer._clock?.reset()
      // A fixed time so both backends render the same frame.
      await renderer.render(0.25)
      const image = await renderer.sceneRenderer.backend.readPixels('scene_lit_color')
      return { width: image.width, height: image.height, data: Array.from(image.data) }
    })
  } finally {
    await context.close()
  }
}

async function testCrossBackendParity(browser, port) {
  const sceneName = 'cross-backend lit colour parity'
  console.log(`\n--- Testing ${sceneName} ---`)
  const [a, b] = [await litColorFor(browser, port, 'webgl2'), await litColorFor(browser, port, 'webgpu')]

  if (a.width !== b.width || a.height !== b.height) {
    return [{ scene: sceneName, backend: 'both', status: 'fail',
      reason: `size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}` }]
  }

  let maxDelta = 0
  let differing = 0
  for (let i = 0; i < a.data.length; i++) {
    const delta = Math.abs(a.data[i] - b.data[i])
    if (delta > 0) differing++
    if (delta > maxDelta) maxDelta = delta
  }
  const pct = (differing / a.data.length) * 100
  console.log(`  Cross-backend: maxDelta=${maxDelta} differing=${pct.toFixed(4)}%`)

  // This is a ceiling, not a parity assertion. Measured maxDelta 4 over
  // 0.0004% of channels on this scene (16 channels of 4.19M) — down from 35
  // over 14.5% once the WGSL lighting shader stopped sampling the SSAO buffer
  // upside down and the WGSL SSAO shader stopped mirroring its noise rotation.
  // The G-buffer itself is bit-identical across backends. What is left is one
  // SSAO sample crossing the hard `gbufDist < sampleDist - 0.02` occlusion
  // threshold on 13 pixels: float reassociation between the two shader
  // compilers moves the comparison across the edge, which quantises AO by one
  // twelfth of the kernel and shows up as <=4/255 in the ambient term. That is
  // irreducible without softening the occlusion test itself.
  const CEILING = 6
  const withinCeiling = maxDelta <= CEILING
  return [{
    scene: sceneName,
    backend: 'webgl2-vs-webgpu',
    status: withinCeiling ? 'pass' : 'fail',
    reason: `maxDelta=${maxDelta} over ${pct.toFixed(4)}% of channels (ceiling ${CEILING}; not bit-identical)`
  }]
}

/**
 * A volume() node in the scene graph, half-buried in a ground plane.
 *
 * Deliberately deterministic: noise3d at speed 0 has no time term, so the atlas
 * is the same on every frame and on both backends.
 *
 * The geometry is chosen to make the depth compositing test discriminating. The
 * camera looks steeply down, so a ray that hits the isosurface in the volume's
 * upper half leaves the bounding box through its BOTTOM face — below the ground
 * plane, and therefore behind it. The box's back face (the fragment the
 * rasterizer produces, since the pass culls front faces) loses the depth test
 * against the plane; only the marched hit distance, written to gl_FragDepth /
 * @builtin(frag_depth), wins it. A volume drawn at its box depth would be
 * swallowed whole by the plane.
 *
 * Albedo does the identifying: the plane is blue, the volume red, so RT0 says
 * outright which surface won each pixel.
 * @param {number} volumeY - Height of the volume's centre. 0 buries the lower
 *   half in the plane; 1.05 lifts the whole box clear of it.
 */
function volumeScene(volumeY) {
  return `search synth3d
noise3d(speed: 0, seed: 4, scale: 3).write3d(vol0, geo0)
scene(
  background: [0.02, 0.02, 0.03],
  ambient: 0.25,
  camera(fov: 55, pos: [0, 4, -1.6], target: [0, 0, 0]),
  light(type: "directional", dir: [0.4, -1, 0.6], intensity: 2.2),
  mesh("plane", width: 12, height: 12)
    .material(solid(color: [0.05, 0.1, 0.9]).pbr(metallic: 0, roughness: 0.9)),
  volume(vol0, threshold: 0.5, pos: [0, ${volumeY}, 0])
    .material(solid(color: [0.95, 0.15, 0.05]).pbr(metallic: 0, roughness: 0.6))
).write(o0)
render(o0)`
}

/**
 * Count red (volume) vs blue (plane) fragments in the G-buffer albedo target.
 *
 * Counts, not per-pixel comparisons: the MRT targets read back with opposite
 * row order on the two backends (WebGL2's readPixels flips rows, and the WGSL
 * vertex stage has already flipped clip Y so the buffers themselves agree), so
 * a positional diff of these targets would compare mirrored images. A census is
 * orientation-independent and still catches a volume that failed to draw.
 */
async function volumeAlbedoCensus(page) {
  return page.evaluate(async () => {
    const renderer = window.__noisemakerCanvasRenderer
    const albedo = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_albedo_metallic')
    const depth = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_depth')
    let volume = 0
    let plane = 0
    let sky = 0
    for (let pixel = 0; pixel < albedo.width * albedo.height; pixel++) {
      const offset = pixel * 4
      // depth == 0 is the no-hit sentinel every downstream pass reads as sky.
      if (depth.data[offset] === 0) { sky++; continue }
      const r = albedo.data[offset]
      const b = albedo.data[offset + 2]
      if (r > b) volume++
      else if (b > r) plane++
    }
    return { volume, plane, sky, total: albedo.width * albedo.height }
  })
}

async function loadVolumeScene(page, volumeY) {
  // 'Edit DSL program' toggles the editor, so opening it a second time closes
  // it and every later fill() waits forever on a hidden textbox.
  if (!(await page.getByRole('textbox').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
  }
  await page.getByRole('textbox').fill(volumeScene(volumeY))
  await page.getByRole('button', { name: 'run', exact: true }).click()
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'compiled successfully',
    { timeout: 20000 }
  )
  // The scene renders BEFORE the pipeline each tick, so the atlas it binds is
  // the previous frame's write side. A couple of frames must elapse before
  // global_vol0 holds anything at all.
  await page.waitForTimeout(700)
}

async function testVolumeScene(browser, port, backendName) {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  const sceneName = 'volume() in the scene G-buffer'
  console.log(`\n--- Testing ${sceneName} on ${backendName.toUpperCase()} ---`)

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message || String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })

  const fail = (reason, metrics) => ({ scene: sceneName, backend: backendName, status: 'fail', reason, metrics, errors })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })

    await loadVolumeScene(page, 0)
    const buried = await volumeAlbedoCensus(page)
    await loadVolumeScene(page, 1.05)
    const raised = await volumeAlbedoCensus(page)
    const metrics = { buried, raised }
    console.log(`  buried=${JSON.stringify(buried)}\n  raised=${JSON.stringify(raised)}`)

    await context.close()

    // Non-flat: the marcher found an isosurface and it survived compositing
    // against the plane behind it.
    if (buried.volume < buried.total * 0.01) {
      return fail(`the volume produced almost no G-buffer coverage: ${JSON.stringify(buried)}`, metrics)
    }
    if (buried.plane < buried.total * 0.2) {
      return fail(`the ground plane is missing: ${JSON.stringify(buried)}`, metrics)
    }
    // ...and the plane genuinely occludes the half of the volume beneath it:
    // lifting the box clear of the plane must expose materially more of it.
    if (raised.volume < buried.volume * 1.2) {
      return fail(
        `the plane does not occlude the buried half: buried=${buried.volume} raised=${raised.volume}`,
        metrics
      )
    }
    if (errors.length > 0) {
      return { scene: sceneName, backend: backendName, status: 'fail', reason: errors.slice(0, 3).join(' / '), metrics, errors }
    }
    return { scene: sceneName, backend: backendName, status: 'pass', metrics }
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

async function volumeLitColorFor(browser, port, backendName) {
  const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
  const url = `http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
    await loadVolumeScene(page, 0)
    return await page.evaluate(async () => {
      const renderer = window.__noisemakerCanvasRenderer
      renderer.stop()
      renderer._clock?.reset()
      await renderer.render(0.25)
      const image = await renderer.sceneRenderer.backend.readPixels('scene_lit_color')
      return { width: image.width, height: image.height, data: Array.from(image.data) }
    })
  } finally {
    await context.close()
  }
}

/**
 * Cross-backend gate for the volume marcher.
 *
 * The volume fill is a hand-written GLSL/WGSL pair and lives under
 * shaders/src/rendering/, outside the per-effect parity attestation harness.
 * This is its parity gate: without it the pair would be the only shader pair in
 * the repo with none.
 */
async function testVolumeCrossBackendParity(browser, port) {
  const sceneName = 'volume cross-backend lit colour parity'
  console.log(`\n--- Testing ${sceneName} ---`)
  const [a, b] = [
    await volumeLitColorFor(browser, port, 'webgl2'),
    await volumeLitColorFor(browser, port, 'webgpu')
  ]

  if (a.width !== b.width || a.height !== b.height) {
    return { scene: sceneName, backend: 'both', status: 'fail',
      reason: `size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }

  let maxDelta = 0
  let differing = 0
  for (let i = 0; i < a.data.length; i++) {
    const delta = Math.abs(a.data[i] - b.data[i])
    if (delta > 0) differing++
    if (delta > maxDelta) maxDelta = delta
  }
  const pct = (differing / a.data.length) * 100
  console.log(`  Volume cross-backend: maxDelta=${maxDelta} differing=${pct.toFixed(4)}%`)

  // A ceiling, not a parity assertion, and its own — separate from the mesh
  // case's, which stays at 6. A raymarched isosurface amplifies float
  // reassociation between the two shader compilers: the bisection converges on
  // a slightly different t, which moves the hit point, its central-difference
  // normal and therefore its shading. The ceiling is set from the measured
  // value; see the report accompanying this change.
  const CEILING = VOLUME_PARITY_CEILING
  const withinCeiling = maxDelta <= CEILING
  return {
    scene: sceneName,
    backend: 'webgl2-vs-webgpu',
    status: withinCeiling ? 'pass' : 'fail',
    reason: `maxDelta=${maxDelta} over ${pct.toFixed(4)}% of channels (ceiling ${CEILING}; not bit-identical)`
  }
}

/**
 * A volume body that encloses the camera, with a legitimately-visible mesh
 * behind it.
 *
 * The camera sits at z 0.5 inside a 2x2x2 volume spanning [-1,1]^3, so every
 * marched hit is within ~2.06 units (the far corner) and almost all of them are
 * nearer than the 1.5 near plane. The sphere at z -4 is 3.5 units away and
 * plainly in front of nothing.
 *
 * A mesh of the volume's extent would be near-clipped by the rasterizer and the
 * sphere would show through. The marcher has no rasterizer to do that for it:
 * clamping such a hit's window depth pins it to the front of the depth range,
 * where it beats every real surface. Sphere blue, volume red, so the albedo
 * target says outright which won.
 * @param {number} near - Camera near plane. 1.5 puts the volume inside it;
 *   0.01 is the control, where the volume legitimately occludes the sphere.
 */
function nearPlaneVolumeScene(near) {
  return `search synth3d
noise3d(speed: 0, seed: 4, scale: 3).write3d(vol0, geo0)
scene(
  background: [0.02, 0.02, 0.03],
  ambient: 0.25,
  camera(fov: 55, near: ${near}, pos: [0, 0, 0.5], target: [0, 0, -1]),
  light(type: "directional", dir: [0.4, -1, 0.6], intensity: 2.2),
  mesh("sphere", radius: 1, pos: [0, 0, -4])
    .material(solid(color: [0.05, 0.1, 0.9]).pbr(metallic: 0, roughness: 0.9)),
  volume(vol0, threshold: 0.5, pos: [0, 0, 0])
    .material(solid(color: [0.95, 0.15, 0.05]).pbr(metallic: 0, roughness: 0.6))
).write(o0)
render(o0)`
}

async function loadSceneSource(page, source) {
  if (!(await page.getByRole('textbox').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Edit DSL program' }).click()
  }
  await page.getByRole('textbox').fill(source)
  await page.getByRole('button', { name: 'run', exact: true }).click()
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'compiled successfully',
    { timeout: 20000 }
  )
  // The scene renders BEFORE the pipeline each tick, so global_vol0 needs a
  // couple of frames before it holds anything at all.
  await page.waitForTimeout(700)
}

/**
 * Fraction of covered pixels won by the volume (red) and by the mesh (blue).
 *
 * A census, not a positional diff: the MRT targets read back with opposite row
 * order on the two backends.
 */
async function nearPlaneCensus(page) {
  return page.evaluate(async () => {
    const renderer = window.__noisemakerCanvasRenderer
    const albedo = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_albedo_metallic')
    const depth = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_depth')
    let volume = 0
    let mesh = 0
    let sky = 0
    const total = albedo.width * albedo.height
    for (let pixel = 0; pixel < total; pixel++) {
      const offset = pixel * 4
      if (depth.data[offset] === 0) { sky++; continue }
      if (albedo.data[offset] > albedo.data[offset + 2]) volume++
      else if (albedo.data[offset + 2] > albedo.data[offset]) mesh++
    }
    return { volume, mesh, sky, total }
  })
}

/**
 * F1: a volume hit inside the near plane must be discarded, not clamped.
 *
 * Measured on both backends in one case, because the finding is precisely that
 * the two must agree — and that they must agree with what the rasterizer does
 * to a mesh of the same extent.
 *
 * The near 0.01 control is what keeps the near 1.5 assertion from passing
 * vacuously: it proves the volume really does cover the screen from inside, so
 * "the sphere is visible at near 1.5" can only mean the near-plane reject fired.
 */
async function testVolumeNearPlaneReject(browser, port) {
  const sceneName = 'volume hits inside the near plane are rejected'
  console.log(`\n--- Testing ${sceneName} ---`)

  const measure = async (backendName) => {
    const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(`http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
      await loadSceneSource(page, nearPlaneVolumeScene(0.01))
      const enclosing = await nearPlaneCensus(page)
      await loadSceneSource(page, nearPlaneVolumeScene(1.5))
      const clipped = await nearPlaneCensus(page)
      return { enclosing, clipped }
    } finally {
      await context.close()
    }
  }

  const results = {}
  for (const backendName of ['webgl2', 'webgpu']) {
    results[backendName] = await measure(backendName)
    const { enclosing, clipped } = results[backendName]
    console.log(`  ${backendName}: near0.01=${JSON.stringify(enclosing)}`)
    console.log(`  ${backendName}: near1.5 =${JSON.stringify(clipped)}`)
  }

  const fail = (reason) => ({ scene: sceneName, backend: 'webgl2+webgpu', status: 'fail', reason, metrics: results })

  for (const backendName of ['webgl2', 'webgpu']) {
    const { enclosing, clipped } = results[backendName]
    // Control: with the near plane out of the way the volume genuinely owns
    // the screen, so the sphere behind it is hidden.
    if (enclosing.volume < enclosing.total * 0.5) {
      return fail(`${backendName}: the enclosing volume does not cover the screen at near 0.01: ${JSON.stringify(enclosing)}`)
    }
    if (enclosing.mesh > enclosing.total * 0.02) {
      return fail(`${backendName}: the sphere should be occluded at near 0.01: ${JSON.stringify(enclosing)}`)
    }
    // The finding: at near 1.5 the volume is inside the near plane and must
    // stop occluding. The sphere subtends roughly 85% of the frame height, so
    // 5% coverage is a floor with a lot of room under it.
    if (clipped.mesh < clipped.total * 0.05) {
      return fail(`${backendName}: the sphere is hidden by a volume inside the near plane: ${JSON.stringify(clipped)}`)
    }
  }

  // And the two backends must reach the same answer, not merely each pass.
  const a = results.webgl2.clipped
  const b = results.webgpu.clipped
  const spread = Math.abs(a.mesh - b.mesh) / a.total
  console.log(`  cross-backend sphere coverage spread: ${(spread * 100).toFixed(3)}%`)
  if (spread > 0.02) {
    return fail(`backends disagree on sphere coverage by ${(spread * 100).toFixed(2)}% of the frame`)
  }

  return { scene: sceneName, backend: 'webgl2+webgpu', status: 'pass', metrics: results }
}

/**
 * A centred, radially symmetric volume with nothing else in the scene.
 *
 * shape3d's sphere field is a function of |p - centre| only, and at speedA /
 * speedB 0 it has no time term, so the isosurface is a set of concentric shells
 * centred on the volume's own centre — on BOTH backends, on every frame.
 *
 * That centre is the whole point. shape3d normalizes its grid as
 * `vec3(x,y,z) / (volumeSize - 1)`, putting the field's centre at texel index
 * 31.5 of 64; the marcher's `uvw * (volSizeF - 1.0)` maps local 0 to exactly
 * 31.5 too. The two conventions agree, and the silhouette is centred because
 * they do. Under `uvw * volSizeF` local 0 would land on index 32 instead — half
 * a texel, which is 1/63 of the body and several pixels on screen.
 */
const CENTRED_VOLUME_SCENE = `search synth3d
shape3d(loopAOffset: sphere, loopBOffset: sphere, speedA: 0, speedB: 0)
  .write3d(vol0, geo0)
scene(
  background: [0, 0, 0],
  ambient: 0.5,
  camera(fov: 45, pos: [0, 0, 5], target: [0, 0, 0]),
  light(type: "directional", dir: [0, -1, -0.5], intensity: 2),
  volume(vol0, threshold: 0.5, pos: [0, 0, 0])
    .material(solid(color: [0.9, 0.9, 0.9]).pbr(metallic: 0, roughness: 0.8))
).write(o0)
render(o0)`

/**
 * Centroid and bounding box of everything the volume covered, in pixels.
 *
 * Read from the depth target, where 0 is the no-hit sentinel. The scene holds
 * nothing else, so every covered pixel is the volume's.
 */
async function volumeSilhouette(page) {
  return page.evaluate(async () => {
    const renderer = window.__noisemakerCanvasRenderer
    const depth = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_depth')
    const normal = await renderer.sceneRenderer.backend.readPixels('scene_gbuf_normal_roughness')
    let count = 0, sumX = 0, sumY = 0, sumNX = 0, sumNY = 0
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let y = 0; y < depth.height; y++) {
      for (let x = 0; x < depth.width; x++) {
        const offset = (y * depth.width + x) * 4
        if (depth.data[offset] === 0) continue
        count++; sumX += x; sumY += y
        // RT1 stores normal * 0.5 + 0.5, so an x or y component of zero is 127.5.
        sumNX += normal.data[offset]
        sumNY += normal.data[offset + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    return {
      width: depth.width, height: depth.height, count,
      centroidX: count ? sumX / count : 0,
      centroidY: count ? sumY / count : 0,
      meanNormalX: count ? sumNX / count : 0,
      meanNormalY: count ? sumNY / count : 0,
      minX, maxX, minY, maxY
    }
  })
}

/**
 * F4: a numeric gate on the atlas texel convention.
 *
 * The source-contract tests pin strings and the cross-backend gate shifts
 * identically on both sides, so neither would notice
 * `uvw * (volSize - 1)` becoming `uvw * volSize`. This would: the silhouette of
 * a centred field stops being centred, and its extent changes by 64/63.
 *
 * Everything asserted here is derived from the camera math, not from a golden
 * image. Camera at [0,0,5] on the -Z axis, looking at the origin: the body
 * centre projects to the principal point, i.e. the exact centre of the frame,
 * whatever the readback row order. The containment bound is the projection of
 * the body box's nearest face (z = +1, so 4 units away).
 */
async function testVolumeSamplingConvention(browser, port) {
  const sceneName = 'volume atlas sampling convention (numeric)'
  console.log(`\n--- Testing ${sceneName} ---`)

  const measure = async (backendName) => {
    const backendQuery = backendName === 'webgpu' ? 'wgsl' : 'glsl'
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(`http://127.0.0.1:${port}/demo/shaders/index.html?backend=${backendQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.locator('#app-container').waitFor({ state: 'visible', timeout: 30000 })
      await loadSceneSource(page, CENTRED_VOLUME_SCENE)
      const first = await volumeSilhouette(page)
      // Twice, in the same page: the field has no time term, so a second
      // reading that differs would mean this gate is not deterministic.
      const second = await volumeSilhouette(page)
      return { first, second }
    } finally {
      await context.close()
    }
  }

  const results = {}
  const fail = (reason) => ({ scene: sceneName, backend: 'webgl2+webgpu', status: 'fail', reason, metrics: results })

  for (const backendName of ['webgl2', 'webgpu']) {
    const { first, second } = await measure(backendName)
    results[backendName] = first
    const s = first

    if (Math.abs(first.centroidX - second.centroidX) > 0.5 ||
        Math.abs(first.centroidY - second.centroidY) > 0.5 || first.count !== second.count) {
      return fail(`${backendName}: not deterministic across two readings: ${JSON.stringify({ first, second })}`)
    }

    // The projection of the body box's NEAREST face, in pixels. Camera 5 units
    // out, face at z = +1, so 4 units away; fov 45 gives tan(22.5) per unit of
    // half-height. Nothing the volume draws may fall outside it.
    const tanHalfFov = Math.tan((45 * Math.PI / 180) / 2)
    const aspect = s.width / s.height
    const boxHalfH = (1 / (4 * tanHalfFov)) * (s.height / 2)
    const boxHalfW = (1 / (4 * tanHalfFov * aspect)) * (s.width / 2)
    const cx = s.width / 2
    const cy = s.height / 2
    console.log(`  ${backendName}: ${JSON.stringify(s)}`)
    console.log(`  ${backendName}: box half-extent ${boxHalfW.toFixed(1)} x ${boxHalfH.toFixed(1)} px`)

    if (s.count < s.width * s.height * 0.02) {
      return fail(`${backendName}: the volume barely drew anything: ${JSON.stringify(s)}`)
    }
    // The centroid pin. A half-texel shift in the sampling convention is 1/63
    // of the body, several pixels here, so 2px has room and no slack.
    if (Math.abs(s.centroidX - cx) > 2 || Math.abs(s.centroidY - cy) > 2) {
      return fail(
        `${backendName}: silhouette centroid (${s.centroidX.toFixed(2)}, ${s.centroidY.toFixed(2)}) ` +
        `is more than 2px from the frame centre (${cx}, ${cy}) — the field is centred, so the ` +
        'atlas texel convention has shifted')
    }
    // Containment: a marched hit is always inside the body box, so its
    // projection is always inside the box's. One pixel of slack, because the
    // measured index is a pixel's lower corner, not its centre.
    if (s.minX < cx - boxHalfW - 1 || s.maxX > cx + boxHalfW + 1 ||
        s.minY < cy - boxHalfH - 1 || s.maxY > cy + boxHalfH + 1) {
      return fail(
        `${backendName}: silhouette [${s.minX}..${s.maxX}] x [${s.minY}..${s.maxY}] escapes the ` +
        `body box's projection [${(cx - boxHalfW).toFixed(1)}..${(cx + boxHalfW).toFixed(1)}] x ` +
        `[${(cy - boxHalfH).toFixed(1)}..${(cy + boxHalfH).toFixed(1)}]`)
    }
    // ...and it fills a sensible share of that box. A silhouette that collapsed
    // or exploded is a sampling change even when it stayed centred.
    const fillW = (s.maxX - s.minX) / (2 * boxHalfW)
    const fillH = (s.maxY - s.minY) / (2 * boxHalfH)
    console.log(`  ${backendName}: box fill ${(fillW * 100).toFixed(1)}% x ${(fillH * 100).toFixed(1)}%`)
    if (fillW < 0.3 || fillH < 0.3) {
      return fail(`${backendName}: silhouette fills only ${(fillW * 100).toFixed(1)}% x ${(fillH * 100).toFixed(1)}% of the body box`)
    }
    // Radial symmetry: the field depends on |p - centre| alone, so the
    // silhouette's bounding box is symmetric about the centre. A scaled texel
    // convention (64/63) shows up here even if it were somehow centred.
    const skewX = Math.abs((cx - s.minX) - (s.maxX - cx))
    const skewY = Math.abs((cy - s.minY) - (s.maxY - cy))
    if (skewX > 4 || skewY > 4) {
      return fail(`${backendName}: silhouette is not symmetric about the centre (skew ${skewX} x ${skewY} px)`)
    }
    // Normals come from central differences of the sampled field, so the mean
    // normal over a radially symmetric field seen head-on is analytically
    // (0, 0, +z) — 127.5 in x and y once RT1 has encoded it as n * 0.5 + 0.5.
    // Measured 127.46 with the correct convention (the 0.04 is encoding bias),
    // so 1.0 is twenty times the real floor.
    console.log(`  ${backendName}: mean normal x=${s.meanNormalX.toFixed(3)} y=${s.meanNormalY.toFixed(3)} (symmetry -> 127.5)`)
    if (Math.abs(s.meanNormalX - 127.5) > 1 || Math.abs(s.meanNormalY - 127.5) > 1) {
      return fail(
        `${backendName}: mean G-buffer normal (${s.meanNormalX.toFixed(3)}, ${s.meanNormalY.toFixed(3)}) ` +
        'is more than 1/255 off the 127.5 a centred, radially symmetric field must produce — ' +
        'the atlas texel convention is sampling off centre')
    }
    // The sharp one, and the reason this case can see a SUB-texel shift at all.
    //
    // The silhouette is bounded by the body box, which masks a small sampling
    // shift in the extent — but nothing masks the field's own symmetry. It is
    // symmetric under x <-> y and the camera is on the axis, so the x and y
    // statistics are not merely near 127.5 / near the centre: they are equal to
    // each other. Measured with the correct convention they are equal to the
    // last bit on both backends (centroid 511.5 / 511.5, mean normal
    // 127.45642278974864 / 127.45642278974864).
    //
    // Sampling half a texel off centre — `uvw * volSizeF` for
    // `uvw * (volSizeF - 1.0)`, which puts local 0 on texel 32 instead of the
    // field's own centre at 31.5 — breaks it: measured mean-normal diagonal
    // splits of 0.37 (WebGL2) and 0.42 (WebGPU), against a floor of exactly 0.
    const centroidSplit = Math.abs(s.centroidX - s.centroidY)
    const normalSplit = Math.abs(s.meanNormalX - s.meanNormalY)
    console.log(`  ${backendName}: diagonal split centroid=${centroidSplit.toFixed(3)}px normal=${normalSplit.toFixed(3)}`)
    if (centroidSplit > 0.5 || normalSplit > 0.2) {
      return fail(
        `${backendName}: the x and y statistics of a field symmetric under x <-> y have split ` +
        `(centroid by ${centroidSplit.toFixed(3)}px, mean normal by ${normalSplit.toFixed(3)}/255) — ` +
        'the atlas texel convention is off centre')
    }
  }

  // The two backends decode the same atlas, so their silhouettes must agree.
  const dx = Math.abs(results.webgl2.centroidX - results.webgpu.centroidX)
  const dy = Math.abs(results.webgl2.centroidY - results.webgpu.centroidY)
  const dCount = Math.abs(results.webgl2.count - results.webgpu.count) / results.webgl2.count
  // Measured at exactly 0 on all three with the correct convention — the two
  // backends decode the same atlas to the same pixels. The regression above
  // pushes coverage to 0.500% and the y centroid to 1.33px.
  console.log(`  cross-backend centroid delta ${dx.toFixed(3)} x ${dy.toFixed(3)} px, coverage delta ${(dCount * 100).toFixed(3)}%`)
  if (dx > 0.5 || dy > 0.5 || dCount > 0.0005) {
    return fail(`backends disagree: centroid ${dx.toFixed(3)} x ${dy.toFixed(3)} px, coverage ${(dCount * 100).toFixed(3)}%`)
  }

  return { scene: sceneName, backend: 'webgl2+webgpu', status: 'pass', metrics: results }
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
  } else if (CROSS_BACKEND_ONLY) {
    results.push(...(await testCrossBackendParity(browser, port)))
  } else if (VOLUME_ONLY) {
    results.push(await testVolumeScene(browser, port, 'webgl2'))
    results.push(await testVolumeScene(browser, port, 'webgpu'))
    results.push(await testVolumeNearPlaneReject(browser, port))
    results.push(await testVolumeSamplingConvention(browser, port))
    results.push(await testVolumeCrossBackendParity(browser, port))
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
    results.push(await testVolumeScene(browser, port, 'webgl2'))
    results.push(await testVolumeScene(browser, port, 'webgpu'))
    results.push(await testVolumeNearPlaneReject(browser, port))
    results.push(await testVolumeSamplingConvention(browser, port))
    results.push(...(await testCrossBackendParity(browser, port)))
    results.push(await testVolumeCrossBackendParity(browser, port))
  }
  if (!DEMO_ONLY && !PLANAR_REFLECTION_ONLY && !MATERIAL_BANDING_ONLY && !SCENE_ANIMATION_ONLY
      && !CROSS_BACKEND_ONLY && !VOLUME_ONLY) {
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
