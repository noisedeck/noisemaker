# Execution Graphs

This table gives the canonical effect order and RNG call counts for key presets rendered with seed 1 at 8x8 resolution. These values support Python/JS parity checks. See `js/doc/PY_JS_PARITY_SPEC.md` section 5 for details.

To regenerate these values, run the parity test suite with verbose output enabled.

| Preset  | Effect sequence      | RNG calls |
|---------|---------------------|-----------|
| basic   | *(none)*            | 2         |
| worms   | worms -> fxaa       | 264       |
| voronoi | voronoi             | 340       |
