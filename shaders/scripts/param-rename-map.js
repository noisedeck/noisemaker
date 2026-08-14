/**
 * Comprehensive param rename map for shader parameter standardization.
 *
 * Shape: { 'namespace/effectFunc': { oldParamKey: newParamKey } }
 *
 * Conventions applied:
 *
 *   Rule 1 — Remove effect name from param key when redundant.
 *            e.g. fractalType -> type, splatColor -> color
 *
 *   Rule 2 — Shorten param keys longer than ~15 characters.
 *            e.g. vignetteHighlightProtect -> vigHiProtect,
 *                 attractionStrength -> attraction
 *
 *   Rule 3 — Canonical names for semantic duplicates:
 *            backgroundColor -> bgColor, backgroundOpacity -> bgAlpha,
 *            bgOpacity -> bgAlpha, aberrationAmt -> aberration,
 *            mixAmt -> mix, frequency -> freq, opacity -> alpha
 *
 *   Rule 4 — loopAmp -> speed (only where it controls animation speed:
 *            bitEffects, cellNoise, cellRefract, synth/cell).
 *            NOT in: caustic, moodscape, kaleido, lensDistortion, noise,
 *            synth/noise, quadTap (genuine loop amplitude).
 *
 * Exceptions — these are NEVER renamed:
 *   - palette* params (paletteAmp, paletteFreq, paletteOffset, palettePhase,
 *     paletteMode, repeatPalette, cyclePalette, rotatePalette) EXCEPT within
 *     the palette effect itself where Rule 1 applies.
 *   - input* params (inputWeight, inputIntensity)
 *   - zoom (special pipeline param)
 *   - colorMode, blendMode (shared concepts, not redundant)
 *
 * Collision notes:
 *   - cellScale is NOT renamed in cellNoise, cellRefract, or synth/cell
 *     because those effects already have a separate 'scale' param (noise scale).
 *   - cellSmooth and cellVariation ARE renamed since no collisions exist.
 *
 * Generated from:
 *   - scratchpad/param-analysis.md (Sections 1-4)
 *   - scratchpad/all-params.tsv (1,235 params, collision-checked)
 *   - docs/plans/2026-02-05-shader-param-standardization-design.md
 */

