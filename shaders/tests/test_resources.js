import { analyzeLiveness, allocateResources } from '../src/runtime/resources.js'

let failed = 0

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        fn()
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e)
        failed++
    }
}

process.on('exit', () => { if (failed > 0) process.exitCode = 1 })

test('Liveness Analysis - Simple Chain', () => {
    // A -> B -> C
    const passes = [
        { outputs: { out: 'A' } },          // 0: Write A
        { inputs: { in: 'A' }, outputs: { out: 'B' } }, // 1: Read A, Write B
        { inputs: { in: 'B' }, outputs: { out: 'C' } }, // 2: Read B, Write C
        { inputs: { in: 'C' } }             // 3: Read C
    ]

    const lifetime = analyzeLiveness(passes)

    const lA = lifetime.get('A')
    if (lA.start !== 0 || lA.end !== 1) throw new Error(`A lifetime mismatch: ${JSON.stringify(lA)}`)

    const lB = lifetime.get('B')
    if (lB.start !== 1 || lB.end !== 2) throw new Error(`B lifetime mismatch: ${JSON.stringify(lB)}`)

    const lC = lifetime.get('C')
    if (lC.start !== 2 || lC.end !== 3) throw new Error(`C lifetime mismatch: ${JSON.stringify(lC)}`)
})

test('Resource Allocation - Reuse', () => {
    // A -> B -> C
    // A and C should share a slot.
    const passes = [
        { outputs: { out: 'A' } },          // 0
        { inputs: { in: 'A' }, outputs: { out: 'B' } }, // 1
        { inputs: { in: 'B' }, outputs: { out: 'C' } }, // 2
        { inputs: { in: 'C' } }             // 3
    ]

    const alloc = allocateResources(passes)

    const physA = alloc.get('A')
    const physB = alloc.get('B')
    const physC = alloc.get('C')

    if (physA === physB) throw new Error('A and B should not share slot (overlap at pass 1)')
    if (physB === physC) throw new Error('B and C should not share slot (overlap at pass 2)')
    if (physA !== physC) throw new Error(`A and C should share slot. A=${physA}, C=${physC}`)
})

test('Resource Allocation - Branching', () => {
    // A -> B
    // A -> C
    // B + C -> D

    // 0: Write A
    // 1: Read A, Write B
    // 2: Read A, Write C
    // 3: Read B, Read C, Write D

    const passes = [
        { outputs: { out: 'A' } }, // 0
        { inputs: { in: 'A' }, outputs: { out: 'B' } }, // 1
        { inputs: { in: 'A' }, outputs: { out: 'C' } }, // 2
        { inputs: { in1: 'B', in2: 'C' }, outputs: { out: 'D' } } // 3
    ]

    // Liveness:
    // A: 0..2 (Read at 1, Read at 2)
    // B: 1..3
    // C: 2..3
    // D: 3..3

    // Alloc:
    // 0: Alloc A (phys_0)
    // 1: Alloc B (phys_1). A is alive.
    // 2: Alloc C (phys_2). A is alive (last use). B is alive.
    //    Release A after 2.
    // 3: Alloc D (phys_0?). B is alive (last use). C is alive (last use).
    //    A was released after 2. So D can use phys_0.

    const alloc = allocateResources(passes)

    const physA = alloc.get('A')
    const physB = alloc.get('B')
    const physC = alloc.get('C')
    const physD = alloc.get('D')

    if (physA === physB) throw new Error('A/B overlap')
    if (physA === physC) throw new Error('A/C overlap')
    if (physB === physC) throw new Error('B/C overlap')

    // D can reuse A?
    // A released after 2. D starts at 3. Yes.
    if (physD !== physA) throw new Error(`D should reuse A. D=${physD}, A=${physA}`)
})
