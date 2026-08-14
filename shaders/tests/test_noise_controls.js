import Noise from '../effects/synth/noise/definition.js'
import { expand } from '../src/runtime/expander.js'
import { registerEffect } from '../src/runtime/registry.js'

const noiseDefinition = new Noise()
registerEffect('noise', noiseDefinition)

function runNoise(args = {}) {
  const plan = {
    chain: [
      {
        op: 'noise',
        args: { ...args },
        from: null,
        temp: 0
      }
    ],
    out: 'o0'
  }

  const { passes, errors } = expand({ plans: [plan], diagnostics: [] })
  if (errors.length > 0) {
    throw new Error(`Expander reported errors: ${JSON.stringify(errors)}`)
  }

  const noisePass = passes.find((pass) => pass.effectKey === 'noise')
  if (!noisePass) {
    throw new Error('Noise pass not found in expanded graph')
  }

  return noisePass.uniforms
}

function chooseVariantValue(name, spec) {
  if (spec.type === 'boolean') {
    return !spec.default
  }

  if (spec.type === 'int') {
    if (spec.default + 1 <= spec.max) {
      return spec.default + 1
    }
    if (spec.default - 1 >= spec.min) {
      return spec.default - 1
    }
    throw new Error(`No valid variant for int control ${name}`)
  }

  if (spec.type === 'float') {
    const step = spec.step ?? 1
    const candidateUp = spec.default + step
    if (candidateUp <= spec.max) {
      return candidateUp
    }
    const candidateDown = spec.default - step
    if (candidateDown >= spec.min) {
      return candidateDown
    }
    const fallback = spec.max !== spec.default ? spec.max : spec.min
    if (fallback === spec.default) {
      throw new Error(`No valid variant for float control ${name}`)
    }
    return fallback
  }

  throw new Error(`Unsupported control type ${spec.type} on ${name}`)
}

function test(name, fn) {
  try {
    console.log(`Running test: ${name}`)
    fn()
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exit(1)
  }
}

test('Noise controls alter bound uniforms', () => {
  const baseArgs = { colorMode: 'color.hsv' }
  const baseUniforms = runNoise(baseArgs)

  for (const [name, spec] of Object.entries(noiseDefinition.globals)) {
    if (name === 'colorMode') {
      continue
    }

    const uniformName = spec.uniform
    if (!uniformName) {
      throw new Error(`Control ${name} is missing a uniform binding`)
    }

    if (!(uniformName in baseUniforms)) {
      throw new Error(`Uniform ${uniformName} was not bound in the base pass`)
    }

    const variantValue = chooseVariantValue(name, spec)
    const variantUniforms = runNoise({ ...baseArgs, [name]: variantValue })

    if (variantUniforms[uniformName] === baseUniforms[uniformName]) {
      throw new Error(`Control ${name} did not modify uniform ${uniformName}`)
    }
  }

  const defaultUniforms = runNoise()
  const hsvUniforms = runNoise({ colorMode: 'color.hsv' })
  if (defaultUniforms.colorMode === hsvUniforms.colorMode) {
    throw new Error('colorMode control did not alter the colorMode uniform')
  }
})
