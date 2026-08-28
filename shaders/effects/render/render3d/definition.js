import { Effect } from '../../../src/runtime/effect.js'

/**
 * render/render3d - Universal 3D volume renderer
 *
 * This built-in effect extracts the common raymarching/rendering logic from all 3D effects
 * (noise3d, cell3d, shape3d, fractal3d, reactionDiffusion3d, cellularAutomata3d, flow3d) into a reusable pipeline node.
 *
 * It takes a 3D volume (inputTex3d) and renders it to 2D (outputTex) with optional geometry
 * buffer output (geoBuffer) for downstream post-processing.
 *
 * Two rendering modes:
 * - isosurface (filtering=0): Smooth raymarching with trilinear interpolation and bisection
 * - voxel (filtering=1): DDA voxel traversal with flat face shading
 *
 * Usage in DSL:
 *   noise3d().render3d().out(o0)
 *   cell3d().render3d(threshold: 0.3, filtering: 1).out(o0)
 *
 * This effect is a DIRECT PORT of the common rendering logic - no new functionality added.
 * The goal is unification, not enhancement.
 */
export default new Effect({
  name: "Render3D",
  namespace: "render",
  tags: ["3d"],
  func: "render3d",

  description: "Universal 3D volume raymarcher",
  textures: {
    screenGeoBuffer: {
      width: "resolution",
      height: "resolution",
      format: "rgba16f"
    }
  },
  globals: {
    "volumeSize": {
        "type": "int",
        "default": 64,
        "uniform": "volumeSize",
        "choices": {
            "v16": 16,
            "v32": 32,
            "v64": 64,
            "v128": 128
        },
        "ui": {
            "control": false  // Always inherited from upstream volume effect
        }
    },
    "filtering": {
        "type": "int",
        "default": 0,
        // Compile-time define. The shader picks between two completely
        // different raymarching paths (isosurface vs voxel). Baking this
        // lets the optimizer eliminate the unused path entirely — that's
        // the dominant background-compile cost in this 14kB shader.
        "define": "FILTERING",
        "choices": {
            "isosurface": 0,
            "voxel": 1
        },
        "ui": {
            "label": "filtering",
            "control": "dropdown"
        }
    },
    "threshold": {
        "type": "float",
        "default": 0.5,
        "min": 0,
        "max": 1,
        "randMax": 0.3,
        "uniform": "threshold",
        "ui": {
            "label": "threshold"
        }
    },
    "invert": {
        "type": "boolean",
        "default": false,
        "randChance": 0,
        // Compile-time define — eliminates a per-sample branch in
        // getField/isVoxelSolid that runs on every raymarch step.
        "define": "INVERT",
        "ui": {
            "label": "invert thresh"
        }
    },
    "orbitSpeed": {
        "type": "int",
        "default": 1,
        "min": -5,
        "max": 5,
        "randMin": -1,
        "randMax": 1,
        "uniform": "orbitSpeed",
        "ui": {
            "label": "orbit speed"
        }
    },
    "bgColor": {
        "type": "color",
        "default": [0.02, 0.02, 0.02],
        "uniform": "bgColor",
        "ui": {
            "label": "bg color",
            "control": "color"
        }
    },
    "bgAlpha": {
        "type": "float",
        "default": 1.0,
        "min": 0,
        "max": 1,
        "uniform": "bgAlpha",
        "ui": {
            "label": "bg opacity"
        }
    }
  },
  passes: [
    {
      name: "render",
      program: "render3d",
      drawBuffers: 2,
      inputs: {
        volumeCache: "inputTex3d"
      },
      outputs: {
        color: "outputTex",
        geoOut: "screenGeoBuffer"
      }
    }
  ],
  outputGeo: "screenGeoBuffer",
  outputTex3d: "inputTex3d"
})
