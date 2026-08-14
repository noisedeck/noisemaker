#!/bin/bash
#
# Update the bundled Noisemaker.js in the documentation static directory.
# This script should be run whenever the JS bundle is updated.
#

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_SRC="$REPO_ROOT/dist/noisemaker.min.js"
BUNDLE_DEST="$REPO_ROOT/docs/_static/noisemaker.min.js"

echo "Updating Noisemaker.js bundle in docs..."

# Check if bundle exists
if [ ! -f "$BUNDLE_SRC" ]; then
    echo "Error: Bundle not found at $BUNDLE_SRC"
    echo "Run 'npm run bundle' first to generate the bundle."
    exit 1
fi

# Copy bundle
cp "$BUNDLE_SRC" "$BUNDLE_DEST"

echo "✓ Copied $BUNDLE_SRC"
echo "  to $BUNDLE_DEST"

# Show file size
BUNDLE_SIZE=$(du -h "$BUNDLE_DEST" | cut -f1)
echo "✓ Bundle size: $BUNDLE_SIZE"

echo ""
echo "Bundle updated successfully!"
echo "You can now rebuild the documentation with 'cd docs && make dirhtml'"
