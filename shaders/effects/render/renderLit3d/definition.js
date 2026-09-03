import { Effect } from '../../../src/runtime/effect.js'

/**
 * render/renderLit3d - Universal 3D volume renderer with advanced lighting
 *
 * This effect extends render3d with comprehensive lighting controls including
 * diffuse, specular, ambient lighting, and configurable light direction.
 * Based on the lighting filter effect but applied to 3D raymarched surfaces.
 *
 * Usage in DSL:
 *   noise3d().renderLit3d().out(o0)
 *   cell3d().renderLit3d(shininess: 128, specularIntensity: 0.8).out(o0)
 */
export default new Effect({
  name: "RenderLit3D",
  namespace: "render",
  tags: ["3d"],
  func: "renderLit3d",

  description: "Universal 3D volume raymarcher with advanced lighting",
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
    "shape": {
        "type": "int",
        "default": 0,
        "uniform": "shape",
        "choices": {
            "cube": 0,
            "sphere": 1
        },
        "ui": {
            "label": "shape bounds",
            "control": "dropdown"
        }
    },
    "threshold": {
        "type": "float",
        "default": 0.5,
        "min": 0,
        "max": 1,
        "randMax": 0.5,
        "uniform": "threshold",
        "ui": {
            "label": "threshold"
        }
    },
    "invert": {
        "type": "boolean",
        "default": false,
        "randChance": 0,
        "uniform": "invert",
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
        "zero": 0,
        "uniform": "orbitSpeed",
        "ui": {
            "label": "orbit speed"
        }
    },
    "cameraPosition": {
        "type": "vec3",
        "default": [0.0, 0.1425, 1.0],
        "min": [-1, -1, -1],
        "max": [1, 1, 1],
        "step": 0.01,
        "randChance": 0,
        "uniform": "cameraPosition",
        "ui": {
            "label": "camera pos",
            "control": "vec3"
        }
    },
    "bgColor": {
        "type": "color",
        "default": [0.0, 0.0, 0.0],
        "uniform": "bgColor",
        "ui": {
            "label": "bg color",
            "control": "color",
            "category": "background"
        }
    },
    "bgAlpha": {
        "type": "float",
        "default": 1.0,
        "min": 0,
        "max": 1,
        "randChance": 0,
        "uniform": "bgAlpha",
        "ui": {
            "label": "bg opacity",
            "category": "background"
        }
    },
    // Lighting parameters
    "lightDirection": {
        "type": "vec3",
        "default": [0.5, 0.5, 1.0],
        "uniform": "lightDirection",
        "ui": {
            "label": "light dir",
            "control": "vector3",
            "category": "lighting"
        }
    },
    "diffuseColor": {
        "type": "color",
        "default": [1.0, 1.0, 1.0],
        "uniform": "diffuseColor",
        "ui": {
            "label": "color",
            "control": "color",
            "category": "diffuse"
        }
    },
    "diffuseIntensity": {
        "type": "float",
        "default": 0.7,
        "min": 0.0,
        "max": 2.0,
        "step": 0.01,
        "uniform": "diffuseIntensity",
        "ui": {
            "label": "intensity",
            "control": "slider",
            "category": "diffuse"
        }
    },
    "specularColor": {
        "type": "color",
        "default": [1.0, 1.0, 1.0],
        "uniform": "specularColor",
        "ui": {
            "label": "color",
            "control": "color",
            "category": "specular"
        }
    },
    "specularIntensity": {
        "type": "float",
        "default": 0.3,
        "min": 0.0,
        "max": 2.0,
        "step": 0.01,
        "uniform": "specularIntensity",
        "ui": {
            "label": "intensity",
            "control": "slider",
            "category": "specular"
        }
    },
    "shininess": {
        "type": "float",
        "default": 32.0,
        "min": 1.0,
        "max": 256.0,
        "step": 1.0,
        "uniform": "shininess",
        "ui": {
            "label": "shininess",
            "control": "slider",
            "category": "specular"
        }
    },
    "rimIntensity": {
        "type": "float",
        "default": 0.15,
        "min": 0.0,
        "max": 1.0,
        "step": 0.01,
        "uniform": "rimIntensity",
        "ui": {
            "label": "intensity",
            "control": "slider",
            "category": "rim"
        }
    },
    "rimPower": {
        "type": "float",
        "default": 3.0,
        "min": 0.5,
        "max": 8.0,
        "step": 0.1,
        "uniform": "rimPower",
        "ui": {
            "label": "power",
            "control": "slider",
            "category": "rim"
        }
    },
    "ambientColor": {
        "type": "color",
        "default": [0.1, 0.1, 0.1],
        "uniform": "ambientColor",
        "ui": {
            "label": "ambient color",
            "control": "color",
            "category": "lighting"
        }
    }
  },
  defaultProgram: "search synth3d, filter3d, render\n\nnoise3d()\n.renderLit3d(specularIntensity: 2, shininess: 256)\n.write(o0)",
  passes: [
    {
      name: "render",
      program: "renderLit3d",
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
