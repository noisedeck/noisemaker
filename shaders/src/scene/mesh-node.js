// shaders/src/scene/mesh-node.js
import { SceneNode } from './node.js'

export class MeshNode extends SceneNode {
  constructor({
    meshType,
    meshParams = {},
    material = null,
    planarReflection = false,
    position,
    rotation,
    scale,
    id
  } = {}) {
    super({ id: id || `mesh_${meshType}`, position, rotation, scale })
    this.meshType = meshType
    this.meshParams = meshParams
    this.materialId = material
    this.planarReflection = planarReflection === true
  }
}
