// shaders/src/scene/camera.js
import { SceneNode } from './node.js'
import { lookAtMatrix, perspectiveMatrix } from './math.js'

/**
 * A perspective camera.
 *
 * LIMITATION: the view matrix is built from this camera's own `position` and
 * `target` in world space — `getWorldMatrix()` is deliberately not consulted,
 * so scene-graph parenting does NOT move the camera. CameraNode extends
 * SceneNode (and so inherits addChild/parent) only for uniform tree handling;
 * parenting a camera under a moving group has no visual effect. The DSL never
 * parents cameras. Animate `position`/`target` instead, and see the warning
 * below for the case where a parent transform would silently have been lost.
 */
export class CameraNode extends SceneNode {
  constructor({ id, fov = 60, near = 0.1, far = 1000, position, target, up } = {}) {
    super({ id: id || 'camera', position })
    this.fov = fov
    this.near = near
    this.far = far
    this.target = target || [0, 0, 0]
    this.up = up || [0, 1, 0]
    this._warnedParenting = false
  }

  getViewMatrix() {
    // Only complain when a parent would actually have moved us: an unparented
    // camera, or one under an identity transform, loses nothing. Warn once —
    // this sits on the per-frame path.
    if (!this._warnedParenting && this.parent) {
      const parentWorld = this.parent.getWorldMatrix()
      let identity = true
      for (let i = 0; i < 16; i++) {
        const expected = (i % 5 === 0) ? 1 : 0
        if (parentWorld[i] !== expected) { identity = false; break }
      }
      if (!identity) {
        this._warnedParenting = true
        console.warn(
          `CameraNode '${this.id}' has a transformed parent, but cameras ignore ` +
          'scene-graph parenting: the view matrix is built from position/target ' +
          'directly. Animate the camera itself instead.'
        )
      }
    }
    return lookAtMatrix(this._position, this.target, this.up)
  }

  getProjectionMatrix(aspect) {
    return perspectiveMatrix(this.fov, aspect, this.near, this.far)
  }
}
