import { EffectHarness } from './harness_effect.js'
import Fibers from '../effects/nm/fibers/definition.js'

console.log('Testing Fibers Effect')
console.log('=' .repeat(60))

const harness = new EffectHarness(Fibers)

try {
    console.log('Validating...')
    harness.validate()
    console.log('  ✓ Validation passed')
} catch (e) {
    console.error(`  Validation: FAIL - ${e.message}`)
    process.exit(1)
}

try {
    console.log('Mounting...')
    harness.mount()
    console.log('  ✓ Mount passed')
} catch (e) {
    console.error(`  Mount: FAIL - ${e.message}`)
    process.exit(1)
}

try {
    console.log('Updating...')
    harness.update(0.1)
    console.log('  ✓ Update passed')
} catch (e) {
    console.error(`  Update: FAIL - ${e.message}`)
    process.exit(1)
}

console.log('All tests passed for Fibers')
