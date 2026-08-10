export class Geometry {
  constructor({ positions, normals, uvs, indices }) {
    this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions)
    this.normals = normals instanceof Float32Array ? normals : new Float32Array(normals)
    this.uvs = uvs instanceof Float32Array ? uvs : new Float32Array(uvs)
    this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices)
  }

  get vertexCount() {
    return this.positions.length / 3
  }

  get triangleCount() {
    return this.indices.length / 3
  }
}
