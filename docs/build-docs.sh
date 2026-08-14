#!/bin/bash
# Build Sphinx documentation using the virtual environment

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Check if venv exists
if [ ! -d "$PROJECT_ROOT/venv" ]; then
    echo "Error: Virtual environment not found at $PROJECT_ROOT/venv"
    echo "Please run: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# Use the venv's sphinx-build
SPHINX_BUILD="$PROJECT_ROOT/venv/bin/sphinx-build"

if [ ! -f "$SPHINX_BUILD" ]; then
    echo "Error: sphinx-build not found in venv"
    echo "Please run: source venv/bin/activate && pip install -r docs/sphinx-requirements.txt"
    exit 1
fi

# Generate the Noisemaker.js bundle
echo "Building Noisemaker.js bundle..."
cd "$PROJECT_ROOT"
if ! npm run bundle; then
    echo "Error: Failed to build bundle"
    exit 1
fi

# Update the Noisemaker.js bundle
BUNDLE_SRC="$PROJECT_ROOT/dist/noisemaker.min.js"
BUNDLE_DEST="$SCRIPT_DIR/_static/noisemaker.min.js"

if [ -f "$BUNDLE_SRC" ]; then
    echo "Copying Noisemaker.js bundle to _static/..."
    cp "$BUNDLE_SRC" "$BUNDLE_DEST"
    echo "✓ Bundle updated ($(du -h "$BUNDLE_DEST" | cut -f1))"
else
    echo "Error: Bundle not found at $BUNDLE_SRC after build"
    exit 1
fi

# Build shader bundles (includes core and effects)
echo "Building shader bundles..."
cd "$PROJECT_ROOT"
if ! npm run bundle:shaders; then
    echo "Error: Failed to build shader bundles"
    exit 1
fi

# Update shader bundles in _static
echo "Updating shader bundles in _static..."
if ! "$SCRIPT_DIR/update-shader-bundle.sh"; then
    echo "Error: Failed to update shader bundles"
    exit 1
fi

# Build the documentation.
#
# Must stay -b dirhtml: that is what scaffold's static-site-release
# builds for docs.noisemaker.app. dirhtml serves composer-api.rst as
# /composer-api/ rather than /composer-api.html, which changes how
# every relative asset path in a `.. raw:: html` block resolves. A
# local -b html build would silently hide broken viewer scripts.
cd "$SCRIPT_DIR"
"$SPHINX_BUILD" -b dirhtml . _build/html

echo ""
echo "Documentation built successfully!"
echo "Serve it from the build root — the pages reference /_static/,"
echo "so file:// will not load the viewers:"
echo ""
echo "  python3 -m http.server -d $SCRIPT_DIR/_build/html 8002"
echo ""
echo "Then open: http://localhost:8002/"
