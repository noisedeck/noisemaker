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

    // The components the cached local matrix was actually composed from.
    // `position` and friends hand out the live array, so a host writing
    // `node.position[0] = 2` or `node.position[1] += dt` never reaches the
    // setter and never marks anything dirty: the cache stayed composed from
    // the old values while reading the property back showed the new ones, and
    // the frame did not move. getWorldMatrix() compares these nine numbers.
    this._composed = [0, 0, 0, 0, 0, 0, 0, 0, 0]

    // How a child notices an ancestor moved when no _markDirty ran. Each node
    // bumps its own version whenever it recomposes its world matrix, and
    // records the parent version it last composed against.
    this._worldVersion = 0
    this._parentVersion = -1
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
      // The cached world matrix still folds in this parent's transform, so
      // the detached subtree has to recompute from its own local transform.
      node._markDirty()
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

  /**
   * Whether any transform component differs from what the cached local matrix
   * was composed from. Nine comparisons; a NaN component reads as changed,
   * which recomposes a matrix that was already NaN and costs nothing else.
   */
  _componentsChanged() {
    const c = this._composed
    const p = this._position
    const r = this._rotation
    const s = this._scale
    return c[0] !== p[0] || c[1] !== p[1] || c[2] !== p[2] ||
           c[3] !== r[0] || c[4] !== r[1] || c[5] !== r[2] ||
           c[6] !== s[0] || c[7] !== s[1] || c[8] !== s[2]
  }

  getWorldMatrix() {
    // The parent is resolved FIRST and unconditionally: its own value check is
    // what turns an index assignment on an ancestor into a version bump here.
    // A clean parent returns after nine comparisons, so the walk to the root
    // is cheap; skipping it is what let a stale child matrix survive.
    const parentWorld = this.parent ? this.parent.getWorldMatrix() : null
    const parentVersion = this.parent ? this.parent._worldVersion : 0

    if (this._dirty || parentVersion !== this._parentVersion || this._componentsChanged()) {
      this._localMatrix = composeTransform(this._position, this._rotation, this._scale)
      const c = this._composed
      c[0] = this._position[0]; c[1] = this._position[1]; c[2] = this._position[2]
      c[3] = this._rotation[0]; c[4] = this._rotation[1]; c[5] = this._rotation[2]
      c[6] = this._scale[0]; c[7] = this._scale[1]; c[8] = this._scale[2]

      if (parentWorld) {
        mat4.multiply(this._worldMatrix, parentWorld, this._localMatrix)
      } else {
        mat4.copy(this._worldMatrix, this._localMatrix)
      }

      this._dirty = false
      this._parentVersion = parentVersion
      this._worldVersion++
    }
    return this._worldMatrix
  }
}
