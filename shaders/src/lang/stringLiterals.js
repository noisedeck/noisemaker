/**
 * Decode the raw content of a JSON-escaped DSL string.
 *
 * The lexer deliberately retains escapes for legacy string consumers. Hosts
 * emit device identity with JSON.stringify(), so explicitly allowlisted input
 * identity fields opt into decoding through this helper while invalid legacy
 * escapes remain byte-for-byte compatible.
 */
export function decodeJsonStringLiteralContent(raw) {
    try {
        return JSON.parse(`"${raw}"`)
    } catch {
        // A raw double quote means the source used single quotes. Decode the
        // small escape set the lexer accepts there, preserving unknown escapes
        // so legacy hand-authored identifiers do not silently change.
        let decoded = ''
        for (let i = 0; i < raw.length; i++) {
            if (raw[i] !== '\\' || i + 1 >= raw.length) {
                decoded += raw[i]
                continue
            }
            const next = raw[++i]
            const escapes = {
                "'": "'",
                '"': '"',
                '\\': '\\',
                n: '\n',
                r: '\r',
                t: '\t',
                b: '\b',
                f: '\f',
                v: '\v',
                0: '\0'
            }
            if (Object.prototype.hasOwnProperty.call(escapes, next)) {
                decoded += escapes[next]
            } else {
                decoded += `\\${next}`
            }
        }
        return decoded
    }
}
