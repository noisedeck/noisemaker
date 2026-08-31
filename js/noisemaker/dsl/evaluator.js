import { defaultContext } from './builtins.js'

function evalNode(node, ctx) {
  switch (node.type) {
    case 'NumberLiteral':
      return node.value
    case 'StringLiteral':
      return node.value
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'Identifier': {
      const name = node.name
      if (ctx.operations[name]) return ctx.operations[name]
      if (ctx.surfaces[name]) return ctx.surfaces[name]
      if (ctx.enums && ctx.enums[name]) return ctx.enums[name]
      return name
    }
    case 'MemberExpr': {
      const prop = node.property.name
      if (node.object.type === 'Identifier' && ctx.enumMethods) {
        const objName = node.object.name
        const methods = ctx.enumMethods[objName]
        if (methods && methods[prop]) {
          return methods[prop]
        }
      }
      const objVal = evalNode(node.object, ctx)
      return objVal?.[prop]
    }
    case 'ArrayExpr': {
      const arr = node.elements.map((el) => evalNode(el, ctx))
      const enumNames = node.elements.map((el) => {
        if (el.type !== 'MemberExpr' || el.object.type !== 'Identifier') return null
        const name = el.object.name
        return ctx.enums?.[name] && typeof ctx.enums[name] === 'object' ? name : null
      })
      const enumName = enumNames[0]
      if (
        enumName &&
        enumNames.every((name) => name === enumName) &&
        !Object.prototype.hasOwnProperty.call(arr, '__enum')
      ) {
        Object.defineProperty(arr, '__enum', { value: enumName })
      }
      const literalElements = node.elements.every((el) =>
        ['NumberLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral'].includes(el.type),
      )
      if (literalElements && !Object.prototype.hasOwnProperty.call(arr, '__literal')) {
        Object.defineProperty(arr, '__literal', { value: true })
      }
      return arr
    }
    case 'ObjectExpr': {
      const out = {}
      for (const { key, value } of node.properties) {
        out[key] = evalNode(value, ctx)
      }
      return out
    }
    case 'UnaryExpr': {
      const v = evalNode(node.argument, ctx)
      switch (node.operator) {
        case '+':
          return Array.isArray(v) ? v : +v
        case '-':
          if (Array.isArray(v)) return v.map((n) => -n)
          return -v
        default:
          throw new Error(`Unknown operator ${node.operator}`)
      }
    }
    case 'BinaryExpr': {
      const l = evalNode(node.left, ctx)
      const r = evalNode(node.right, ctx)
      const op = node.operator
      if (hasFunction(l) || hasFunction(r)) {
        return (settings) => {
          const L = resolveValue(l, settings)
          const R = resolveValue(r, settings)
          switch (op) {
            case '+':
              if (Array.isArray(L) && Array.isArray(R)) return L.concat(R)
              if (Array.isArray(L) && typeof R === 'number') return L.map((n) => n + R)
              if (typeof L === 'number' && Array.isArray(R)) return R.map((n) => L + n)
              return L + R
            case '-':
              if (Array.isArray(L) && Array.isArray(R)) return L.map((n, i) => n - R[i])
              if (Array.isArray(L) && typeof R === 'number') return L.map((n) => n - R)
              if (typeof L === 'number' && Array.isArray(R)) return R.map((n) => L - n)
              return L - R
            case '*':
              if (Array.isArray(L) && Array.isArray(R)) return L.map((n, i) => n * R[i])
              if (Array.isArray(L) && typeof R === 'number') {
                const out = []
                for (let i = 0; i < R; i++) out.push(...L)
                return out
              }
              if (typeof L === 'number' && Array.isArray(R)) {
                const out = []
                for (let i = 0; i < L; i++) out.push(...R)
                return out
              }
              return L * R
            case '/':
              if (Array.isArray(L) && typeof R === 'number') return L.map((n) => n / R)
              if (typeof L === 'number' && Array.isArray(R)) return R.map((n) => L / n)
              return L / R
            case '<':
              return L < R
            case '>':
              return L > R
            default:
              throw new Error(`Unknown operator ${op}`)
          }
        }
      }
      switch (op) {
        case '+':
          if (Array.isArray(l) && Array.isArray(r)) return l.concat(r)
          if (Array.isArray(l) && typeof r === 'number') return l.map((n) => n + r)
          if (typeof l === 'number' && Array.isArray(r)) return r.map((n) => l + n)
          return l + r
        case '-':
          if (Array.isArray(l) && Array.isArray(r)) return l.map((n, i) => n - r[i])
          if (Array.isArray(l) && typeof r === 'number') return l.map((n) => n - r)
          if (typeof l === 'number' && Array.isArray(r)) return r.map((n) => l - n)
          return l - r
        case '*':
          if (Array.isArray(l) && Array.isArray(r)) return l.map((n, i) => n * r[i])
          if (Array.isArray(l) && typeof r === 'number') {
            const out = []
            for (let i = 0; i < r; i++) out.push(...l)
            return out
          }
          if (typeof l === 'number' && Array.isArray(r)) {
            const out = []
            for (let i = 0; i < l; i++) out.push(...r)
            return out
          }
          return l * r
        case '/':
          if (Array.isArray(l) && typeof r === 'number') return l.map((n) => n / r)
          if (typeof l === 'number' && Array.isArray(r)) return r.map((n) => l / n)
          return l / r
        case '<':
          return l < r
        case '>':
          return l > r
        default:
          throw new Error(`Unknown operator ${op}`)
      }
    }
    case 'TernaryExpr': {
      const test = evalNode(node.test, ctx)
      const consequent = evalNode(node.consequent, ctx)
      const alternate = evalNode(node.alternate, ctx)
      if (hasFunction(test) || hasFunction(consequent) || hasFunction(alternate)) {
        return (settings) =>
          resolveValue(test, settings)
            ? resolveValue(consequent, settings)
            : resolveValue(alternate, settings)
      }
      return test ? consequent : alternate
    }
    case 'CallExpr':
      return evalCall(node, ctx)
    default:
      throw new Error(`Unsupported node type: ${node.type}`)
  }
}

