#!/bin/bash
#
# Update the shader bundles in the documentation static directory.
# This script should be run whenever the shader bundles are updated.
#

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATIC_DIR="$REPO_ROOT/docs/_static"

echo "Updating Noisemaker Shader bundles in docs..."

# Copy core shader bundle
CORE_SRC="$REPO_ROOT/dist/shaders/noisemaker-shaders-core.min.js"
CORE_DEST="$STATIC_DIR/noisemaker-shaders-core.min.js"

if [ ! -f "$CORE_SRC" ]; then
    echo "Error: Core bundle not found at $CORE_SRC"
    echo "Run 'npm run bundle:shaders' first to generate the bundles."
    exit 1
fi

cp "$CORE_SRC" "$CORE_DEST"
echo "✓ Copied core bundle"

# Copy effect bundles
EFFECTS_SRC="$REPO_ROOT/dist/effects"
EFFECTS_DEST="$STATIC_DIR/effects"
MANIFEST_SRC="$REPO_ROOT/shaders/effects/manifest.json"

if [ ! -d "$EFFECTS_SRC" ]; then
    echo "Error: Effects directory not found at $EFFECTS_SRC"
    echo "Run 'npm run bundle:effects' first to generate the bundles."
    exit 1
fi

# Remove old effects directory if it exists
if [ -d "$EFFECTS_DEST" ]; then
    rm -rf "$EFFECTS_DEST"
fi

# Copy effects directory
cp -r "$EFFECTS_SRC" "$EFFECTS_DEST"
echo "✓ Copied effect bundles"

# Copy manifest.json from source (not bundled)
if [ -f "$MANIFEST_SRC" ]; then
    cp "$MANIFEST_SRC" "$EFFECTS_DEST/manifest.json"
    echo "✓ Copied manifest.json"
else
    echo "Warning: Manifest not found at $MANIFEST_SRC"
fi

# Show sizes
CORE_SIZE=$(du -h "$CORE_DEST" | cut -f1)
EFFECTS_SIZE=$(du -sh "$EFFECTS_DEST" | cut -f1)
echo ""
echo "Bundle sizes:"
echo "  Core:    $CORE_SIZE"
echo "  Effects: $EFFECTS_SIZE"

echo ""
echo "Shader bundles updated successfully!"
echo "You can now rebuild the documentation with 'cd docs && make dirhtml'"
