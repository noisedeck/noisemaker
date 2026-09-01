import { Effect } from '../../../src/runtime/effect.js'

export default new Effect({
  name: "Cell",
  namespace: "synth",
  func: "cell",
  tags: ["noise", "geometric"],

  description: "Cellular/Voronoi noise with selectable cell shapes",
  uniformLayout: {
    resolution: { slot: 0, components: 'xy' },
    time: { slot: 0, components: 'z' },
    seed: { slot: 0, components: 'w' },
    metric: { slot: 1, components: 'x' },
    scale: { slot: 1, components: 'y' },
    cellScale: { slot: 1, components: 'z' },
    cellSmooth: { slot: 1, components: 'w' },
    variation: { slot: 2, components: 'x' },
    speed: { slot: 2, components: 'y' },
    tileOffset: { slot: 3, components: 'xy' },
    fullResolution: { slot: 3, components: 'zw' }
  },
  globals: {
    shape: {
      type: "int",
      default: 0,
      uniform: "metric",
      choices: {
        circle: 0,
        diamond: 1,
        hexagon: 2,
        octagon: 3,
        square: 4,
        triangle: 6
      },
      ui: {
        label: "shape",
        control: "dropdown"
      }
    },
    scale: {
      type: "float",
      default: 75,
      uniform: "scale",
      min: 1,
      max: 100,
      ui: {
        label: "noise scale",
        control: "slider"
      }
    },
    cellScale: {
      type: "float",
      default: 87,
      uniform: "cellScale",
      min: 1,
      max: 100,
      ui: {
        label: "cell scale",
        control: "slider"
      }
    },
    cellSmooth: {
      type: "float",
      default: 0,
      uniform: "cellSmooth",
      min: 0,
      max: 100,
      ui: {
        label: "cell smooth",
        control: "slider"
      }
    },
    variation: {
      type: "float",
      default: 50,
      uniform: "variation",
      min: 0,
      max: 100,
      ui: {
        label: "cell variation",
        control: "slider"
      }
    },
    speed: {
      type: "int",
      default: 1,
      uniform: "speed",
      min: 0,
      max: 5,
      zero: 0,
      ui: {
        label: "speed",
        control: "slider"
      }
    },
    seed: {
      type: "int",
      default: 1,
      uniform: "seed",
      min: 1,
      max: 100,
      ui: {
        label: "seed",
        control: "slider"
      }
    }
  },
  paramAliases: { cellVariation: 'variation', loopAmp: 'speed' },
  passes: [
    {
      name: "render",
      program: "cell",
      uniforms: {
        cellSmooth: "cellSmooth",
        speed: "speed"
      },
      outputs: {
        fragColor: "outputTex"
      }
    }
  ]
})
