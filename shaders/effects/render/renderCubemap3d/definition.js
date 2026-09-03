import { Effect } from '../../../src/runtime/effect.js'

/**
 * render/renderCubemap3d - Cubemap 3D volume renderer (lit blob)
 *
 * A multi-face clone of render3d: renders a 3D volume (inputTex3d) into seamless
 * cubemap faces using the per-face cube camera (cubeBasis) instead of render3d's
 * orbit camera. Keeps render3d's isosurface/voxel filtering switch, lighting, and
 * gamma — it shows the lit "blob in space," analogous to render3d. (The raw
 * true-color ray sample lives in the sibling renderCubemapSurface.)
 *
 * Usage in DSL:
 *   noise3d().renderCubemap3d().write(o0)
 *   cell3d().renderCubemap3d(threshold: 0.3, filtering: voxel).write(o0)
 */
export default new Effect({
  name: "RenderCubemap3D",
  namespace: "render",
  tags: ["3d"],
  func: "renderCubemap3d",

  description: "Render a 3D volume into cubemap faces (lit isosurface/voxel)",
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
    "cubeBasis": {
        "type": "mat3",
        "default": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        "uniform": "cubeBasis",
        "ui": {
            "control": false
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
      program: "renderCubemap3d",
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
