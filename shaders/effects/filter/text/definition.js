import { Effect } from '../../../src/runtime/effect.js'

/**
 * Text - Text overlay filter
 *
 * Filter effect that overlays text rendered on the CPU side onto an input image.
 * Supports multiple instances per graph, each with independent text content,
 * font, size, position, rotation, and background settings.
 */
export default class Text extends Effect {
    id = "text"
    name = "Text"
    namespace = "filter"
    func = "text"
    description = "Overlay text onto the image"
    tags = ["text"]

    // This tells the UI to create a hidden canvas and bind it to 'textTex'
    externalTexture = "textTex"

    globals = {
        text: {
            type: "string",
            default: "Hello World",
            ui: {
                label: "text",
                multiline: true,
                category: "general"
            }
        },
        font: {
            type: "string",
            default: "Nunito",
            choices: {
                nunito: "Nunito",
                sansSerif: "sans-serif",
                serif: "serif",
                monospace: "monospace",
                cursive: "cursive",
                fantasy: "fantasy"
            },
            ui: {
                label: "font",
                control: "dropdown",
                category: "general"
            }
        },
        size: {
            type: "float",
            default: 0.1,
            min: 0.01,
            max: 1.0,
            step: 0.01,
            ui: {
                label: "size",
                control: "slider",
                category: "transform"
            }
        },
        posX: {
            type: "float",
            default: 0.5,
            min: 0.0,
            max: 1.0,
            step: 0.01,
            ui: {
                label: "pos x",
                control: "slider",
                category: "transform"
            }
        },
        posY: {
            type: "float",
            default: 0.5,
            min: 0.0,
            max: 1.0,
            step: 0.01,
            ui: {
                label: "pos y",
                control: "slider",
                category: "transform"
            }
        },
        rotation: {
            type: "float",
            default: 0.0,
            min: -180.0,
            max: 180.0,
            step: 1.0,
            ui: {
                label: "rotation",
                control: "slider",
                category: "transform"
            }
        },
        color: {
            type: "color",
            default: "#ffffff",
            ui: {
                label: "color",
                control: "color",
                category: "general"
            }
        },
        matteColor: {
            type: "color",
            default: "#000000",
            uniform: "matteColor",
            ui: {
                label: "matte color",
                control: "color",
                category: "background"
            }
        },
        matteOpacity: {
            type: "float",
            default: 0.0,
            min: 0.0,
            max: 1.0,
            step: 0.01,
            uniform: "matteOpacity",
            ui: {
                label: "matte opacity",
                control: "slider",
                category: "background"
            }
        },
        justify: {
            type: "string",
            default: "center",
            choices: {
                left: "left",
                center: "center",
                right: "right"
            },
            ui: {
                label: "justify",
                control: "dropdown",
                category: "general"
            }
        },
        style: {
            type: "string",
            default: "",
            // The named cut within the family — "Bold", "Medium Italic", or a
            // per-typeface label like "Argon Medium Italic" for a family that
            // bundles several. Hosts rasterize text on the CPU and pick the
            // face themselves, so this carries no uniform; it exists so the
            // choice survives the DSL. Without it the unparser drops the value
            // and every recompile silently reverts the text to the family's
            // first cut.
            //
            // Which labels are valid depends on the font, so there is no static
            // choices map and no generic control; hosts render their own picker.
            ui: {
                label: "style",
                control: false,
                hidden: true,
                category: "general"
            }
        }
    }
    defaultProgram = "search filter, synth\n\nperlin(scale: 100)\n  .text()\n  .write(o0)"

    paramAliases = { bgOpacity: 'matteOpacity', bgAlpha: 'matteOpacity', bgColor: 'matteColor' }

    passes = [
        {
            name: "overlay",
            program: "text",
            inputs: {
                inputTex: "inputTex",
                textTex: "textTex"
            },
            uniforms: {
                matteColor: "matteColor",
                matteOpacity: "matteOpacity"
            },
            outputs: {
                fragColor: "outputTex"
            }
        }
    ]
}