function evalArgs(arglist, ctx) {
  if (arglist.named) {
    const params = {}
    const names = []
    for (const [k, v] of Object.entries(arglist.named)) {
      params[k] = evalNode(v, ctx)
      names.push(k)
    }
    return { args: [params], params, paramNames: names }
  }
  const arr = arglist.positional.map((a) => evalNode(a, ctx))
  return { args: arr, params: null, paramNames: null }
}

function hasFunction(v) {
  if (typeof v === 'function') return true
  if (Array.isArray(v)) return v.some(hasFunction)
  if (v && typeof v === 'object') return Object.values(v).some(hasFunction)
  return false
}

function resolveValue(v, settings) {
  if (typeof v === 'function') return v(settings)
  if (Array.isArray(v)) {
    const out = v.map((x) => resolveValue(x, settings))
    if (v.__enum && !Object.prototype.hasOwnProperty.call(out, '__enum')) {
      Object.defineProperty(out, '__enum', { value: v.__enum })
    }
    if (v.__literal && !Object.prototype.hasOwnProperty.call(out, '__literal')) {
      Object.defineProperty(out, '__literal', { value: v.__literal })
    }
    return out
  }
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = resolveValue(val, settings)
    }
    return out
  }
  return v
}

function evalCall(node, ctx) {
  const input = node.input ? evalNode(node.input, ctx) : undefined
  const { args, params, paramNames } = evalArgs(node.args, ctx)
  const callee = node.callee
  if (callee.type === 'Identifier') {
    const name = callee.name
    const fn = ctx.operations[name]
    if (typeof fn === 'function') {
      if (fn.__thunk || hasFunction(args) || hasFunction(input)) {
        return (settings) => fn(...resolveValue(args, settings))
      }
      return fn(...args)
    }
    const out = { op: name, args, input }
    out.__effectName = name
    if (paramNames) {
      out.__paramNames = paramNames
      out.__params = params
    }
    return out
  }
  const fn = evalNode(callee, ctx)
  if (typeof fn === 'function') {
    if (fn.__thunk || hasFunction(args) || hasFunction(input)) {
      return (settings) => fn(...resolveValue(args, settings))
    }
    return fn(...args)
  }
  throw new Error('Unsupported callee')
}

export function evaluate(ast, ctx = defaultContext) {
  return evalNode(ast.body, ctx)
}
