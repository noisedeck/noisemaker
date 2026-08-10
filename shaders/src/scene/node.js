// shaders/src/scene/node.js
import { composeTransform, mat4 } from './math.js'

export class SceneNode {
  constructor({ id, position, rotation, scale } = {}) {
    this.id = id || null
    this.parent = null
    this.children = []

    this._position = position ? [...position] : [0, 0, 0]
    this._rotation = rotation ? [...rotation] : [0, 0, 0]
    this._scale = scale ? [...scale] : [1, 1, 1]

    this._dirty = true
    this._localMatrix = mat4.create()
    this._worldMatrix = mat4.create()
  }

  get position() {
    return this._position
  }

  set position(v) {
    this._position = [...v]
    this._markDirty()
  }

  get rotation() {
    return this._rotation
  }

  set rotation(v) {
    this._rotation = [...v]
    this._markDirty()
  }

  get scale() {
    return this._scale
  }

  set scale(v) {
    this._scale = [...v]
    this._markDirty()
  }

  _markDirty() {
    this._dirty = true
    for (const child of this.children) {
      child._markDirty()
    }
  }

  addChild(node) {
    if (node.parent) {
      node.parent.removeChild(node)
    }
    this.children.push(node)
    node.parent = this
    node._markDirty()
  }

  removeChild(node) {
    const idx = this.children.indexOf(node)
    if (idx !== -1) {
      this.children.splice(idx, 1)
      node.parent = null
    }
  }

  translate(x, y, z) {
    this._position[0] += x
    this._position[1] += y
    this._position[2] += z
    this._markDirty()
  }

  rotateX(degrees) {
    this._rotation[0] += degrees
    this._markDirty()
  }

  rotateY(degrees) {
    this._rotation[1] += degrees
    this._markDirty()
  }

  rotateZ(degrees) {
    this._rotation[2] += degrees
    this._markDirty()
  }

  lookAt(target) {
    const dx = target[0] - this._position[0]
    const dy = target[1] - this._position[1]
    const dz = target[2] - this._position[2]
    const dist = Math.sqrt(dx * dx + dz * dz)
    // Pitch (rotation around X): angle from horizontal
    this._rotation[0] = -Math.atan2(dy, dist) * 180 / Math.PI
    // Yaw (rotation around Y): angle in XZ plane
    this._rotation[1] = Math.atan2(dx, dz) * 180 / Math.PI
    this._rotation[2] = 0
    this._markDirty()
  }

  getWorldMatrix() {
    if (this._dirty) {
      this._localMatrix = composeTransform(this._position, this._rotation, this._scale)

      if (this.parent) {
        const parentWorld = this.parent.getWorldMatrix()
        mat4.multiply(this._worldMatrix, parentWorld, this._localMatrix)
      } else {
        mat4.copy(this._worldMatrix, this._localMatrix)
      }

      this._dirty = false
    }
    return this._worldMatrix
  }
}
