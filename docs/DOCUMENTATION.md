# Documentation Generation Guide

## Overview

Noisemaker uses Sphinx to generate API documentation with support for:
- **Type hints** - Automatic rendering of Python 3.10+ type annotations
- **Google-style docstrings** - Modern, readable documentation format
- **Intersphinx** - Cross-references to Python, NumPy, and TensorFlow docs
- **Read the Docs** - Automated building and hosting

## Building Documentation Locally

### Setup

1. Install documentation dependencies:
```bash
cd noisemaker
pip install -e ".[dev]"
pip install -r docs/sphinx-requirements.txt
```

2. Build the documentation:
```bash
cd docs
make clean
make dirhtml
```

Use `dirhtml`, not `html`. That is the builder scaffold's
`static-site-release` runs for docs.noisemaker.app, and it is the only
one that reproduces production URLs: `composer-api.rst` is served as
`/composer-api/`, not `/composer-api.html`. Relative asset paths inside
`.. raw:: html` blocks resolve differently between the two, so an
`html` build can look fine while the deployed page 404s its scripts.

3. View the documentation:

The pages reference `/_static/...` root-absolute, so `file://` will not
load the viewers. Serve the build root over HTTP:

```bash
python3 -m http.server -d _build/dirhtml 8002
# then open http://localhost:8002/
```

### Quick Build Script

Use the provided build script:
```bash
./docs/build-docs.sh
```

## Sphinx Configuration

The documentation is configured in `docs/conf.py` with the following extensions:

### Core Extensions
- **sphinx.ext.autodoc** - Automatic API documentation from docstrings
- **sphinx.ext.viewcode** - Links to source code
- **sphinx.ext.napoleon** - Google/NumPy style docstring support
- **sphinx.ext.intersphinx** - Cross-project linking
- **sphinx.ext.autodoc.typehints** - Enhanced type hint rendering

### Type Hint Settings
```python
autodoc_typehints = 'description'  # Show type hints in description
autodoc_typehints_format = 'short'  # Use short form: list[int] not typing.List[int]
```

### Napoleon Settings
```python
napoleon_google_docstring = True   # Support Google-style docstrings
napoleon_use_param = True           # Generate :param: directives
napoleon_use_rtype = True           # Generate :rtype: directives
napoleon_preprocess_types = True    # Process type annotations
```

## Documentation Structure

```
docs/
├── conf.py              # Sphinx configuration
├── index.rst            # Main documentation page
├── api.rst              # API reference (auto-generated from docstrings)
├── composer.rst         # Composer/preset documentation
├── cli.rst              # CLI documentation
├── _static/             # Static assets (CSS, images)
├── _build/              # Generated HTML (gitignored)
└── sphinx-requirements.txt
```

## Writing Documentation

### Module-Level Docstrings

Every module should have a docstring:
```python
"""
Brief module description.

Longer description if needed, explaining what the module does
and how it fits into the larger project.
"""
```

### Function Documentation

Use Google-style docstrings with type hints in the signature:

```python
def my_function(
    param1: str,
    param2: int | None = None,
    param3: list[float] = [],
) -> dict[str, Any]:
    """
    Brief one-line description.

    Longer description explaining what the function does,
    its behavior, and any important notes.

    Args:
        param1: Description of param1
        param2: Optional description of param2. Defaults to None.
        param3: Description of param3 with default value

    Returns:
        Dictionary containing the results with keys...

    Raises:
        ValueError: When param1 is empty
        TypeError: When param2 is not an integer

    Example:
        >>> result = my_function("test", 42)
        >>> print(result['key'])
        'value'

    Note:
        Any important notes about usage or behavior.

    Warning:
        Any warnings about gotchas or edge cases.
    """
```

### Class Documentation

```python
class MyClass:
    """
    Brief class description.

    Longer description of the class purpose and usage.

    Attributes:
        attr1: Description of public attribute
        attr2: Description of another attribute
    """

    def __init__(self, param: str):
        """
        Initialize the class.

        Args:
            param: Description of initialization parameter
        """
        self.attr1 = param
```

## Documentation Publishing

Documentation is automatically built and published in two places:
- **Primary URL**: https://docs.noisemaker.app/
- **Parallel ReadTheDocs URL**: https://noisemaker.readthedocs.io/
- **Primary config**: `.github/workflows/docs-site.yml`
- **ReadTheDocs config**: `.readthedocs.yaml`
- **Trigger**: Every push to main branch

### Configuration

The `.github/workflows/docs-site.yml` file configures the first-party docs site. The `.readthedocs.yaml` file keeps ReadTheDocs publishing active in parallel.

The ReadTheDocs file configures:
- Python 3.13 environment (Dockerfile), Python 3.12 (Read the Docs)
- Automatic installation from `pyproject.toml`
- Sphinx requirements from `docs/sphinx-requirements.txt`
- PDF and ePub export formats

## API Documentation Coverage

Current coverage of modules in `docs/api.rst`:

### Fully Documented (with type hints)
- ✅ `noisemaker.generators` - High-level noise generation
- ✅ `noisemaker.composer` - Preset system
- ✅ `noisemaker.value` - Low-level value noise
- ✅ `noisemaker.util` - Utility functions
- ✅ `noisemaker.rng` - Random number generation
- ✅ `noisemaker.oklab` - Color space conversions
- ✅ `noisemaker.constants` - Enumerations

### Partially Documented
- 🔄 `noisemaker.effects` - Effect functions (legacy docstrings)
- 🔄 `noisemaker.masks` - Mask functions (legacy docstrings)

### Included in API Docs
- 📚 `noisemaker.points` - Point cloud generation
- 📚 `noisemaker.palettes` - Color palettes
- 📚 `noisemaker.simplex` - Simplex noise
- 📚 `noisemaker.glyphs` - Glyph rendering
- 📚 `noisemaker.presets` - Preset management
- 📚 `noisemaker.effects_registry` - Effect registry

## Troubleshooting

### Mock Dependencies

Some dependencies (TensorFlow, PIL, etc.) are mocked in `conf.py` to allow documentation
to build without full installations. If you see import errors, add them to `MOCK_MODULES`.

### Type Hint Rendering

If type hints aren't rendering correctly:
1. Ensure `from __future__ import annotations` is at the top of the module
2. Check that `autodoc_typehints = 'description'` is set in `conf.py`
3. Verify Napoleon is enabled: `'sphinx.ext.napoleon'` in extensions

### Cross-References

Use intersphinx for external references:
- Python: `:class:`str``, `:func:`len``
- NumPy: `:class:`numpy.ndarray``
- TensorFlow: `:class:`tensorflow.Tensor``

## Continuous Improvement

To improve documentation coverage:
1. Add type hints to remaining modules (see MODERNIZATION.md)
2. Convert legacy Sphinx docstrings to Google style
3. Add examples to docstrings
4. Include diagrams and visualizations where helpful
5. Keep the API reference up to date as new modules are added

## References

- [Sphinx Documentation](https://www.sphinx-doc.org/)
- [Napoleon Extension](https://www.sphinx-doc.org/en/master/usage/extensions/napoleon.html)
- [Google Style Guide](https://google.github.io/styleguide/pyguide.html#38-comments-and-docstrings)
- [Read the Docs](https://docs.readthedocs.io/)
- [Type Hints (PEP 484)](https://peps.python.org/pep-0484/)
- [Type Hints (PEP 585)](https://peps.python.org/pep-0585/)
