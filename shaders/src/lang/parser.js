/**
 * Recursive-descent parser for the Polymorphic DSL.
 *
 * Grammar (EBNF):
 * Program        ::= SearchDirective? Statement* RenderDirective?
 * SearchDirective::= 'search' Ident (',' Ident)*
 * Statement      ::= VarAssign | ChainStmt | IfStmt | Break | Continue | Return
 * RenderDirective::= 'render' '(' OutputRef ')'
 * Block          ::= '{' Statement* '}'
 * IfStmt         ::= 'if' '(' Expr ')' Block ('elif' '(' Expr ')' Block)* ('else' Block)?
 * Break          ::= 'break'
 * Continue       ::= 'continue'
 * Return         ::= 'return' Expr?
 * VarAssign      ::= 'let' Ident '=' Expr
 * ChainStmt      ::= Chain
 * Chain          ::= ChainElement ('.' ChainElement)*
 * ChainElement   ::= Call | WriteNode | Write3DNode
 * WriteNode      ::= 'write' '(' OutputRef ')'     // Chainable - writes to surface & passes through
 * Write3DNode    ::= 'write3d' '(' Ident ',' Ident ')'
 * Expr           ::= Chain | NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | SourceRef | Func | '(' Expr ')'
 * Call           ::= Ident '(' ArgList? ')'
 * ArgList        ::= Arg (',' Arg)* ','?
 * Arg            ::= NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | SourceRef | Func
 * NumberExpr     ::= Number | 'Math.PI' | '(' NumberExpr ')' | NumberExpr ( '+' | '-' | '*' | '/' ) NumberExpr
 * Member         ::= Ident ('.' Ident)+
 * Func           ::= '(' ')' '=>' Expr
 * OutputRef      ::= 'o' Digit         // Global surface (o0-o7)
 * Ident          ::= Letter ( Letter | Digit | '_' )*
 * Number         ::= Digit+ ( '.' Digit+ )?
 * String         ::= '"' [^"\n]* '"'
 * Digit          ::= '0'…'9'
 * Letter         ::= 'A'…'Z' | 'a'…'z'
 * Boolean        ::= 'true' | 'false'
 * Color          ::= '#' HexDigit HexDigit HexDigit ( HexDigit HexDigit HexDigit )?
 * HexDigit       ::= Digit | 'A'…'F' | 'a'…'f'
 *
 * Special Call Transformations:
 * - read(surface) → Read node for surface textures
 * - read3d(tex3d, geo) → Read3D node
 * - osc(oscKind, ...) → Oscillator node
 *
 * @param {Array} tokens Token stream from the lexer
 * @returns {object} AST
 */
import { isValidNamespace, VALID_NAMESPACES } from '../runtime/tags.js'

