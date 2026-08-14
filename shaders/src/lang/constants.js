const STARTER_BLOCK_CATEGORIES = Object.freeze(['Synths', 'Generators', 'Surfaces'])
const STARTER_BLOCK_CATEGORY_LOOKUP = new Set(STARTER_BLOCK_CATEGORIES)

const DEFAULT_BLOCK_CATEGORY_TYPE = 'post'
const BLOCK_CATEGORY_TYPES = Object.freeze({
    Synths: 'synth',
    Generators: 'synth',
    Surfaces: 'synth',
    Mixers: 'mixer',
    Post: 'post',
    Geometry: 'post',
    'Color & FX': 'post',
    Modulation: 'post',
    Control: 'post',
    Utilities: 'post',
    Variables: 'post'
})

export function isStarterBlockCategory(category) {
    if (typeof category !== 'string' || !category) { return false }
    return STARTER_BLOCK_CATEGORY_LOOKUP.has(category)
}

export function getBlockCategoryType(category) {
    if (typeof category !== 'string' || !category) { return DEFAULT_BLOCK_CATEGORY_TYPE }
    return BLOCK_CATEGORY_TYPES[category] || DEFAULT_BLOCK_CATEGORY_TYPE
}

export { STARTER_BLOCK_CATEGORIES, BLOCK_CATEGORY_TYPES, DEFAULT_BLOCK_CATEGORY_TYPE }
