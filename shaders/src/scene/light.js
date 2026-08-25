// shaders/src/scene/light.js
import { SceneNode } from './node.js'

export class LightNode extends SceneNode {
  constructor({ type = 'point', position, direction, color, intensity = 1, falloff, angle, penumbra } = {}) {
    super({ id: `light_${type}`, position })
    this.lightType = type
    this.color = color || [1, 1, 1]
    this.intensity = intensity
    this.direction = direction || [0, -1, 0]
    this.falloff = falloff != null ? falloff : 1
    // Spot cone half-angle in DEGREES. The DSL compiler (buildLight) and the
    // renderer (_buildLightingUniforms, which converts to radians) both use
    // degrees, so this default must match buildLight's default of 45.
    this.angle = angle != null ? angle : 45
    this.penumbra = penumbra != null ? penumbra : 0.1
  }
}
