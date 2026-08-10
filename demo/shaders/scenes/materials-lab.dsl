// Materials Lab — every scene material and lighting feature in one frame.
//
// - surface(o2): a live DSL program (animated noise) as PBR albedo
// - emit(): emissive material, glowing via downstream bloom
// - environment(o3): a DSL gradient as equirect sky, driving ambient
//   light and reflection fallback
// - metallic floor: an explicit mirrored scene pass via reflector()
// - spot + directional lights, hemisphere unused (env takes over)
// - SSAO contact shadows; built-in osc() automation spins the center group
// - the whole scene composites through 2D filters (bloom, vignette)
search filter, synth

noise(scaleX: 5, scaleY: 5, octaves: 4, colorMode: 1, speed: 0).write(o2)

gradient(color1: [0.5, 0.65, 0.95], color2: [0.14, 0.1, 0.2], colorCount: 2).write(o3)

scene(
  background: [0.015, 0.02, 0.04],
  exposure: 1.25,
  ssaoRadius: 0.6,
  reflections: 0.65,
  reflectionProbe: [0, 2.5, -3.5],
  reflectionProbeSize: 128,

  camera(fov: 52, pos: [0, 3.2, -8.5], target: [0, 0.6, 0]),

  environment(o3, intensity: 0.55),

  light(type: "directional", dir: [0.6, -1, 0.4], color: [1, 0.96, 0.88], intensity: 1.6),
  light(type: "point", pos: [0, 4, -6], color: [0.25, 0.35, 0.6], intensity: 0.25, falloff: 0),
  light(type: "spot", pos: [-3, 6, -2], dir: [0.35, -1, 0.25], angle: 24, penumbra: 0.35,
        color: [1, 0.85, 0.6], intensity: 30),

  mesh("plane", width: 22, height: 22, pos: [0, -0.6, 0])
    .reflector()
    .material(solid(color: [0.62, 0.64, 0.7]).pbr(metallic: 0.9, roughness: 0.2)),

  group(id: "spinner", rot: [0, osc(type: oscKind.saw), 0],
    mesh("sphere", radius: 1.3, segments: 64, pos: [0, 0.7, 0]),
    mesh("box", size: [1.1, 1.1, 1.1], pos: [-3, -0.05, 0])
      .material(solid(color: [0.85, 0.2, 0.12]).pbr(metallic: 0.3, roughness: 0.35)),
    mesh("torus", radius: 1, tube: 0.32, pos: [3, -0.28, 0])
      .material(solid(color: [0.95, 0.75, 0.25]).pbr(metallic: 0.95, roughness: 0.15)),

    mesh("sphere", radius: 0.55, pos: [1.6, 0.05, -2.2])
      .material(solid(color: [0.4, 0.9, 1.0]).emit(strength: 1.5)),

    mesh("sphere", radius: 0.7, pos: [-1.6, 0.1, -2.2])
      .material(solid(color: [0.75, 0.55, 0.3]).pbr(metallic: 0.95, roughness: 0.78))
  ).material(surface(o2, tint: [0.8, 0.95, 1], uvScale: [2.5, 1.5], uvOffset: [0.15, 0])
      .pbr(metallic: 0.05, roughness: 0.65))
).write(o0)

read(o0).bloom(threshold: 0.75).vignette(brightness: 0.15).write(o1)

render(o1)
