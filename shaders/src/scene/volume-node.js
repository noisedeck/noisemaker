// shaders/src/scene/volume-node.js
import { SceneNode } from './node.js'

/**
 * A density volume placed in the scene graph.
 *
 * `surface` names one of the pipeline's global volume atlases (vol0..vol7),
 * `threshold` is the level the renderer marches for, and `mode` picks the
 * algorithm that marches it: 'smooth' for the trilinear isosurface, 'voxel' for
 * the 3D-DDA walk of the atlas grid. Placement, parenting and dirty propagation
 * are the base node's; a volume has no children of its own, and it is
 * deliberately not a MeshNode so getMeshNodes() never hands one to the
 * rasterizer.
 */
export class VolumeNode extends SceneNode {
  constructor({
    surface,
    threshold = 0.5,
    mode = 'smooth',
    material = null,
    position,
    rotation,
    scale,
    id
  } = {}) {
    super({ id: id || `volume_${surface}`, position, rotation, scale })
    this.surface = surface
    this.threshold = threshold
    this.mode = mode
    this.materialId = material
  }
}