export function parse(tokens) {
    let current = 0

    // Track the search order for the program (set by search directive - REQUIRED)
    let programSearchOrder = null

    // Program namespace starts empty - must be set by search directive
    const programNamespace = {
        imports: [],
        default: null
    }

    const peek = () => tokens[current]
    const advance = () => tokens[current++]
    const expect = (type, msg) => {
        const token = peek()
        if (token.type === type) return advance()
        throw new SyntaxError(`${msg} at line ${token.line} col ${token.col}`)
    }

    /**
     * Collect and consume any pending COMMENT tokens.
     * Returns array of comment text strings.
     */
    function collectComments() {
        const comments = []
        while (peek()?.type === 'COMMENT') {
            comments.push(advance().lexeme)
        }
        return comments
    }

    const exprStartTokens = new Set([
        'PLUS', 'MINUS', 'NUMBER', 'HEX', 'FUNC', 'STRING',
        'IDENT', 'OUTPUT_REF', 'SOURCE_REF', 'VOL_REF', 'GEO_REF', 'MESH_REF',
        'XYZ_REF', 'VEL_REF', 'RGBA_REF', 'LPAREN', 'LBRACKET', 'LBRACE',
        'TRUE', 'FALSE'
    ])

    const memberTokenTypes = new Set([
        'IDENT', 'SOURCE_REF', 'OUTPUT_REF', 'VOL_REF', 'GEO_REF', 'MESH_REF',
        'XYZ_REF', 'VEL_REF', 'RGBA_REF',
        'LET', 'RENDER', 'TRUE', 'FALSE', 'IF', 'ELIF', 'ELSE',
        'BREAK', 'CONTINUE', 'RETURN', 'WRITE', 'WRITE3D', 'SUBCHAIN'
    ])

    const cloneNamespaceMeta = (meta) => {
        if (!meta || typeof meta !== 'object') { return null }
        try {
            if (typeof structuredClone === 'function') {
                return structuredClone(meta)
            }
        } catch {
            // fall back to JSON clone
        }
        try {
            return JSON.parse(JSON.stringify(meta))
        } catch {
            return null
        }
    }

    /**
     * Transform an osc() call into an Oscillator AST node.
     *
     * Oscillator signature:
     * osc(type, min?, max?, speed?, offset?, seed?)
     *
     * All params except 'type' are optional and support kwargs.
     *
     * type: oscKind enum (sine, tri, saw, sawInv, square, noise)
     * min: low end of the normalized [0, 1] output sub-range (default 0)
     * max: high end of the normalized [0, 1] output sub-range (default 1)
     * speed: integer multiplier for animation duration (default 1)
     * offset: phase offset 0..1 (default 0)
     * seed: noise seed (default 1, only used for noise type)
     */
    function transformOscInvocation(call, nameToken) {
        const args = Array.isArray(call.args) ? call.args : []
        const kwargs = call.kwargs || {}

        // Parameter order: type, min, max, speed, offset, seed
        const paramOrder = ['type', 'min', 'max', 'speed', 'offset', 'seed']
        const validParams = new Set(paramOrder)
        const defaults = {
            type: { type: 'Member', path: ['oscKind', 'sine'] },
            min: { type: 'Number', value: 0 },
            max: { type: 'Number', value: 1 },
            speed: { type: 'Number', value: 1 },
            offset: { type: 'Number', value: 0 },
            seed: { type: 'Number', value: 1 }
        }

        // Validate kwargs - reject unknown parameters
        for (const key of Object.keys(kwargs)) {
            if (!validParams.has(key)) {
                throw new SyntaxError(`osc() unknown parameter '${key}' at line ${nameToken.line} col ${nameToken.col}. Valid: ${paramOrder.join(', ')}`)
            }
        }

        const resolved = {}

        // Resolve each parameter from positional args or kwargs
        for (let i = 0; i < paramOrder.length; i++) {
            const paramName = paramOrder[i]
            if (kwargs[paramName] !== undefined) {
                resolved[paramName] = kwargs[paramName]
            } else if (i < args.length) {
                resolved[paramName] = args[i]
            } else if (defaults[paramName] !== undefined) {
                resolved[paramName] = defaults[paramName]
            }
        }

        const typeNode = resolved.type

        return {
            type: 'Oscillator',
            oscType: typeNode,
            min: resolved.min,
            max: resolved.max,
            speed: resolved.speed,
            offset: resolved.offset,
            seed: resolved.seed,
            loc: { line: nameToken.line, col: nameToken.col }
        }
    }

    /**
     * Transform a midi() call into a Midi AST node.
     *
     * Midi signature:
     * midi(channel, mode?, min?, max?, sensitivity?)
     *
     * channel: MIDI channel 1-16 (required)
     * mode: midiMode enum (default midiMode.velocity)
     * min: low end of the normalized [0, 1] output sub-range (default 0)
     * max: high end of the normalized [0, 1] output sub-range (default 1)
     * sensitivity: trigger falloff rate (default 1)
     */
    function transformMidiInvocation(call, nameToken) {
        const args = Array.isArray(call.args) ? call.args : []
        const kwargs = call.kwargs || {}

        // Parameter order: channel, mode, min, max, sensitivity
        const paramOrder = ['channel', 'mode', 'min', 'max', 'sensitivity']
        const defaults = {
            mode: { type: 'Member', path: ['midiMode', 'velocity'] },
            min: { type: 'Number', value: 0 },
            max: { type: 'Number', value: 1 },
            sensitivity: { type: 'Number', value: 1 }
        }

        const resolved = {}

        // Resolve each parameter from positional args or kwargs
        for (let i = 0; i < paramOrder.length; i++) {
            const paramName = paramOrder[i]
            if (kwargs[paramName] !== undefined) {
                resolved[paramName] = kwargs[paramName]
            } else if (i < args.length) {
                resolved[paramName] = args[i]
            } else if (defaults[paramName] !== undefined) {
                resolved[paramName] = defaults[paramName]
            }
        }

        if (!resolved.channel) {
            throw new SyntaxError(`midi() requires 'channel' argument at line ${nameToken.line} col ${nameToken.col}`)
        }

        return {
            type: 'Midi',
            channel: resolved.channel,
            mode: resolved.mode,
            min: resolved.min,
            max: resolved.max,
            sensitivity: resolved.sensitivity,
            loc: { line: nameToken.line, col: nameToken.col }
        }
    }

    /**
     * Transform an audio() call into an Audio AST node.
     *
     * Audio signature:
     * audio(band, min?, max?)
     *
     * band: audioBand enum (required) - low, mid, high, vol
     * min: low end of the normalized [0, 1] output sub-range (default 0)
     * max: high end of the normalized [0, 1] output sub-range (default 1)
     */
    function transformAudioInvocation(call, nameToken) {
        const args = Array.isArray(call.args) ? call.args : []
        const kwargs = call.kwargs || {}

        // Parameter order: band, min, max
        const paramOrder = ['band', 'min', 'max']
        const defaults = {
            min: { type: 'Number', value: 0 },
            max: { type: 'Number', value: 1 }
        }

        const resolved = {}

        // Resolve each parameter from positional args or kwargs
        for (let i = 0; i < paramOrder.length; i++) {
            const paramName = paramOrder[i]
            if (kwargs[paramName] !== undefined) {
                resolved[paramName] = kwargs[paramName]
            } else if (i < args.length) {
                resolved[paramName] = args[i]
            } else if (defaults[paramName] !== undefined) {
                resolved[paramName] = defaults[paramName]
            }
        }

        if (!resolved.band) {
            throw new SyntaxError(`audio() requires 'band' argument at line ${nameToken.line} col ${nameToken.col}`)
        }

        return {
            type: 'Audio',
            band: resolved.band,
            min: resolved.min,
            max: resolved.max,
            loc: { line: nameToken.line, col: nameToken.col }
        }
    }

    function transformFromInvocation(call, nameToken) {
        const fail = (message) => {
            if (nameToken && typeof nameToken.line === 'number' && typeof nameToken.col === 'number') {
                throw new SyntaxError(`${message} at line ${nameToken.line} col ${nameToken.col}`)
            }
            throw new SyntaxError(message)
        }
        if (call.kwargs && Object.keys(call.kwargs).length) {
            fail("'from' does not support named arguments")
        }
        const args = Array.isArray(call.args) ? call.args : []
        if (args.length !== 2) {
            fail("'from' requires exactly two arguments (namespace, call)")
        }
        const [namespaceArg, targetArg] = args
        if (!namespaceArg || (namespaceArg.type !== 'Ident' && namespaceArg.type !== 'Member')) {
            fail("'from' namespace argument must be an identifier")
        }
        const namespaceName = namespaceArg.type === 'Member' ? namespaceArg.path.join('.') : namespaceArg.name
        if (!namespaceName) {
            fail("'from' namespace argument must be non-empty")
        }
        let targetCall = null
        if (targetArg && targetArg.type === 'Call') {
            targetCall = targetArg
        } else if (targetArg && targetArg.type === 'Chain' && Array.isArray(targetArg.chain) && targetArg.chain.length === 1) {
            const head = targetArg.chain[0]
            if (head && head.type === 'Call') {
                targetCall = head
            }
        }
        if (!targetCall) {
            fail("'from' second argument must be a call expression")
        }
        const replacement = {
            ...targetCall,
            args: Array.isArray(targetCall.args) ? targetCall.args.map((arg) => arg) : []
        }
        if (targetCall.kwargs) {
            replacement.kwargs = { ...targetCall.kwargs }
        }
        // from() creates a namespace override that puts the specified namespace first
        const overrideNamespace = {
            name: namespaceName,
            path: [namespaceName],
            explicit: true,
            source: 'from',
            resolved: namespaceName,
            searchOrder: [namespaceName],
            fromOverride: true
        }
        replacement.namespace = overrideNamespace
        return replacement
    }

    function hasCallAfterDot(index) {
        let i = index + 1
        if (tokens[i]?.type !== 'DOT') { return false }
        while (tokens[i]?.type === 'DOT') {
            const segToken = tokens[i + 1]
            if (!segToken || !memberTokenTypes.has(segToken.type)) { return false }
            i += 2
        }
        return tokens[i]?.type === 'LPAREN'
    }

    function parseRenderDirective() {
        advance()
        expect('LPAREN', "Expect '('")
        if (peek().type !== 'OUTPUT_REF') {
            throw new SyntaxError('Expected output reference in render()')
        }
        const out = { type: 'OutputRef', name: advance().lexeme }
        expect('RPAREN', "Expect ')'")
        return out
    }

    function parseProgram() {
        const plans = []
        const vars = []
        let render = null
        const trailingComments = []

        const appendStatement = (stmt) => {
            if (!stmt || typeof stmt !== 'object') { return }
            if (stmt.type === 'VarAssign') {
                vars.push(stmt)
            } else {
                plans.push(stmt)
            }
        }

        const consumeRender = () => {
            if (render) {
                const t = peek()
                throw new SyntaxError(`Duplicate render() directive at line ${t.line} col ${t.col}`)
            }
            render = parseRenderDirective()
            while (peek().type === 'SEMICOLON') advance()
        }

        // Token types that can be used as namespace identifiers
        // (keywords like 'render' are valid namespace names in search context)
        const namespaceTokenTypes = new Set([
            'IDENT', 'RENDER', 'WRITE', 'WRITE3D', 'TRUE', 'FALSE',
            'IF', 'ELIF', 'ELSE', 'BREAK', 'CONTINUE', 'RETURN'
        ])

        // Parse the search directive: search ns1, ns2, ns3
        function parseSearchDirective() {
            if (programSearchOrder !== null) {
                const t = peek()
                throw new SyntaxError(`Only one search directive is allowed per program at line ${t.line} col ${t.col}`)
            }
            advance() // consume 'search'
            const namespaces = []

            // Helper to validate a namespace identifier
            function validateNamespace(token) {
                const ns = token.lexeme
                if (!isValidNamespace(ns)) {
                    throw new SyntaxError(`Invalid namespace '${ns}' at line ${token.line} col ${token.col}. Valid namespaces: ${VALID_NAMESPACES.join(', ')}`)
                }
            }

            // Expect at least one namespace identifier (allow keywords as namespace names)
            const firstToken = peek()
            if (!namespaceTokenTypes.has(firstToken.type)) {
                throw new SyntaxError(`Expected namespace identifier after search at line ${firstToken.line} col ${firstToken.col}`)
            }
            advance()
            validateNamespace(firstToken)
            namespaces.push(firstToken.lexeme)
            // Parse additional comma-separated namespaces
            while (peek().type === 'COMMA') {
                advance() // consume ','
                const nsToken = peek()
                if (!namespaceTokenTypes.has(nsToken.type)) {
                    throw new SyntaxError(`Expected namespace identifier after comma at line ${nsToken.line} col ${nsToken.col}`)
                }
                advance()
                validateNamespace(nsToken)
                namespaces.push(nsToken.lexeme)
            }
            programSearchOrder = namespaces
            // Update the programNamespace to reflect the explicit search order
            programNamespace.imports = namespaces.map((name) => ({
                name,
                source: 'search',
                explicit: true
            }))
            programNamespace.default = { name: namespaces[0], source: 'search', explicit: true }
            while (peek().type === 'SEMICOLON') advance()
        }

        while (peek().type !== 'EOF') {
            if (peek().type === 'SEMICOLON') { advance(); continue }
            // Collect any leading comments before this statement
            const leadingComments = collectComments()
            if (peek().type === 'EOF') {
                // Trailing comments at end of program
                if (leadingComments.length > 0) {
                    trailingComments.push(...leadingComments)
                }
                break
            }
            if (peek().type === 'SEMICOLON') { continue }
            if (peek().type === 'SEARCH') {
                if (plans.length || vars.length || render) {
                    const t = peek()
                    throw new SyntaxError(`'search' directive must appear before other statements at line ${t.line} col ${t.col}`)
                }
                parseSearchDirective()
                continue
            }
            if (peek().type === 'RENDER') {
                consumeRender()
                // Attach leading comments to render if present
                if (leadingComments.length > 0 && render) {
                    render.leadingComments = leadingComments
                }
                // Collect any trailing comments after render
                const trailing = collectComments()
                if (trailing.length > 0) {
                    trailingComments.push(...trailing)
                }
                break
            }
            const stmt = parseStatement()
            // Attach leading comments to the statement
            if (leadingComments.length > 0 && stmt) {
                stmt.leadingComments = leadingComments
            }
            appendStatement(stmt)
            while (peek().type === 'SEMICOLON') advance()
        }
        expect('EOF', 'Expected end of input')
        if (!programSearchOrder || programSearchOrder.length === 0) {
            throw new SyntaxError("Missing required 'search' directive. Every program must start with 'search <namespace>, ...' to specify namespace search order.")
        }

        const program = { type: 'Program', plans, render }
        if (vars.length) { program.vars = vars }
        if (trailingComments.length) { program.trailingComments = trailingComments }

        const searchOrder = programSearchOrder.slice()
        let namespaceMeta = cloneNamespaceMeta({
            imports: programNamespace.imports,
            default: programNamespace.default,
            searchOrder
        })
        if (!namespaceMeta) {
            const importsClone = programNamespace.imports.map((entry) => ({ ...entry }))
            const defaultClone = programNamespace.default ? { ...programNamespace.default } : null
            namespaceMeta = { imports: importsClone, default: defaultClone, searchOrder: searchOrder.slice() }
        }
        program.namespace = namespaceMeta
        return program
    }

    function parseBlock() {
        expect('LBRACE', "Expect '{'")
        const body = []
        while (peek().type !== 'RBRACE') {
            const stmt = parseStatement()
            body.push(stmt)
            while (peek().type === 'SEMICOLON') advance()
        }
        expect('RBRACE', "Expect '}'")
        return body
    }

    function parseStatement() {
        if (peek().type === 'SEARCH') {
            const t = peek()
            throw new SyntaxError(`'search' directive is only allowed at the start of the program at line ${t.line} col ${t.col}`)
        }
        if (peek().type === 'LET') {
            advance()
            const name = expect('IDENT', 'Expected identifier').lexeme
            expect('EQUAL', "Expect '='")
            if (!exprStartTokens.has(peek().type)) {
                const t = peek()
                throw new SyntaxError(`Expected expression after '=' at line ${t.line} col ${t.col}`)
            }
            const expr = parseAdditive()
            return {type: 'VarAssign', name, expr}
        }

        switch (peek().type) {
            case 'IF': {
                advance()
                expect('LPAREN', "Expect '('")
                const condition = parseAdditive()
                expect('RPAREN', "Expect ')'")
                const then = parseBlock()
                const elif = []
                while (peek().type === 'ELIF') {
                    advance()
                    expect('LPAREN', "Expect '('")
                    const ec = parseAdditive()
                    expect('RPAREN', "Expect ')'")
                    const body = parseBlock()
                    elif.push({condition: ec, then: body})
                }
                let elseBranch = null
                if (peek().type === 'ELSE') {
                    advance()
                    elseBranch = parseBlock()
                }
                return {type: 'IfStmt', condition, then, elif, else: elseBranch}
            }
            case 'BREAK': {
                advance()
                return {type: 'Break'}
            }
            case 'CONTINUE': {
                advance()
                return {type: 'Continue'}
            }
            case 'RETURN': {
                advance()
                if (exprStartTokens.has(peek().type)) {
                    const value = parseAdditive()
                    return {type: 'Return', value}
                }
                return {type: 'Return'}
            }
        }

        const chain = parseChain()
        // Extract write/write3d only if the chain TERMINATES with a Write/Write3D node
        // Chains must end with write() - mid-chain writes don't count as terminal
        let write = null
        let write3d = null
        if (chain.length > 0) {
            const lastNode = chain[chain.length - 1]
            if (lastNode.type === 'Write') {
                write = lastNode.surface
            } else if (lastNode.type === 'Write3D') {
                write3d = { tex3d: lastNode.tex3d, geo: lastNode.geo }
            }
        }
        // If chain doesn't end with write(), write remains null.
        // The validator will produce S006 for starter chains missing terminal write().

        return {chain, write, write3d}
    }

    function parseChain(context = 'statement') {
        const firstCall = parseCall()
        const calls = [firstCall]
        // Comments can appear before the DOT in a chain
        // e.g., noise() \n // comment \n .bloom()
        while (true) {
            // Save position before collecting comments
            const savedPos = current
            // Collect any comments that might precede the DOT
            const leadingComments = collectComments()
            if (peek().type !== 'DOT') {
                // No more chaining - restore position so comments belong to next statement
                current = savedPos
                break
            }
            advance() // consume '.'
            // Now collect any additional comments after the DOT
            const postDotComments = collectComments()
            const allComments = [...leadingComments, ...postDotComments]

            const nextType = peek().type
            if (nextType === 'WRITE' || nextType === 'WRITE3D') {
                if (context === 'expression') {
                    const t = peek()
                    throw new SyntaxError(`'.write()' is only allowed in statement context at line ${t.line} col ${t.col}`)
                }
                // Parse write/write3d as a node in the chain (chainable)
                const writeNode = parseWriteCall()
                if (allComments.length > 0) {
                    writeNode.leadingComments = allComments
                }
                calls.push(writeNode)
                // Continue parsing - write is now chainable
                continue
            }
            if (nextType === 'SUBCHAIN') {
                // Parse subchain as a node in the chain (chainable)
                const subchainNode = parseSubchainCall()
                if (allComments.length > 0) {
                    subchainNode.leadingComments = allComments
                }
                calls.push(subchainNode)
                // Continue parsing - subchain is chainable
                continue
            }
            const call = parseCall()
            if (allComments.length > 0) {
                call.leadingComments = allComments
            }
            calls.push(call)
        }
        return calls
    }

    function parseWriteCall() {
        const tokenType = peek().type
        const tokenLine = peek().line
        const tokenCol = peek().col

        if (tokenType === 'WRITE') {
            advance() // consume 'write'
            expect('LPAREN', "Expect '('")
            let surface = null
            if (peek().type === 'OUTPUT_REF') {
                surface = { type: 'OutputRef', name: advance().lexeme }
            } else if (peek().type === 'XYZ_REF') {
                surface = { type: 'XyzRef', name: advance().lexeme }
            } else if (peek().type === 'VEL_REF') {
                surface = { type: 'VelRef', name: advance().lexeme }
            } else if (peek().type === 'RGBA_REF') {
                surface = { type: 'RgbaRef', name: advance().lexeme }
            } else if (peek().type === 'MESH_REF') {
                surface = { type: 'MeshRef', name: advance().lexeme }
            } else if (peek().type === 'IDENT' && peek().lexeme === 'none') {
                // "none" is a valid target meaning "don't write to any surface"
                surface = { type: 'OutputRef', name: advance().lexeme }
            } else {
                throw new SyntaxError(`write() requires an explicit surface reference (e.g., o0, o1, xyz0, vel0, rgba0, mesh0, none) at line ${peek().line} col ${peek().col}`)
            }
            expect('RPAREN', "Expect ')'")
            return {
                type: 'Write',
                surface: surface,
                loc: { line: tokenLine, col: tokenCol }
            }
        } else if (tokenType === 'WRITE3D') {
            advance() // consume 'write3d'
            expect('LPAREN', "Expect '('")
            // Parse tex3d reference
            let tex3d = null
            if (peek().type === 'IDENT' || peek().type === 'OUTPUT_REF' || peek().type === 'VOL_REF') {
                const tokType = peek().type
                tex3d = tokType === 'OUTPUT_REF'
                    ? { type: 'OutputRef', name: advance().lexeme }
                    : tokType === 'VOL_REF'
                        ? { type: 'VolRef', name: advance().lexeme }
                        : { type: 'Ident', name: advance().lexeme }
            } else {
                throw new SyntaxError(`Expected tex3d reference in write3d() at line ${peek().line} col ${peek().col}`)
            }
            expect('COMMA', "Expect ',' between tex3d and geo in write3d()")
            // Parse geo reference
            let geo = null
            if (peek().type === 'IDENT' || peek().type === 'OUTPUT_REF' || peek().type === 'GEO_REF') {
                const tokType = peek().type
                geo = tokType === 'OUTPUT_REF'
                    ? { type: 'OutputRef', name: advance().lexeme }
                    : tokType === 'GEO_REF'
                        ? { type: 'GeoRef', name: advance().lexeme }
                        : { type: 'Ident', name: advance().lexeme }
            } else {
                throw new SyntaxError(`Expected geo reference in write3d() at line ${peek().line} col ${peek().col}`)
            }
            expect('RPAREN', "Expect ')'")
            return {
                type: 'Write3D',
                tex3d: tex3d,
                geo: geo,
                loc: { line: tokenLine, col: tokenCol }
            }
        }
        throw new SyntaxError(`Expected write or write3d at line ${tokenLine} col ${tokenCol}`)
    }

    /**
     * Parse a subchain block: subchain(name: "...", id: "...") { .effect1() .effect2() }
     *
     * Subchains are atomic encapsulations of contiguous effects within a chain.
     * They preserve chain semantics - the output of each effect feeds the next.
     *
     * Syntax:
     *   .subchain(name: "feedback loop", id: "sc1") {
     *     .loopBegin()
     *     .loopEnd()
     *   }
     *
     * The inner chain elements start with dots and are chained together.
     * The subchain as a whole is chainable - it takes input and produces output.
     */
    function parseSubchainCall() {
        const tokenLine = peek().line
        const tokenCol = peek().col

        advance() // consume 'subchain'
        expect('LPAREN', "Expect '(' after subchain")

        // Parse subchain arguments (name and optional id)
        const kwargs = {}
        if (peek().type !== 'RPAREN') {
            // Check for keyword or positional first argument
            if (peek().type === 'STRING') {
                // Positional name: subchain("name")
                kwargs.name = { type: 'String', value: advance().lexeme }
            } else if (peek().type === 'IDENT' && tokens[current + 1]?.type === 'COLON') {
                // Keyword arguments: subchain(name: "...", id: "...")
                while (peek().type === 'IDENT' && tokens[current + 1]?.type === 'COLON') {
                    const key = advance().lexeme
                    advance() // consume ':'
                    if (peek().type !== 'STRING') {
                        throw new SyntaxError(`Expected string value for subchain ${key} at line ${peek().line} col ${peek().col}`)
                    }
                    kwargs[key] = { type: 'String', value: advance().lexeme }
                    if (peek().type === 'COMMA') {
                        advance() // consume ','
                    }
                }
            }
        }
        expect('RPAREN', "Expect ')' after subchain arguments")

        // Parse the subchain body block
        expect('LBRACE', "Expect '{' to start subchain body")

        // Parse chain elements inside the block
        // Each element starts with a dot: { .effect1() .effect2() }
        const body = []
        while (peek().type !== 'RBRACE') {
            // Collect any leading comments
            const leadingComments = collectComments()
            if (peek().type === 'RBRACE') break

            // Each chain element must start with a dot
            if (peek().type !== 'DOT') {
                throw new SyntaxError(`Expected '.' before chain element in subchain body at line ${peek().line} col ${peek().col}`)
            }
            advance() // consume '.'

            // Collect post-dot comments
            const postDotComments = collectComments()
            const allComments = [...leadingComments, ...postDotComments]

            // Parse the call
            const call = parseCall()
            if (allComments.length > 0) {
                call.leadingComments = allComments
            }
            body.push(call)
        }

        expect('RBRACE', "Expect '}' to end subchain body")

        if (body.length === 0) {
            throw new SyntaxError(`Subchain body cannot be empty at line ${tokenLine} col ${tokenCol}`)
        }

        return {
            type: 'Subchain',
            name: kwargs.name?.value || null,
            id: kwargs.id?.value || null,
            body: body,
            loc: { line: tokenLine, col: tokenCol }
        }
    }

    function parseCall() {
        const nameToken = expect('IDENT', 'Expected identifier')
        // Inline namespace syntax (e.g., nd.noise()) is forbidden
        // If we see a DOT followed by an IDENT followed by LPAREN, that's an error
        if (peek().type === 'DOT') {
            const next = tokens[current + 1]
            if (next && next.type === 'IDENT') {
                const after = tokens[current + 2]
                if (after?.type === 'LPAREN') {
                    throw new SyntaxError(
                        `Inline namespace syntax '${nameToken.lexeme}.${next.lexeme}()' is not allowed. ` +
                        `Use 'search ${nameToken.lexeme}' at the start of the program instead, ` +
                        `at line ${nameToken.line} col ${nameToken.col}`
                    )
                }
            }
        }
        expect('LPAREN', "Expect '('")
        const args = []
        const kwargs = {}
        let keyword = false

        function parseNextArg() {
            if (peek().type === 'IDENT' && tokens[current + 1]?.type === 'COLON') {
                keyword = true
                parseKwarg(kwargs)
            } else {
                args.push(parseArg())
            }
        }

        if (peek().type !== 'RPAREN') {
            parseNextArg()
            while (peek().type === 'COMMA') {
                advance()
                if (peek().type === 'RPAREN') break
                parseNextArg()
            }
        }
        expect('RPAREN', "Expect ')'")
        const call = {type: 'Call', name: nameToken.lexeme, args}
        if (keyword) call.kwargs = kwargs
        if (nameToken.lexeme === 'from') {
            return transformFromInvocation(call, nameToken)
        }
        // osc() as a value oscillator (not the synth.osc generator effect)
        // Oscillator kwargs: type, min, max, speed, offset, seed
        if (nameToken.lexeme === 'osc') {
            const oscKwargs = new Set(['type', 'min', 'max', 'speed', 'offset', 'seed'])
            const hasTypeKwarg = kwargs && 'type' in kwargs
            const firstArgIsOscKind = args.length > 0 && args[0] &&
                args[0].type === 'Member' && args[0].path && args[0].path[0] === 'oscKind'
            const isBareOsc = args.length === 0 && (!kwargs || Object.keys(kwargs).length === 0)
            // Check if all kwargs are valid oscillator parameters
            const hasOnlyOscKwargs = kwargs && Object.keys(kwargs).length > 0 &&
                Object.keys(kwargs).every(k => oscKwargs.has(k))
            if (hasTypeKwarg || firstArgIsOscKind || isBareOsc || hasOnlyOscKwargs) {
                return transformOscInvocation(call, nameToken)
            }
            // Fall through to return as regular Call node for synth effect
        }
        if (nameToken.lexeme === 'midi') {
            return transformMidiInvocation(call, nameToken)
        }
        if (nameToken.lexeme === 'audio') {
            return transformAudioInvocation(call, nameToken)
        }
        // read() is a pipeline built-in for reading 2D surfaces (semantic inverse of write)
        if (nameToken.lexeme === 'read') {
            // Extract surface reference from args or kwargs
            let surface = args[0] || kwargs.tex || kwargs.surface
            const node = {
                type: 'Read',
                surface: surface,
                loc: { line: nameToken.line, col: nameToken.col }
            }
            // Preserve _skip flag if present (kwargs._skip is a Boolean AST node)
            if (kwargs._skip?.type === 'Boolean' && kwargs._skip.value === true) {
                node._skip = true
            }
            return node
        }
        // read3d() reads from tex3d (and optionally geo) surfaces
        // 1 arg: read3d(vol0) - returns volume reference for use in params
        // 2 args: read3d(vol0, geo0) - starter node that samples 3D texture
        if (nameToken.lexeme === 'read3d') {
            let tex3d = args[0] || kwargs.tex3d
            let geo = args[1] || kwargs.geo
            const node = {
                type: 'Read3D',
                tex3d: tex3d,
                geo: geo || null,  // null for single-arg form
                loc: { line: nameToken.line, col: nameToken.col }
            }
            // Preserve _skip flag if present (kwargs._skip is a Boolean AST node)
            if (kwargs._skip?.type === 'Boolean' && kwargs._skip.value === true) {
                node._skip = true
            }
            return node
        }
        return call
    }

    function parseArg() {
        return parseAdditive()
    }

    function parseAdditive() {
        let node = parseMultiplicative()
        while (peek().type === 'PLUS' || peek().type === 'MINUS') {
            const op = advance().type
            const right = parseMultiplicative()
            const l = toNumber(node)
            const r = toNumber(right)
            node = {type: 'Number', value: op === 'PLUS' ? l + r : l - r}
        }
        return node
    }

    function parseMultiplicative() {
        let node = parseUnary()
        while (peek().type === 'STAR' || peek().type === 'SLASH') {
            const op = advance().type
            const right = parseUnary()
            const l = toNumber(node)
            const r = toNumber(right)
            node = {type: 'Number', value: op === 'STAR' ? l * r : l / r}
        }
        return node
    }

    function parseUnary() {
        if (peek().type === 'PLUS') {
            advance()
            return parseUnary()
        }
        if (peek().type === 'MINUS') {
            advance()
            const val = parseUnary()
            return {type: 'Number', value: -toNumber(val)}
        }
        return parsePrimary()
    }

    function parsePrimary() {
        const token = peek()
        switch (token.type) {
            case 'NUMBER':
                advance()
                return {type: 'Number', value: parseFloat(token.lexeme)}
            case 'STRING':
                advance()
                return {type: 'String', value: token.lexeme}
            case 'HEX': {
                advance()
                const hex = token.lexeme.slice(1)
                let r, g, b, a = 1.0
                if (hex.length === 3) {
                    r = parseInt(hex[0] + hex[0], 16)
                    g = parseInt(hex[1] + hex[1], 16)
                    b = parseInt(hex[2] + hex[2], 16)
                } else if (hex.length === 6) {
                    r = parseInt(hex.slice(0, 2), 16)
                    g = parseInt(hex.slice(2, 4), 16)
                    b = parseInt(hex.slice(4, 6), 16)
                } else if (hex.length === 8) {
                    r = parseInt(hex.slice(0, 2), 16)
                    g = parseInt(hex.slice(2, 4), 16)
                    b = parseInt(hex.slice(4, 6), 16)
                    a = parseInt(hex.slice(6, 8), 16) / 255
                }
                return {type: 'Color', value: [r / 255, g / 255, b / 255, a]}
            }
            case 'LBRACKET': {
                // Array literal — comma-separated arg expressions, used as
                // an alternate input form for vec2/vec3/vec4 parameters.
                // Existing programs (vecN(...) calls, hex colors) are
                // unaffected: this branch only fires when the source
                // contains a literal `[`.
                const startLine = token.line
                const startCol = token.col
                advance()
                const elements = []
                if (peek().type !== 'RBRACKET') {
                    elements.push(parseArg())
                    while (peek().type === 'COMMA') {
                        advance()
                        elements.push(parseArg())
                    }
                }
                if (peek().type !== 'RBRACKET') {
                    const t = peek()
                    throw new SyntaxError(`Expected ']' at line ${t.line} col ${t.col}`)
                }
                advance()
                return {type: 'ArrayLiteral', elements, loc: { line: startLine, col: startCol }}
            }
            case 'FUNC':
                advance()
                return {type: 'Func', src: token.lexeme}
            case 'TRUE':
                advance()
                return {type: 'Boolean', value: true}
            case 'FALSE':
                advance()
                return {type: 'Boolean', value: false}
            case 'IDENT': {
                if (token.lexeme === 'Math' && tokens[current + 1]?.type === 'DOT' && tokens[current + 2]?.type === 'IDENT' && tokens[current + 2].lexeme === 'PI') {
                    advance()
                    advance()
                    advance()
                    return {type: 'Number', value: Math.PI}
                }
                if (tokens[current + 1]?.type === 'LPAREN' || hasCallAfterDot(current)) {
                    const chain = parseChain('expression')
                    return chain.length === 1 ? chain[0] : {type: 'Chain', chain}
                }
                // handle dotted enum paths like foo.bar.baz. Enum segments may
                // include tokens that would otherwise be treated as keywords or
                // source/output references (e.g. `sparky.loop.tri`,
                // `disp.source.o1`). Allow a broader set of token types in
                // member chains and only terminate when the segment is followed
                // by a call expression.
                advance()
                const path = [token.lexeme]
                while (peek().type === 'DOT') {
                    const next = tokens[current + 1]
                    if (!next) break
                    if (tokens[current + 2]?.type === 'LPAREN') break
                    if (!memberTokenTypes.has(next.type)) {
                        throw new SyntaxError(`Expected identifier after '.' at line ${next.line} col ${next.col}`)
                    }
                    advance() // consume '.'
                    advance() // consume segment token stored in next
                    path.push(next.lexeme)
                }
                if (path.length > 1) {
                    return {type: 'Member', path}
                }
                return {type: 'Ident', name: path[0]}
            }
            case 'OUTPUT_REF':
                advance()
                return {type: 'OutputRef', name: token.lexeme}
            case 'SOURCE_REF':
                advance()
                return {type: 'SourceRef', name: token.lexeme}
            case 'VOL_REF':
                advance()
                return {type: 'VolRef', name: token.lexeme}
            case 'GEO_REF':
                advance()
                return {type: 'GeoRef', name: token.lexeme}
            case 'XYZ_REF':
                advance()
                return {type: 'XyzRef', name: token.lexeme}
            case 'VEL_REF':
                advance()
                return {type: 'VelRef', name: token.lexeme}
            case 'RGBA_REF':
                advance()
                return {type: 'RgbaRef', name: token.lexeme}
            case 'MESH_REF':
                advance()
                return {type: 'MeshRef', name: token.lexeme}
            case 'LPAREN': {
                advance()
                const expr = parseAdditive()
                expect('RPAREN', "Expect ')'")
                return expr
            }
            case 'LBRACE': {
                advance()
                const properties = {}
                if (peek().type !== 'RBRACE') {
                    const key = expect('IDENT', 'Expected property name').lexeme
                    expect('COLON', "Expect ':'")
                    properties[key] = parseAdditive()
                    while (peek().type === 'COMMA') {
                        advance()
                        if (peek().type === 'RBRACE') break
                        const nextKey = expect('IDENT', 'Expected property name').lexeme
                        expect('COLON', "Expect ':'")
                        properties[nextKey] = parseAdditive()
                    }
                }
                expect('RBRACE', "Expect '}'")
                return {type: 'Object', properties}
            }
            default:
                throw new SyntaxError(`Unexpected token ${token.type} at line ${token.line} col ${token.col}`)
        }
    }

    function toNumber(node) {
        if (node.type !== 'Number') {
            throw new SyntaxError('Expected number')
        }
        return node.value
    }

    function parseKwarg(obj) {
        const key = expect('IDENT', 'Expected identifier').lexeme
        expect('COLON', "Expect ':'")
        if (!exprStartTokens.has(peek().type)) {
            const t = peek()
            throw new SyntaxError(`Expected expression after '=' at line ${t.line} col ${t.col}`)
        }
        obj[key] = parseArg()
    }

    return parseProgram()
}
