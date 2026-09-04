import palettes from '../palettes.js'

// Generate palette enum from palettes.js definitions
const paletteEnum = {}
Object.keys(palettes).forEach((name, index) => {
    paletteEnum[name] = { type: 'Number', value: index }
})

// Oscillator kind enum for osc() function
const oscKindEnum = {
    sine: { type: 'Number', value: 0 },      // 0 -> 1 -> 0
    tri: { type: 'Number', value: 1 },       // 0 -> 1 -> 0 (linear)
    saw: { type: 'Number', value: 2 },       // 0 -> 1
    sawInv: { type: 'Number', value: 3 },    // 1 -> 0
    square: { type: 'Number', value: 4 },    // on/off
    noise: { type: 'Number', value: 5 },     // periodic noise (alias for noise1d)
    noise1d: { type: 'Number', value: 5 },   // scrolling periodic noise
    noise2d: { type: 'Number', value: 6 }    // two-stage periodic noise
}

// MIDI mode enum for midi() function
const midiModeEnum = {
    noteChange: { type: 'Number', value: 0 },     // value from note regardless of gate
    gateNote: { type: 'Number', value: 1 },       // value from note only while gate on
    gateVelocity: { type: 'Number', value: 2 },   // value from velocity only while gate on
    triggerNote: { type: 'Number', value: 3 },    // note value with time-based falloff
    velocity: { type: 'Number', value: 4 }        // velocity with time-based falloff (default)
}

// Audio band enum for audio() function
const audioBandEnum = {
    low: { type: 'Number', value: 0 },    // Low frequency band (~0-200Hz)
    mid: { type: 'Number', value: 1 },    // Mid frequency band (~200-2000Hz)
    high: { type: 'Number', value: 2 },   // High frequency band (~2000Hz+)
    vol: { type: 'Number', value: 3 },    // Overall volume (average)
    raw: { type: 'Number', value: 4 }     // Bipolar time-domain/DC signal (-1 to 1)
}

export const stdEnums = {
    channel: {
        r: { type: 'Number', value: 0 },
        g: { type: 'Number', value: 1 },
        b: { type: 'Number', value: 2 },
        a: { type: 'Number', value: 3 }
    },
    color: {
        mono: { type: 'Number', value: 0 },
        rgb: { type: 'Number', value: 1 },
        hsv: { type: 'Number', value: 2 }
    },
    oscType: {
        sine: { type: 'Number', value: 0 },
        linear: { type: 'Number', value: 1 },
        sawtooth: { type: 'Number', value: 2 },
        sawtoothInv: { type: 'Number', value: 3 },
        square: { type: 'Number', value: 4 },
        noise1d: { type: 'Number', value: 5 },
        noise2d: { type: 'Number', value: 6 }
    },
    oscKind: oscKindEnum,
    midiMode: midiModeEnum,
    audioBand: audioBandEnum,
    palette: paletteEnum
}