export const renameMap = {

    // ---------------------------------------------------------------
    // classicNoisedeck
    // ---------------------------------------------------------------

    'classicNoisedeck/bitEffects': {
        loopAmp: 'speed',                 // Rule 4: actually controls animation speed
    },

    'classicNoisedeck/cellNoise': {
        // cellScale: SKIPPED — collision with existing 'scale' param
        cellSmooth: 'smooth',             // Rule 1: remove "cell" prefix
        cellVariation: 'variation',       // Rule 1: remove "cell" prefix
        loopAmp: 'speed',                 // Rule 4: actually controls animation speed
    },

    'classicNoisedeck/cellRefract': {
        // cellScale: SKIPPED — collision with existing 'scale' param
        cellSmooth: 'smooth',             // Rule 1: remove "cell" prefix
        cellVariation: 'variation',       // Rule 1: remove "cell" prefix
        refractAmt: 'amount',             // Rule 1: remove "refract" prefix
        refractDir: 'direction',          // Rule 1: remove "refract" prefix
        loopAmp: 'speed',                 // Rule 4: actually controls animation speed
    },

    'classicNoisedeck/coalesce': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'classicNoisedeck/composite': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'classicNoisedeck/depthOfField': {
        depthSource: 'mapSource',         // Rule 1: remove "depth" (align with mixer convention)
    },

    'classicNoisedeck/displaceMixer': {
        displaceSource: 'mapSource',      // Rule 1: remove "displace" (align with mixer convention)
    },

    'classicNoisedeck/fractal': {
        fractalType: 'type',              // Rule 1: remove effect name
        backgroundColor: 'bgColor',      // Rule 3: canonical background color
        backgroundOpacity: 'bgAlpha',    // Rule 3: canonical background alpha
    },

    'classicNoisedeck/glitch': {
        aberrationAmt: 'aberration',      // Rule 3: canonical aberration name
    },

    'classicNoisedeck/kaleido': {
        kaleido: 'sides',                 // Rule 1: param duplicates effect name
    },

    'classicNoisedeck/lensDistortion': {
        aberrationAmt: 'aberration',      // Rule 3: canonical aberration name
        opacity: 'alpha',                 // Rule 3: canonical transparency name
    },

    'classicNoisedeck/mediaInput': {
        backgroundColor: 'bgColor',      // Rule 3: canonical background color
        backgroundOpacity: 'bgAlpha',    // Rule 3: canonical background alpha
    },

    'classicNoisedeck/noise': {
        noiseType: 'type',                // Rule 1: remove effect name
    },

    'classicNoisedeck/noise3d': {
        noiseScale: 'scale',              // Rule 1: remove "noise" prefix
        noiseType: 'type',                // Rule 1: remove "noise" prefix
    },

    'classicNoisedeck/palette': {
        paletteType: 'type',              // Rule 1: within palette effect, prefix is redundant
        cyclePalette: 'cycle',            // Rule 1: within palette effect, prefix is redundant
        rotatePalette: 'rotate',          // Rule 1: within palette effect, prefix is redundant
    },

    'classicNoisedeck/refract': {
        refractDir: 'direction',          // Rule 1: remove "refract" prefix
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'classicNoisedeck/shapes3d': {
        backgroundColor: 'bgColor',      // Rule 3: canonical background color
        backgroundOpacity: 'bgAlpha',    // Rule 3: canonical background alpha
    },

    'classicNoisedeck/splat': {
        splatColor: 'color',              // Rule 1: remove effect name
        splatCutoff: 'cutoff',            // Rule 1: remove effect name
        splatMode: 'mode',                // Rule 1: remove effect name
        splatScale: 'scale',              // Rule 1: remove effect name
        splatSeed: 'seed',                // Rule 1: remove effect name
        splatSpeed: 'speed',              // Rule 1: remove effect name
        useSplats: 'enabled',             // Rule 1: remove effect name
    },

    'classicNoisedeck/text': {
        backgroundColor: 'bgColor',      // Rule 3: canonical background color
        backgroundOpacity: 'bgAlpha',    // Rule 3: canonical background alpha
    },

    // ---------------------------------------------------------------
    // filter
    // ---------------------------------------------------------------

    'filter/celShading': {
        shadingStrength: 'strength',      // Rule 1: remove "shading" prefix
    },

    'filter/chromaticAberration': {
        aberrationAmt: 'aberration',      // Rule 3: canonical aberration name
    },

    'filter/dither': {
        ditherType: 'type',               // Rule 1: remove effect name
    },

    'filter/feedback': {
        aberrationAmt: 'aberration',      // Rule 3: canonical aberration name
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'filter/grade': {
        vignetteHighlightProtect: 'vigHiProtect',  // Rule 2: shorten (24 -> 12 chars)
    },

    'filter/historicPalette': {
        paletteIndex: 'index',            // Rule 1: remove "palette" prefix (in a palette effect)
    },

    'filter/palette': {
        paletteIndex: 'index',            // Rule 1: within palette effect, prefix is redundant
        paletteOffset: 'offset',          // Rule 1: within palette effect, prefix is redundant
        paletteRepeat: 'repeat',          // Rule 1: within palette effect, prefix is redundant
        paletteRotation: 'rotation',      // Rule 1: within palette effect, prefix is redundant
    },

    'filter/prismaticAberration': {
        aberrationAmt: 'aberration',      // Rule 3: canonical aberration name
    },

    'filter/text': {
        bgOpacity: 'bgAlpha',            // Rule 3: canonical background alpha
    },

    // ---------------------------------------------------------------
    // mixer
    // ---------------------------------------------------------------

    'mixer/alphaMask': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'mixer/applyMode': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'mixer/blendMode': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    'mixer/centerMask': {
        mixAmt: 'mix',                    // Rule 3: canonical mix name
    },

    // ---------------------------------------------------------------
    // render
    // ---------------------------------------------------------------

    'render/pointsBillboardRender': {
        rotationVariation: 'rotationVar', // Rule 2: shorten (17 -> 11 chars)
    },

    // ---------------------------------------------------------------
    // synth
    // ---------------------------------------------------------------

    'synth/cell': {
        // cellScale: SKIPPED — collision with existing 'scale' param
        cellSmooth: 'smooth',             // Rule 1: remove "cell" prefix
        cellVariation: 'variation',       // Rule 1: remove "cell" prefix
        loopAmp: 'speed',                 // Rule 4: actually controls animation speed
    },

    'synth/fractal': {
        fractalType: 'type',              // Rule 1: remove effect name
    },

    'synth/media': {
        backgroundColor: 'bgColor',      // Rule 3: canonical background color
        backgroundOpacity: 'bgAlpha',    // Rule 3: canonical background alpha
    },

    'synth/noise': {
        noiseType: 'type',                // Rule 1: remove effect name
    },

    'synth/osc2d': {
        frequency: 'freq',                // Rule 3: canonical frequency name
    },

    'synth/pattern': {
        patternType: 'type',              // Rule 1: remove effect name
    },

    // ---------------------------------------------------------------
    // synth3d
    // ---------------------------------------------------------------

    'synth3d/cell3d': {
        cellVariation: 'variation',       // Rule 1: remove "cell" prefix
    },

    'synth3d/flythrough3d': {
        fractalType: 'type',              // Rule 1: remove effect name fragment
    },

    'synth3d/fractal3d': {
        fractalType: 'type',              // Rule 1: remove effect name
    },

}
