// shaders/src/scene/tree.js
import { SceneNode } from './node.js'
import { CameraNode } from './camera.js'
import { LightNode } from './light.js'
import { MeshNode } from './mesh-node.js'

export class SceneTree {
  constructor() {
    this.root = new SceneNode({ id: '__root__' })
    this.camera = null
    this.lights = []
    this.settings = {}
    this.materials = {}
  }

  static fromIR(ir) {
    const tree = new SceneTree()

    if (ir.camera) {
      tree.camera = new CameraNode(ir.camera)
    }

    if (ir.lights) {
      tree.lights = ir.lights.map(l => new LightNode(l))
    }

    // Settings
    tree.settings = ir.settings || {}
    tree.materials = ir.materials || {}
    tree.environment = ir.environment || null

    // Build scene nodes from flat IR node array
    if (ir.nodes && ir.nodes.length > 0) {
      // First pass: create all nodes
      const nodes = ir.nodes.map(desc => {
        const transform = desc.transform || {}
        const opts = {
          id: desc.id,
          position: transform.position,
          rotation: transform.rotation,
          scale: transform.scale
        }

        if (desc.type === 'mesh') {
          return new MeshNode({
            ...opts,
            meshType: desc.meshType,
            meshParams: desc.meshParams,
            material: desc.material,
            planarReflection: desc.planarReflection
          })
        } else {
          // 'group' or other types
          return new SceneNode(opts)
        }
      })

      // Second pass: wire up parent-child using children arrays
      ir.nodes.forEach((desc, i) => {
        if (desc.children) {
          for (const childIdx of desc.children) {
            nodes[i].addChild(nodes[childIdx])
          }
        }
      })

      // Third pass: attach root-level nodes (those with no parent in IR) to synthetic root
      ir.nodes.forEach((desc, i) => {
        if (desc.parent == null) {
          tree.root.addChild(nodes[i])
        }
      })
    }

    return tree
  }

  getById(id) {
    return this._dfs(this.root, node => node.id === id)
  }

  getMeshNodes() {
    const result = []
    this._traverse(this.root, node => {
      if (node instanceof MeshNode) {
        result.push(node)
      }
    })
    return result
  }

  getPlanarReflector() {
    return this._dfs(
      this.root,
      node => node instanceof MeshNode && node.planarReflection
    )
  }

  updateWorldMatrices() {
    this._traverse(this.root, node => {
      node.getWorldMatrix()
    })
  }

  _dfs(node, predicate) {
    if (predicate(node)) return node
    for (const child of node.children) {
      const found = this._dfs(child, predicate)
      if (found) return found
    }
    return null
  }

  _traverse(node, callback) {
    callback(node)
    for (const child of node.children) {
      this._traverse(child, callback)
    }
  }
}
