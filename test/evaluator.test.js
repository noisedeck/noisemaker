import assert from 'assert'
import { tokenize } from '../js/noisemaker/dsl/tokenizer.js'
import { parse } from '../js/noisemaker/dsl/parser.js'
import { evaluate } from '../js/noisemaker/dsl/evaluator.js'
import { setSeed } from '../js/noisemaker/util.js'
import { InterpolationType, ValueDistribution } from '../js/noisemaker/constants.js'

function resolve(value) {
  if (typeof value === 'function') {
    return value({})
  }
  return value
}

// Effect chain should attach metadata
const ast = parse(tokenize('rotate(angle: 45).posterize(levels: 5)'))
const result = evaluate(ast)
assert.strictEqual(result.__effectName, 'posterize')
assert.deepStrictEqual(result.__params, { levels: 5 })
assert.strictEqual(result.input.__effectName, 'rotate')
assert.deepStrictEqual(result.input.__params, { angle: 45 })

// Builtins should evaluate
setSeed(1)

let coin = resolve(evaluate(parse(tokenize('coin_flip()'))))
assert.strictEqual(typeof coin, 'boolean')

setSeed(1)
let member = resolve(evaluate(parse(tokenize('random_member([1,2,3])'))))
assert.ok([1, 2, 3].includes(member))

resolve(evaluate(parse(tokenize('stash("x", 42)'))))
let stashed = resolve(evaluate(parse(tokenize('stash("x")'))))
assert.strictEqual(stashed, 42)

let range = resolve(evaluate(parse(tokenize('enum_range(1,3)'))))
assert.deepStrictEqual(range, [1, 2, 3])

setSeed(1)
let rnd = resolve(evaluate(parse(tokenize('random()'))))
assert.ok(rnd >= 0 && rnd < 1)

setSeed(1)
let rndInt = resolve(evaluate(parse(tokenize('random_int(1,3)'))))
assert.ok([1, 2, 3].includes(rndInt))

// Arithmetic with calls and member expressions
setSeed(1)
let sum = resolve(
  evaluate(parse(tokenize('random_int(1,3) + ValueDistribution.ones'))),
)
assert.strictEqual(sum, 7)

// Ternary operations
setSeed(1)
let tern = resolve(evaluate(parse(tokenize('coin_flip() ? 1 : 2'))))
assert.strictEqual(tern, 1)

// Random enumeration selection
setSeed(1)
let enumPick = resolve(
  evaluate(
    parse(
      tokenize(
        'random_member([ValueDistribution.ones, ValueDistribution.mids, ValueDistribution.zeros])',
      ),
    ),
  ),
)
assert.ok([ValueDistribution.ones, ValueDistribution.mids, ValueDistribution.zeros].includes(enumPick))

// Enum arrays must retain their type so random_member sorts by member name,
// matching Python Enum semantics rather than ambiguous numeric enum values.
const enumSelections = []
for (let seed = 0; seed < 5; seed++) {
  setSeed(seed)
  enumSelections.push(
    resolve(
      evaluate(
        parse(
          tokenize(
            'random_member([InterpolationType.linear, InterpolationType.cosine])',
          ),
        ),
      ),
    ),
  )
}
assert.deepStrictEqual(enumSelections, [
  InterpolationType.cosine,
  InterpolationType.linear,
  InterpolationType.linear,
  InterpolationType.linear,
  InterpolationType.linear,
])

// Null literal
let nullVal = resolve(evaluate(parse(tokenize('null'))))
assert.strictEqual(nullVal, null)

// Named argument with equals
let eqCall = resolve(evaluate(parse(tokenize('rotate(angle=45)'))))
assert.strictEqual(eqCall.__params.angle, 45)

// Python-style conditional
let pyTern = resolve(evaluate(parse(tokenize('1 if true else 2'))))
assert.strictEqual(pyTern, 1)

// Unary operators
let neg = resolve(evaluate(parse(tokenize('-5'))))
assert.strictEqual(neg, -5)
let arrNeg = resolve(evaluate(parse(tokenize('-[1,2,3]'))))
assert.deepStrictEqual(arrNeg, [-1, -2, -3])

// Array arithmetic
let arrConcat = resolve(evaluate(parse(tokenize('[1,2] + [3,4]'))))
assert.deepStrictEqual(arrConcat, [1, 2, 3, 4])
let arrAddNum = resolve(evaluate(parse(tokenize('[1,2] + 3'))))
assert.deepStrictEqual(arrAddNum, [4, 5])

assert.throws(
  () => resolve(evaluate(parse(tokenize('coin_flip(1)')))),
  /takes no arguments/,
)
assert.throws(
  () => resolve(evaluate(parse(tokenize('enum_range(1)')))),
  /requires exactly 2 arguments/
)
assert.throws(
  () => resolve(evaluate(parse(tokenize('enum_range("a",3)')))),
  /requires numeric arguments/
)
assert.throws(
  () => resolve(evaluate(parse(tokenize('random_member()')))),
  /requires at least one iterable argument/
)
assert.throws(
  () => resolve(evaluate(parse(tokenize('stash(1)')))),
  /key must be a string/
)
assert.throws(
  () => resolve(evaluate(parse(tokenize('stash("x",1,2)')))),
  /expects 1 or 2 arguments/
)

console.log('evaluator tests passed')
