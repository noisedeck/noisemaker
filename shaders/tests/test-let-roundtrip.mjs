/**
 * Tests for let statement round-trip through compile/unparse
 * Run with: node shaders/tests/test-let-roundtrip.mjs
 */

import { compile, unparse } from '../src/lang/index.js';
import { registerOp } from '../src/lang/ops.js';
import { registerStarterOps } from '../src/lang/validator.js';

// Register a minimal synth.noise op so the validator can resolve it
registerOp('synth.noise', {
    name: 'noise',
    args: [
        { name: 'scale', type: 'float', default: 75 },
        { name: 'rotation', type: 'float', default: 0 },
        { name: 'seed', type: 'int', default: 1 },
    ]
});
registerStarterOps(['synth.noise', 'noise']);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`✗ ${name}`);
        console.error(`  ${err.message}`);
        failed++;
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
    }
}

function assertIncludes(str, substr, message) {
    if (!str.includes(substr)) {
        throw new Error(`${message}\n  String does not include: ${JSON.stringify(substr)}\n  Actual: ${JSON.stringify(str)}`);
    }
}

// Test 1: Automation variable round-trip
test('let with osc() round-trips through compile/unparse', () => {
    const src = `search synth

let wobble = osc(type: oscKind.sine, min: 0, max: 360)

noise(rotation: wobble)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let wobble = osc(', 'Should include let declaration');
    assertIncludes(result, 'rotation: wobble', 'Should reference variable, not inline');
});

// Test 2: Numeric variable round-trip
test('let with numeric value round-trips', () => {
    const src = `search synth

let amount = 0.5

noise(scale: amount)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let amount = 0.5', 'Should include let declaration');
    assertIncludes(result, 'scale: amount', 'Should reference variable');
});

// Test 3: Multiple let statements
test('multiple let statements round-trip', () => {
    const src = `search synth

let wobble = osc(type: oscKind.sine)
let amt = 0.5

noise(rotation: wobble, scale: amt)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let wobble = osc(', 'Should include first let');
    assertIncludes(result, 'let amt = 0.5', 'Should include second let');
    assertIncludes(result, 'rotation: wobble', 'Should reference wobble');
    assertIncludes(result, 'scale: amt', 'Should reference amt');
});

// Test 4: Let with effect call (non-automation)
test('let with effect call round-trips', () => {
    const src = `search synth

let myScale = 3

noise(scale: myScale)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let myScale = 3', 'Should include let declaration');
    assertIncludes(result, 'scale: myScale', 'Should reference variable');
});

// Test 5: Let with enum value
test('let with enum member round-trips', () => {
    const src = `search synth

let waveType = oscKind.sine
let wobble = osc(type: waveType)

noise(rotation: wobble)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let waveType =', 'Should include enum let');
    assertIncludes(result, 'let wobble = osc(', 'Should include osc let');
    assertIncludes(result, 'type: waveType', 'Should use variable reference in osc type, not oscKind.waveType');
});

// Test 6: Let with midi
test('let with midi() round-trips', () => {
    const src = `search synth

let knob = midi(channel: 1)

noise(scale: knob)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let knob = midi(', 'Should include midi let');
    assertIncludes(result, 'scale: knob', 'Should reference variable');
});

test('let with escaped MIDI device identity round-trips stably', () => {
    const name = 'Launch "Control" \\ XL';
    const id = 'port\\two';
    const src = `search synth

let knob = midi(name: ${JSON.stringify(name)}, id: ${JSON.stringify(id)}, channel: 1)

noise(scale: knob)
  .write(o0)

render(o0)`;
    const once = unparse(compile(src));
    const twice = unparse(compile(once));
    assertEqual(twice, once, 'MIDI identity must not grow escapes across round-trips');
    assertIncludes(once, `name: ${JSON.stringify(name)}`, 'Should preserve readable MIDI name');
    assertIncludes(once, `id: ${JSON.stringify(id)}`, 'Should preserve exact MIDI id');
});

test('let with numeric MIDI mode round-trips without changing mode', () => {
    for (let mode = 0; mode <= 4; mode++) {
        const src = `search synth

let knob = midi(channel: 1, mode: ${mode})

noise(scale: knob)
  .write(o0)

render(o0)`;
        const once = unparse(compile(src));
        const twice = unparse(compile(once));
        assertEqual(twice, once, `Numeric MIDI mode ${mode} should be stable`);
        if (mode !== 4) {
            assertIncludes(once, `mode: ${mode}`, `Numeric MIDI mode ${mode} should be preserved`);
        }
    }
});

test('single-quoted MIDI identity with quotes and slashes round-trips to valid DSL', () => {
    const name = 'Keys "Left" Controller\'s \\ Main';
    const id = 'port\\one';
    const src = String.raw`search synth

let knob = midi(name: 'Keys "Left" Controller\'s \\ Main', id: 'port\\one', channel: 1)

noise(scale: knob)
  .write(o0)

render(o0)`;
    const once = unparse(compile(src));
    const twice = unparse(compile(once));
    assertEqual(twice, once, 'Single-quoted MIDI identity should emit stable valid DSL');
    assertIncludes(once, `name: ${JSON.stringify(name)}`, 'Should preserve quotes, apostrophe, and slash');
    assertIncludes(once, `id: ${JSON.stringify(id)}`, 'Should preserve escaped id slash');
});

// Test 7: Let with audio
test('let with audio() round-trips', () => {
    const src = `search synth

let bass = audio(band: audioBand.low)

noise(scale: bass)
  .write(o0)

render(o0)`;
    const compiled = compile(src);
    const result = unparse(compiled);
    assertIncludes(result, 'let bass = audio(', 'Should include audio let');
    assertIncludes(result, 'scale: bass', 'Should reference variable');
});

// Test 8: Double round-trip stability
test('double round-trip produces identical output', () => {
    const src = `search synth

let wobble = osc(type: oscKind.sine, min: 0, max: 360)
let amt = 0.5

noise(rotation: wobble, scale: amt)
  .write(o0)

render(o0)`;
    const compiled1 = compile(src);
    const unparsed1 = unparse(compiled1);
    const compiled2 = compile(unparsed1);
    const unparsed2 = unparse(compiled2);
    assertEqual(unparsed1, unparsed2, 'Double round-trip should be stable');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
