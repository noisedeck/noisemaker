Noisemaker API
==============

Images are float32 tensors (0..1 range), with shape (height, width, channels). Most functions assume noise that tiles without visible seams.

This pre-1.0 API may receive changes that break backward compatibility.

noisemaker.generators
---------------------

High-level noise generation functions.

.. automodule:: noisemaker.generators
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.effects
------------------

Image effect and post-processing functions.

.. automodule:: noisemaker.effects
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.value
-----------------

Procedural helpers for constructing and manipulating value-noise tensors.

.. automodule:: noisemaker.value
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.composer
-------------------

Preset-based noise composition system.

.. automodule:: noisemaker.composer
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.constants
--------------------

Enumeration constants for noise generation.

.. automodule:: noisemaker.constants
    :members:
    :undoc-members:
    :show-inheritance:

.. py:module:: noisemaker.dsl

noisemaker.dsl
--------------

DSL parser and evaluator for Composer presets.

.. autofunction:: noisemaker.dsl.parse_preset_dsl(source, context=...)

.. autofunction:: noisemaker.dsl.evaluate(ast, ctx=...)

.. autofunction:: noisemaker.dsl.tokenize

.. autofunction:: noisemaker.dsl.parse

.. data:: noisemaker.dsl.defaultContext
    :module: noisemaker.dsl

    Default evaluation context containing enums, operations, surfaces, and enum methods.

noisemaker.effects_registry
---------------------------

Registry and decorators for Noisemaker composer effects.

.. automodule:: noisemaker.effects_registry
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.glyphs
-----------------

Font and glyph rendering utilities.

.. automodule:: noisemaker.glyphs
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.masks
----------------

Mask generation and application functions.

The ``Masks`` dictionary contains pre-defined mask patterns for all ValueMask enum members.
See :class:`noisemaker.constants.ValueMask` for available mask types.

.. automodule:: noisemaker.masks
    :members:
    :undoc-members:
    :show-inheritance:
    :exclude-members: Masks

noisemaker.oklab
----------------

Oklab color space conversion utilities.

.. automodule:: noisemaker.oklab
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.palettes
-------------------

Color palette definitions and utilities.

.. automodule:: noisemaker.palettes
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.points
-----------------

Point cloud generation utilities used for Voronoi and DLA effects.

.. automodule:: noisemaker.points
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.presets
------------------

Preset loading and management.

.. automodule:: noisemaker.presets
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.rng
--------------

Deterministic RNG utilities that underpin preset and generator reproducibility.

.. automodule:: noisemaker.rng
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.simplex
------------------

Simplex noise implementation.

.. automodule:: noisemaker.simplex
    :members:
    :undoc-members:
    :show-inheritance:

noisemaker.util
---------------

General-purpose helpers used across the Noisemaker codebase.

.. automodule:: noisemaker.util
    :members:
    :undoc-members:
    :show-inheritance:
