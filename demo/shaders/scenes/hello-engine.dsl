// Hello Scene — camera, lights, a mesh hierarchy and PBR materials,
// composited through noisemaker's normal 2D filter pipeline.
//
// scene() renders into a surface like any other source, so everything
// downstream of .write(o0) is ordinary noisemaker effect chaining.
search filter, synth

scene(
  ambient: 0.15,
  background: [0.05, 0.05, 0.1],

  camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),

  light(type: "directional", dir: [1, -1, 1], color: [1, 0.95, 0.9], intensity: 2),
  light(type: "point", pos: [-3, 4, -2], color: [0.3, 0.5, 1], intensity: 3, falloff: 1),

  group(id: "main",
    mesh("sphere", radius: 1.5, segments: 64, pos: [0, 1, 0])
      .material(solid(color: [0.9, 0.9, 0.95]).pbr(metallic: 0.1, roughness: 0.6))
  ),

  mesh("box", size: [0.8, 0.8, 0.8], pos: [-3, 0, 0])
    .material(solid(color: [0.8, 0.2, 0.1]).pbr(metallic: 0.95, roughness: 0.05)),

  mesh("torus", pos: [3, 1, 0])
    .material(solid(color: [0.1, 0.3, 0.8]).pbr(metallic: 0.8, roughness: 0.2))
).write(o0)

read(o0).bloom(threshold: 0.7).vignette(brightness: 0.2).write(o1)

render(o1)
