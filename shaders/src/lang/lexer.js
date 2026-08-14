/**
 * Reserved DSL keyword → token-type map.
 * Single source of truth shared by the lexer and namespace validation
 * (shaders/src/runtime/tags.js → registerNamespace).
 */
export const RESERVED_KEYWORDS = Object.freeze({
    let: 'LET',
    render: 'RENDER',
    write: 'WRITE',
    write3d: 'WRITE3D',
    true: 'TRUE',
    false: 'FALSE',
    if: 'IF',
    elif: 'ELIF',
    else: 'ELSE',
    break: 'BREAK',
    continue: 'CONTINUE',
    return: 'RETURN',
    search: 'SEARCH',
    subchain: 'SUBCHAIN'
})

/**
 * Lexer for the live-coding DSL
 * Produces an array of tokens: {type, lexeme, line, col}
 * @param {string} src source code
 * @returns {Array}
 */
export function lex(src) {
    const tokens = []
    let i = 0
    let line = 1
    let col = 1

    function add(type, lexeme, line, col) {
        tokens.push({type, lexeme, line, col})
    }

    const isDigit = c => c >= '0' && c <= '9'
    const isLetter = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
    const keywords = RESERVED_KEYWORDS

    while (i < src.length) {
        let ch = src[i]

        if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue }
        if (ch === '\n') { i++; line++; col = 1; continue }

        const startLine = line
        const startCol = col

        // line comments - emit as COMMENT token
        if (ch === '/' && src[i + 1] === '/') {
            let j = i + 2
            while (j < src.length && src[j] !== '\n') j++
            const text = src.slice(i, j)
            add('COMMENT', text, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // block comments - emit as COMMENT token
        if (ch === '/' && src[i + 1] === '*') {
            let j = i + 2
            let endLine = line
            let endCol = col + 2
            while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
                if (src[j] === '\n') { endLine++; endCol = 1 }
                else { endCol++ }
                j++
            }
            if (j >= src.length) throw new SyntaxError(`Unterminated comment at line ${startLine} col ${startCol}`)
            j += 2
            const text = src.slice(i, j)
            add('COMMENT', text, startLine, startCol)
            line = endLine
            col = endCol + 2
            i = j
            continue
        }

        // output or source reference
        if ((ch === 'o' || ch === 's') && isDigit(src[i + 1])) {
            let j = i + 1
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            const tokenType = ch === 'o' ? 'OUTPUT_REF' : 'SOURCE_REF'
            add(tokenType, lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // volume reference (vol0-vol7)
        if (ch === 'v' && src[i + 1] === 'o' && src[i + 2] === 'l' && isDigit(src[i + 3])) {
            let j = i + 3
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('VOL_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // geometry reference (geo0-geo7)
        if (ch === 'g' && src[i + 1] === 'e' && src[i + 2] === 'o' && isDigit(src[i + 3])) {
            let j = i + 3
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('GEO_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // xyz reference (xyz0-xyz7) - agent position surfaces
        if (ch === 'x' && src[i + 1] === 'y' && src[i + 2] === 'z' && isDigit(src[i + 3])) {
            let j = i + 3
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('XYZ_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // vel reference (vel0-vel7) - agent velocity surfaces
        if (ch === 'v' && src[i + 1] === 'e' && src[i + 2] === 'l' && isDigit(src[i + 3])) {
            let j = i + 3
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('VEL_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // rgba reference (rgba0-rgba7) - agent color surfaces
        if (ch === 'r' && src[i + 1] === 'g' && src[i + 2] === 'b' && src[i + 3] === 'a' && isDigit(src[i + 4])) {
            let j = i + 4
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('RGBA_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // mesh reference (mesh0-mesh7) - mesh geometry surfaces
        if (ch === 'm' && src[i + 1] === 'e' && src[i + 2] === 's' && src[i + 3] === 'h' && isDigit(src[i + 4])) {
            let j = i + 4
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('MESH_REF', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        // html hex color literal
        if (ch === '#') {
            let j = i + 1
            while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++
            const len = j - i
            if (len === 4 || len === 7 || len === 9) {
                const lexeme = src.slice(i, j)
                add('HEX', lexeme, startLine, startCol)
                col += len
                i = j
                continue
            }
        }

        // arrow function expression (() => expr)
        if (ch === '(' && src[i + 1] === ')') {
            let j = i + 2
            while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++
            if (src[j] === '=' && src[j + 1] === '>') {
                j += 2
                while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++
                let depth = 0
                const exprStart = j
                while (j < src.length) {
                    const c = src[j]
                    if (c === '(') depth++
                    else if (c === ')') {
                        if (depth === 0) break
                        depth--
                    } else if (depth === 0) {
                        if (c === ',' || c === ';' || c === '\n' || c === '}') break
                    }
                    j++
                }
                const expr = src.slice(exprStart, j).trim()
                add('FUNC', expr, startLine, startCol)
                col += j - i
                i = j
                continue
            }
        }

        if (ch === '.' && isDigit(src[i + 1])) {
            let j = i + 1
            while (j < src.length && isDigit(src[j])) j++
            const lexeme = src.slice(i, j)
            add('NUMBER', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }
        if (ch === '.') { add('DOT', '.', startLine, startCol); i++; col++; continue }
        if (ch === '(') { add('LPAREN', '(', startLine, startCol); i++; col++; continue }
        if (ch === ')') { add('RPAREN', ')', startLine, startCol); i++; col++; continue }
        if (ch === '{') { add('LBRACE', '{', startLine, startCol); i++; col++; continue }
        if (ch === '}') { add('RBRACE', '}', startLine, startCol); i++; col++; continue }
        if (ch === '[') { add('LBRACKET', '[', startLine, startCol); i++; col++; continue }
        if (ch === ']') { add('RBRACKET', ']', startLine, startCol); i++; col++; continue }
        if (ch === ',') { add('COMMA', ',', startLine, startCol); i++; col++; continue }
        if (ch === ':') { add('COLON', ':', startLine, startCol); i++; col++; continue }
        if (ch === '=') { add('EQUAL', '=', startLine, startCol); i++; col++; continue }
        if (ch === ';') { add('SEMICOLON', ';', startLine, startCol); i++; col++; continue }
        if (ch === '+') { add('PLUS', '+', startLine, startCol); i++; col++; continue }
        if (ch === '-') { add('MINUS', '-', startLine, startCol); i++; col++; continue }
        if (ch === '*') { add('STAR', '*', startLine, startCol); i++; col++; continue }
        if (ch === '/') { add('SLASH', '/', startLine, startCol); i++; col++; continue }

        // Triple-quoted strings (multi-line) - must check before single quotes
        if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
            let j = i + 3
            // Find closing """
            while (j < src.length - 2) {
                if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') {
                    break
                }
                if (src[j] === '\n') {
                    line++
                    col = 0 // Will be set correctly after loop
                }
                j++
            }
            if (j >= src.length - 2 || !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) {
                throw new SyntaxError(`Unterminated triple-quoted string at line ${startLine} col ${startCol}`)
            }
            // Extract string content without the triple quotes
            const content = src.slice(i + 3, j)
            add('STRING', content, startLine, startCol)
            // Update position past closing """
            const lines = content.split('\n')
            if (lines.length > 1) {
                col = lines[lines.length - 1].length + 4 // +3 for closing """ +1 for next char
            } else {
                col += j - i + 3
            }
            i = j + 3
            continue
        }

        if (ch === '"' || ch === '\'') {
            const quote = ch
            let j = i + 1
            while (j < src.length && src[j] !== quote && src[j] !== '\n') {
                // Handle escape sequences
                if (src[j] === '\\' && j + 1 < src.length) {
                    j += 2
                } else {
                    j++
                }
            }
            if (j >= src.length || src[j] === '\n') {
                throw new SyntaxError(`Unterminated string literal at line ${line} col ${col}`)
            }
            // Extract string content without quotes
            const content = src.slice(i + 1, j)
            add('STRING', content, startLine, startCol)
            col += j - i + 1
            i = j + 1
            continue
        }

        if (isDigit(ch)) {
            let j = i
            while (j < src.length && isDigit(src[j])) j++
            if (src[j] === '.' && isDigit(src[j + 1])) {
                j++
                while (j < src.length && isDigit(src[j])) j++
            }
            const lexeme = src.slice(i, j)
            add('NUMBER', lexeme, startLine, startCol)
            col += j - i
            i = j
            continue
        }

        if (isLetter(ch) || ch === '_') {
            let j = i
            while (j < src.length && (isLetter(src[j]) || isDigit(src[j]) || src[j] === '_')) j++
            const lexeme = src.slice(i, j)
            if (keywords[lexeme]) {
                add(keywords[lexeme], lexeme, startLine, startCol)
            } else {
                add('IDENT', lexeme, startLine, startCol)
            }
            col += j - i
            i = j
            continue
        }

        throw new SyntaxError(`Unexpected character '${ch}' at line ${line} col ${col}`)
    }

    add('EOF', '', line, col)
    return tokens
}
