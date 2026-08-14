# Noisemaker

Noisemaker is a friendly, extendable shader art engine for the browser. It renders real-time generative art and visual effects on WebGL2 and WebGPU — 100+ composable effects, a compact declarative DSL for wiring them together, and no required build step or dependencies.

## Noisedeck

[Noisedeck](https://noisedeck.app) is a real-time shader video synth built on Noisemaker — 100+ effects, free-form routing, runs in the browser. No install required. [Try it free.](https://noisedeck.app)

## Documentation

Full documentation, including the complete API reference and preset guide, is available at [docs.noisemaker.app](https://docs.noisemaker.app/).

## Features

- 100+ shader effects — generators, filters, mixers, particles, and simulations — composable into free-form chains
- Polymorphic DSL: compact, declarative programs that compile to a GPU render graph
- Dual rendering backends: WebGL2 and WebGPU
- Runs straight from a CDN bundle and embeds in any page, no frontend framework required
- External media, audio, and MIDI inputs
- Portable effect packages carrying definitions, help docs, and shaders for both backends
- Python and JavaScript pipelines for offline CPU workflows (CLI, Docker, Colab notebook)

## Getting Started

Installation, CLI usage, API walkthroughs, and advanced workflows are covered in the documentation index. Platform-specific quick-start guides for Python, browser modules, and Docker live there as well as in the dedicated READMEs linked below.

## Bring your coding agent

Noisemaker is easy for coding agents to pick up: the docs ship in machine-readable form ([llms.txt](https://noisemaker.app/llms.txt), [llms-full.txt](https://noisemaker.app/llms-full.txt)), and every effect carries a structured definition and a manifest entry. That covers composing programs in the DSL — and it covers writing effects, too: your own GLSL and WGSL in the [Portable Effects](https://github.com/noisefactorllc/portable) format, with [shade-mcp](https://github.com/noisefactorllc/shade-mcp) driving a real browser to compile them, render frames, check every uniform does something, and diff WebGL2 against WebGPU. See [Building with coding agents](https://docs.noisemaker.app/coding-agents/) for the full workflow.

## Contributing

Issues and pull requests are welcome! Review the [Code of Conduct](CODE_OF_CONDUCT.md) and follow the contribution guidelines in the docs before opening changes.

## Ports

Additional platform-specific guides:

- Python development and API details live in the docs linked above
- JavaScript presets port is covered in the [JavaScript README](js/README-JS.md)
- Shader effects port is documented in the [Shaders README](shaders/README-SHADERS.md)
- Container workflows appear in the [Docker README](README-DOCKER.md)

## Credits

Noisemaker's shader effects build on work shared by the creative coding community. See [CREDITS.md](CREDITS.md) for attributions.

## License

Noisemaker is released under the [MIT License](LICENSE). Use of name in derivative products is subject to the [Trademark Policy](TRADEMARK.md).

Copyright © 2017–2026 Noise Factor LLC
