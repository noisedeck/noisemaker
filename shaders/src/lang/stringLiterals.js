/**
 * Decode the raw content of a JSON-escaped DSL string.
 *
 * The lexer deliberately retains escapes for legacy string consumers. Hosts
 * emit MIDI port identity with JSON.stringify(), so the two allowlisted MIDI
 * fields opt into decoding through this helper while invalid legacy escapes
 * remain byte-for-byte compatible.
 */
export function decodeJsonStringLiteralContent(raw) {
    try {
        return JSON.parse(`"${raw}"`)
    } catch {
        return raw
    }
}
