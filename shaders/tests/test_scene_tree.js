// shaders/tests/test_scene_tree.js
import assert from 'assert'
import { SceneNode } from '../src/scene/node.js'
import { CameraNode } from '../src/scene/camera.js'
import { LightNode } from '../src/scene/light.js'
import { MeshNode } from '../src/scene/mesh-node.js'
import { SceneTree } from '../src/scene/tree.js'

function approx(a, b, eps = 1e-4) {
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
}

// SceneNode basics
{
  const node = new SceneNode({ id: 'test' })
  assert.strictEqual(node.id, 'test')
  assert.strictEqual(node.parent, null)
  assert.strictEqual(node.children.length, 0)
  const wm = node.getWorldMatrix()
  approx(wm[0], 1); approx(wm[5], 1); approx(wm[10], 1); approx(wm[15], 1)
}

// Parent-child hierarchy
{
  const parent = new SceneNode({ id: 'parent' })
  const child = new SceneNode({ id: 'child' })
  parent.addChild(child)
  assert.strictEqual(child.parent, parent)
  assert.strictEqual(parent.children.length, 1)
  assert.strictEqual(parent.children[0], child)
}

// Transform propagation
{
  const parent = new SceneNode({ id: 'p' })
  parent.position = [10, 0, 0]
  const child = new SceneNode({ id: 'c' })
  child.position = [0, 5, 0]
  parent.addChild(child)

  const wm = child.getWorldMatrix()
  approx(wm[12], 10)
  approx(wm[13], 5)
  approx(wm[14], 0)
}

// Dirty flag propagation
{
  const parent = new SceneNode({ id: 'p' })
  const child = new SceneNode({ id: 'c' })
  parent.addChild(child)
  child.getWorldMatrix()
  assert.ok(!child._dirty, 'clean after getWorldMatrix')
  parent.position = [1, 0, 0]
  assert.ok(child._dirty, 'child dirty after parent move')
}

// Remove child
{
  const parent = new SceneNode({ id: 'p' })
  const child = new SceneNode({ id: 'c' })
  parent.addChild(child)
  parent.removeChild(child)
  assert.strictEqual(parent.children.length, 0)
  assert.strictEqual(child.parent, null)
}

// translate
{
  const node = new SceneNode({ id: 'n' })
  node.translate(1, 2, 3)
  approx(node.position[0], 1)
  approx(node.position[1], 2)
  approx(node.position[2], 3)
  node.translate(1, 0, 0)
  approx(node.position[0], 2)
}

// CameraNode
{
  const cam = new CameraNode({
    fov: 60, near: 0.1, far: 100,
    position: [0, 2, -5], target: [0, 0, 0]
  })
  const view = cam.getViewMatrix()
  assert.strictEqual(view.length, 16)
  const proj = cam.getProjectionMatrix(16/9)
  assert.strictEqual(proj.length, 16)
}

// LightNode
{
  const light = new LightNode({
    type: 'point', position: [0, 3, 0],
    color: [1, 0.8, 0.6], intensity: 2
  })
  assert.strictEqual(light.lightType, 'point')
  assert.strictEqual(light.intensity, 2)
}

// MeshNode
{
  const mesh = new MeshNode({
    meshType: 'sphere',
    meshParams: { radius: 1 },
    material: 'mat_0',
    planarReflection: true
  })
  assert.strictEqual(mesh.meshType, 'sphere')
  assert.strictEqual(mesh.materialId, 'mat_0')
  assert.strictEqual(mesh.planarReflection, true)
}

// SceneTree.fromIR
{
  const ir = {
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] },
    lights: [{ type: 'directional', direction: [1, -1, 0], color: [1, 1, 1], intensity: 1 }],
    nodes: [
      { id: 'root', type: 'group', parent: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, children: [1] },
      { id: 'obj', type: 'mesh', parent: 0, meshType: 'sphere', meshParams: { radius: 1 }, material: 'mat_0', planarReflection: true }
    ],
    sdfs: [],
    procedurals: [],
    settings: { background: [0, 0, 0], ambient: 0.1 }
  }
  const tree = SceneTree.fromIR(ir)
  assert.ok(tree.camera instanceof CameraNode)
  assert.strictEqual(tree.lights.length, 1)
  // tree.root is a synthetic root node; IR nodes are children of it
  const rootGroup = tree.root.children[0]
  assert.strictEqual(rootGroup.id, 'root')
  assert.strictEqual(rootGroup.children.length, 1)
  const obj = tree.getById('obj')
  assert.ok(obj !== null)
  assert.strictEqual(obj.meshType, 'sphere')
  assert.strictEqual(obj.planarReflection, true)
  assert.strictEqual(tree.getPlanarReflector(), obj)
}

// SceneTree traversal
{
  const ir = {
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] },
    lights: [],
    nodes: [
      { id: 'a', type: 'group', parent: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, children: [1, 2] },
      { id: 'b', type: 'mesh', parent: 0, meshType: 'box', meshParams: {}, material: null },
      { id: 'c', type: 'mesh', parent: 0, meshType: 'sphere', meshParams: {}, material: null }
    ],
    sdfs: [],
    procedurals: [],
    settings: {}
  }
  const tree = SceneTree.fromIR(ir)
  const meshes = tree.getMeshNodes()
  assert.strictEqual(meshes.length, 2)
}

// rotateX/Y/Z
{
  const node = new SceneNode({ id: 'r' })
  node.rotateX(45)
  approx(node.rotation[0], 45)
  node.rotateY(90)
  approx(node.rotation[1], 90)
  node.rotateZ(30)
  approx(node.rotation[2], 30)
  // Incremental
  node.rotateX(10)
  approx(node.rotation[0], 55)
  assert.ok(node._dirty, 'dirty after rotation')
}

// lookAt
{
  const node = new SceneNode({ id: 'l', position: [0, 0, 0] })
  // Looking straight ahead along +Z
  node.lookAt([0, 0, 10])
  approx(node.rotation[0], 0)
  approx(node.rotation[1], 0)
  approx(node.rotation[2], 0)
  // Looking along +X
  node.lookAt([10, 0, 0])
  approx(node.rotation[0], 0)
  approx(node.rotation[1], 90)
  // Looking up at 45 degrees along +Z
  node.lookAt([0, 10, 10])
  approx(node.rotation[0], -45)
  approx(node.rotation[1], 0)
}

// CameraNode with custom id
{
  const cam = new CameraNode({ id: 'mycam', fov: 90 })
  assert.strictEqual(cam.id, 'mycam')
}

console.log('Scene tree tests passed')
