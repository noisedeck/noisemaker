import { Effect } from '../../../src/runtime/effect.js'

/**
 * render/renderCubemapSurface - Cubemap surface sampler (raw true color)
 *
 * Renders a 3D volume (inputTex3d) into seamless cubemap faces by sampling the
 * field along the per-face cube camera rays (cubeBasis, 90-degree frustum from
 * the volume center). Front-to-back emission/absorption with NO lighting and NO
 * gamma — the raw, true color of the field shows through exactly as sampled.
 * (The lit isosurface/voxel "blob in space" view lives in renderCubemap3d.)
 *
 * Usage in DSL:
 *   noise3d().renderCubemapSurface().write(o0)
 */
export default new Effect({
  name: "RenderCubemapSurface",
  namespace: "render",
  tags: ["3d"],
  func: "renderCubemapSurface",

  description: "Sample a 3D volume into cubemap faces (raw true color, no lighting)",
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
            "control": false
        }
    },
    "density": {
        "type": "float",
        "default": 4.0,
        "min": 0,
        "max": 20,
        "uniform": "density",
        "ui": {
            "label": "density"
        }
    },
    "absorption": {
        "type": "float",
        "default": 1.0,
        "min": 0,
        "max": 4,
        "uniform": "absorption",
        "ui": {
            "label": "absorption"
        }
    },
    "emission": {
        "type": "float",
        "default": 1.0,
        "min": 0,
        "max": 4,
        "uniform": "emission",
        "ui": {
            "label": "emission"
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
      program: "renderCubemapSurface",
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
