// shaders/src/scene/camera.js
import { SceneNode } from './node.js'
import { lookAtMatrix, perspectiveMatrix } from './math.js'

export class CameraNode extends SceneNode {
  constructor({ id, fov = 60, near = 0.1, far = 1000, position, target, up } = {}) {
    super({ id: id || 'camera', position })
    this.fov = fov
    this.near = near
    this.far = far
    this.target = target || [0, 0, 0]
    this.up = up || [0, 1, 0]
  }

  getViewMatrix() {
    return lookAtMatrix(this._position, this.target, this.up)
  }

  getProjectionMatrix(aspect) {
    return perspectiveMatrix(this.fov, aspect, this.near, this.far)
  }
}
