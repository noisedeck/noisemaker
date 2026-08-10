export function normalizeMemberPath(value) {
    if (!value) { return null }
    if (Array.isArray(value)) {
        const parts = value.filter(seg => typeof seg === 'string' && seg.length)
        return parts.length ? parts : null
    }
    if (typeof value === 'string') {
        const parts = value
            .split('.')
            .map(seg => seg.trim())
            .filter(Boolean)
        return parts.length ? parts : null
    }
    if (typeof value === 'number') {
        return [String(value)]
    }
    return null
}

export function pathStartsWith(path, prefix) {
    if (!Array.isArray(prefix) || !prefix.length) { return true }
    if (!Array.isArray(path) || path.length < prefix.length) { return false }
    for (let i = 0; i < prefix.length; i++) {
        if (path[i] !== prefix[i]) { return false }
    }
    return true
}

export function applyEnumPrefix(path, prefix) {
    if (!Array.isArray(path) || !path.length) { return path }
    if (!Array.isArray(prefix) || !prefix.length) { return path.slice ? path.slice() : path }
    if (pathStartsWith(path, prefix)) { return path.slice() }
    for (let i = 1; i < prefix.length; i++) {
        const suffix = prefix.slice(i)
        if (pathStartsWith(path, suffix)) {
            return prefix.slice(0, i).concat(path)
        }
    }
    return prefix.concat(path)
}

export default {
    normalizeMemberPath,
    pathStartsWith,
    applyEnumPrefix,
}
