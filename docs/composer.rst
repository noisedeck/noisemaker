Noisemaker Composer
===================

Noisemaker Composer is a high-level interface for creating generative art with procedural noise.

Use the **Composer DSL** to define procedural art presets. This domain-specific language provides declarative syntax for composing noise generators and image effects. It supports randomization, inheritance, and reusable configurations.

.. note::
   **JavaScript Compatibility**: Python and JavaScript share the Composer DSL.
   See :doc:`javascript` for using presets in the browser.

.. note::
   **Two DSLs**: Noisemaker has two distinct domain-specific languages:

   * **Composer DSL** (this document) — A declarative DSL for CPU-based compositions using Python/JavaScript effects. Presets describe *what* to generate via layered configurations.
   * **Polymorphic DSL** — An imperative DSL for GPU-based shader compositions. See :doc:`shaders/language` for details.

Overview
--------

The Composer DSL allows you to define presets as JSON-like objects with specialized syntax extensions. Each preset can:

* Layer (inherit from) other presets
* Define reusable settings with random values
* Configure noise generation parameters
* Apply effects per-octave, post-processing, and final passes
* Reference other presets inline

The canonical preset library is :file:`share/dsl/presets.dsl`. The :mod:`noisemaker.dsl` module parses it. Both the reference Python implementation and the JavaScript port use that file. Any change to the DSL immediately applies to both environments.

Custom Presets
~~~~~~~~~~~~~~

You can create your own presets in a separate DSL file and use them with the CLI:

.. code-block:: bash

    # Use a custom presets file
    noisemaker generate my-preset --presets ~/my-presets.dsl -o custom.png

Custom preset files follow the same DSL syntax as the built-in :file:`presets.dsl`. You can reference the built-in file as a template. Custom presets can inherit from each other. To inherit from a built-in preset, include that preset in the same file.

For programmatic usage in Python:

.. code-block:: python

    from noisemaker.presets import set_presets_path, Preset

    # Set custom presets file
    set_presets_path('/path/to/my-presets.dsl')

    # Now use presets from the custom file
    preset = Preset('my-custom-preset')
    preset.render(seed=42, shape=[1024, 1024, 3], filename='output.png')

Philosophy
~~~~~~~~~~

"Composer" presets expose Noisemaker's lower-level `generator <api.html#module-noisemaker.generators>`_ and `effect <api.html#module-noisemaker.effects>`_ APIs. The DSL keeps the data model compact while remaining expressive enough to describe the same building blocks the original Python dictionaries exposed. 

At a high level, each preset answers five key questions:

1. Which presets does this preset inherit from? (``layers``)
2. What are the meaningful variables? (``settings``)
3. Which parameters control noise generation? (``generator``)
4. Which effects should each octave receive? (``octaves``)
5. Which effects should follow layer flattening? (``post`` and ``final``)

Grammar
-------

The DSL follows a strict grammar for parsing and validation. The parser converts programs into an abstract syntax tree (AST). The evaluator checks programs against a whitelist of operations and surfaces. It never invokes ``eval`` or ``Function``.

.. code-block:: text

    Program        ::= Chain ('.' 'out' '(' OutputRef? ')' )?
    Chain          ::= Expr ('.' Call)*
    Expr           ::= Ident '(' ArgList? ')'
    Call           ::= Ident '(' ArgList? ')'
    ArgList        ::= Arg (',' Arg)* ','?
    Arg            ::= NumberExpr | String | Boolean | Color
                     | Ident | Enum | OutputRef | SourceRef | Null
                     | List | Dict
    NumberExpr     ::= Primary
                     | NumberExpr ( '+' | '-' | '*' | '/' ) NumberExpr
                     | NumberExpr '?' NumberExpr ':' NumberExpr
    Primary        ::= Number | Boolean | Null | 'Math.PI'
                     | Ident | Enum | Call | MemberExpr
                     | '(' NumberExpr ')'
    Call           ::= (Ident | MemberExpr) '(' ArgList? ')'
    MemberExpr     ::= Ident '.' Ident
    List           ::= '[' ArgList? ']'
    Dict           ::= '{' (DictEntry (',' DictEntry)* ','?)? '}'
    DictEntry      ::= (String | Ident) ':' Arg
    Enum           ::= Ident '.' Ident
    OutputRef      ::= 'o' Digit
    Ident          ::= Letter ( Letter | Digit | '_' )*
    Number         ::= Digit+ ('.' Digit+)?
    String         ::= '"' [^"\n]* '"'
    Digit          ::= '0'…'9'
    Letter         ::= 'A'…'Z' | 'a'…'z'
    Boolean        ::= 'true' | 'false'
    Null           ::= 'null'
    Color          ::= '#' HexDigit HexDigit HexDigit
                     (HexDigit HexDigit HexDigit)?
    HexDigit       ::= Digit | 'A'…'F' | 'a'…'f'

Grammar Notes
~~~~~~~~~~~~~

* Floats may omit the leading zero (e.g., ``.5``).
* Lists, dictionaries, and argument lists allow trailing commas.
* ``Enum`` resolves to JavaScript enum objects exported from ``constants.js``.
* The parser skips whitespace and comments between tokens.
* Single-line comments use ``//`` and run until the newline.
* Block comments use ``/* … */`` and must be terminated before end of file.

Naming Conventions
~~~~~~~~~~~~~~~~~~

* Preset names use **kebab-case** (e.g., ``"acid-wash"``).
* Preset setting keys use **snake_case** (e.g., ``bloom_alpha``).
* Function wrappers and argument keys use **snake_case** (e.g., ``random_int``).
* Enum wrapper members use **snake_case** (e.g., ``ColorSpace.rgb``).
* Underlying implementations:

  * Python enums and functions use ``snake_case``.
  * JavaScript enums and functions use ``camelCase``.

Preset Keys
-----------

Each preset is a dictionary that can contain the following top-level keys:

layers
~~~~~~

**Type:** Array of strings

**Purpose:** Inherit settings, generators, and effects from parent presets.

The composer applies parent presets in order. Later presets override earlier ones. The current preset's settings override all parents.

.. code-block:: javascript

    layers: ["basic", "voronoi", "grain"]

settings
~~~~~~~~

**Type:** Dictionary

**Purpose:** Define variables for use throughout the preset as ``settings.key_name``.

Settings support literals, enum references, helper functions, arithmetic expressions, and conditionals.

.. code-block:: javascript

    settings: {
      freq: random_int(10, 15),
      octaves: 8,
      reindex_range: 1.25 + random() * 1.25,
      color_space: ColorSpace.rgb,
    }

This example from the ``acid`` preset shows typical settings usage.

generator
~~~~~~~~~

**Type:** Dictionary

**Purpose:** Configure noise generation parameters passed to ``noisemaker.generators.multires``.

.. code-block:: javascript

    generator: {
      freq: settings.freq,
      octaves: settings.octaves,
      lattice_drift: 1.0,
    }

All keys must be valid generator parameters. Common ones include ``freq``, ``octaves``, ``ridges``, ``distrib``, ``color_space``, ``hue_range``, ``lattice_drift``, ``corners``, and ``spline_order``.

octaves
~~~~~~~

**Type:** Array of effect calls

**Purpose:** Effects applied to each octave of noise during generation.

.. code-block:: javascript

    octaves: [
      derivative(alpha: 0.333),
    ]

post
~~~~

**Type:** Array of effect calls and/or preset references

**Purpose:** Effects applied after noise octaves are combined.

.. code-block:: javascript

    post: [
      bloom(alpha: 0.25),
      saturation(amount: 1.5),
    ]

final
~~~~~

**Type:** Array of effect calls and/or preset references

**Purpose:** Final effects applied after all post-processing.

.. code-block:: javascript

    final: [
      aberration(displacement: 0.01),
    ]

unique
~~~~~~

**Type:** Boolean

**Purpose:** Mark preset as unique (not for general layering). Defaults to false.

.. code-block:: javascript

    unique: true

Data Types
----------

The DSL supports the following data types:

Numbers
~~~~~~~

Integers and floats, including arithmetic expressions:

.. code-block:: javascript

    freq: 5
    alpha: 0.5 + random() * 0.25
    computed: settings.base * 2 + 1

Strings
~~~~~~~

Double-quoted strings (no escape sequences):

.. code-block:: javascript

    palette_name: "viridis"

Booleans
~~~~~~~~

Keywords ``true`` and ``false``:

.. code-block:: javascript

    ridges: true
    inverse: false

Null
~~~~

Keyword ``null``:

.. code-block:: javascript

    mask: null

Arrays
~~~~~~

Lists of values:

.. code-block:: javascript

    freq: [4, 8]
    layers: ["basic", "grain"]
    options: [1, 2, 3]

Dictionaries
~~~~~~~~~~~~

Key-value pairs:

.. code-block:: javascript

    settings: {
      key1: value1,
      key2: value2,
    }

Enums
~~~~~

Access enum members using dot notation:

.. code-block:: javascript

    color_space: ColorSpace.rgb
    mask: ValueMask.chess
    dist_metric: DistanceMetric.euclidean

Available enums include: ``ColorSpace``, ``ValueDistribution``, ``ValueMask``, ``DistanceMetric``, ``VoronoiDiagramType``, ``PointDistribution``, ``InterpolationType``, ``OctaveBlending``, ``WormBehavior``, and more.

Expressions
-----------

Arithmetic
~~~~~~~~~~

Standard operators: ``+``, ``-``, ``*``, ``/``

.. code-block:: javascript

    reindex_range: 1.25 + random() * 1.25
    double_freq: settings.freq * 2

Conditional (Ternary)
~~~~~~~~~~~~~~~~~~~~~

JavaScript-style ternary:

.. code-block:: javascript

    voronoi_inverse: coin_flip() ? true : false
    freq: random() < 0.5 ? 4 : 8

Comparison and Logic
~~~~~~~~~~~~~~~~~~~~

Comparison operators: ``<``, ``>``, ``<=``, ``>=``, ``==``, ``!=``

Logical operators: ``&&`` (and), ``||`` (or)

.. code-block:: javascript

    use_effect: random() < 0.75

Settings References
~~~~~~~~~~~~~~~~~~~

Access previously defined settings:

.. code-block:: javascript

    settings: {
      freq: random_int(8, 12),
      reflect_range: 7.5 + random() * 3.5,
    }

Helper Functions
----------------

The DSL provides built-in helper functions for randomization and utilities:

random()
~~~~~~~~

Returns a random float between 0.0 and 1.0.

.. code-block:: javascript

    bloom_alpha: 0.025 + random() * 0.0125

random_int(min, max)
~~~~~~~~~~~~~~~~~~~~

Returns a random integer between ``min`` and ``max`` (inclusive).

.. code-block:: javascript

    freq: random_int(10, 15)
    voronoi_sdf_sides: random_int(2, 8)

coin_flip()
~~~~~~~~~~~

Returns a random boolean (true or false).

.. code-block:: javascript

    voronoi_inverse: coin_flip()

random_member(collection)
~~~~~~~~~~~~~~~~~~~~~~~~~

Returns a random member from a single iterable. The iterable can be an enum (for example,
``DistanceMetric``) or any collection that yields members. Passing scalars directly raises an
error.

.. code-block:: javascript

    dist_metric: random_member(DistanceMetric.all())

    voronoi_diagram_type: random_member([
      VoronoiDiagramType.range,
      VoronoiDiagramType.color_range,
      VoronoiDiagramType.regions,
    ])

enum_range(start, end)
~~~~~~~~~~~~~~~~~~~~~~

Returns a list of enum members from ``start`` to ``end`` (inclusive). Both arguments must be
members of the same enum.

.. code-block:: javascript

  values: enum_range(InterpolationType.constant, InterpolationType.bicubic)
  // [InterpolationType.constant, InterpolationType.linear,
  //  InterpolationType.cosine, InterpolationType.bicubic]

stash(key, value)
~~~~~~~~~~~~~~~~~

Stores a value for later retrieval within the same evaluation context.

.. code-block:: javascript

    temp: stash("my_key", 42)
    retrieved: stash("my_key")

mask_freq(mask, repeat)
~~~~~~~~~~~~~~~~~~~~~~~

Returns the appropriate frequency for a given mask and repeat value.

.. code-block:: javascript

    freq: mask_freq(ValueMask.chess, 8)

preset(name)
~~~~~~~~~~~~

Inline another preset's post/final effects.

.. code-block:: javascript

    post: [
      bloom(alpha: 0.25),
      preset("grain"),
    ]

Enum Helper Methods
-------------------

Enums provide helper methods to filter and retrieve specific members:

``EnumType.all()``
~~~~~~~~~~~~~~~~~~

Returns all enum members.

.. code-block:: javascript

    all_colors: ColorSpace.all()

Specific Enum Methods
~~~~~~~~~~~~~~~~~~~~~

Different enums provide specialized filter methods:

**ColorSpace:**

* ``ColorSpace.color_members()`` - Color spaces only

**DistanceMetric:**

* ``DistanceMetric.absolute_members()`` - Absolute metrics
* ``DistanceMetric.all()`` - All metrics

**ValueMask:**

* ``ValueMask.procedural_members()`` - Procedural masks
* ``ValueMask.grid_members()`` - Grid-based masks
* ``ValueMask.glyph_members()`` - Glyph/character masks
* ``ValueMask.nonprocedural_members()`` - Non-procedural masks
* ``ValueMask.rgb_members()`` - RGB-based masks

**PointDistribution:**

* ``PointDistribution.circular_members()`` - Circular distributions
* ``PointDistribution.grid_members()`` - Grid-based distributions

**WormBehavior:**

* ``WormBehavior.all()`` - All worm behaviors

Example usage:

.. code-block:: javascript

    dist_metric: random_member(DistanceMetric.all())
    color_space: random_member(ColorSpace.color_members())
    mask: random_member(ValueMask.grid_members())

Effect Calls
------------

Call effects with named parameters using colon syntax:

.. code-block:: javascript

    effect_name(param1: value1, param2: value2)

Examples from actual presets:

.. code-block:: javascript

    octaves: [
      derivative(alpha: 0.333),
    ]
    
    post: [
      bloom(alpha: settings.bloom_alpha),
      saturation(amount: 1.5),
    ]
    
    final: [
      aberration(displacement: 0.01),
    ]

Complete Example
----------------

Here's the ``acid`` preset from the standard library (one of many presets in :file:`share/dsl/presets.dsl`):

.. code-block:: javascript

    {
      "acid": {
        layers: ["basic", "reindex-post", "normalize"],
        settings: {
          color_space: ColorSpace.rgb,
          freq: random_int(10, 15),
          octaves: 8,
          reindex_range: 1.25 + random() * 1.25,
        },
      },
      
      // ... hundreds of other presets ...
    }

This preset demonstrates:

* **Layering**: Inherits from ``basic`` (noise generation), ``reindex-post`` (color reindexing effect), and ``normalize`` (value normalization)
* **Settings**: Defines randomized frequency (10-15), fixed octave count (8), and randomized reindex range
* **Enums**: Uses ``ColorSpace.rgb`` for RGB color space
* **Randomization**: Combines ``random_int()`` and ``random()`` for varied output

Another example, ``acid-droplets``, shows a more complex preset:

.. code-block:: javascript

    {
      "acid-droplets": {
        layers: [
          "multires",
          "reflect-octaves",
          "density-map",
          "random-hue",
          "bloom",
          "shadow",
          "saturation"
        ],
        settings: {
          freq: random_int(8, 12),
          hue_range: 0,
          lattice_drift: 1.0,
          mask: ValueMask.sparse,
          mask_static: true,
          palette_on: false,
          reflect_range: 7.5 + random() * 3.5,
        },
      },
    }

This demonstrates extensive layering of multiple effect presets to create a complex composition.

Naming Conventions
------------------

The DSL follows these naming conventions:

* **Preset names**: ``kebab-case`` (e.g., ``"my-awesome-preset"``)
* **Setting keys**: ``snake_case`` (e.g., ``base_freq``, ``bloom_alpha``)
* **Function names**: ``snake_case`` (e.g., ``random_int``, ``coin_flip``)
* **Enum types**: ``PascalCase`` (e.g., ``ColorSpace``, ``ValueMask``)
* **Enum members**: ``snake_case`` (e.g., ``ColorSpace.rgb``, ``ValueMask.chess``)

Best Practices
--------------

1. **Use settings for reusable values**

   .. code-block:: javascript

       settings: {
         bloom_alpha: 0.025 + random() * 0.0125,
       },
       final: [
         bloom(alpha: settings.bloom_alpha),
       ]

2. **Layer presets for composition**

   .. code-block:: javascript

       layers: ["basic", "reindex-post", "normalize"]

3. **Use descriptive setting names**

   .. code-block:: javascript

       reflect_range: 7.5 + random() * 3.5  // Good
       rr: 7.5 + random() * 3.5              // Bad

4. **Reference the canonical library**

   Study existing presets in :file:`share/dsl/presets.dsl` for patterns and techniques.

Debugging
---------

When a preset doesn't parse or evaluate correctly:

1. **Check syntax**: Ensure all braces, brackets, and parentheses are balanced
2. **Check enum names**: Enum references must exactly match defined enums
3. **Check parameter names**: Effect parameters must match the effect's signature
4. **Check setting references**: They must exactly match defined keys
5. **Test incrementally**: Build complex presets step-by-step

The Python and JavaScript parsers provide error messages with line/column information when syntax errors occur.

Using Presets
-------------

.. note::
   JavaScript examples assume an ES module environment (for example, ``<script type="module">``) so that ``await`` can be used at the top level.

Basic Usage
~~~~~~~~~~~

Python
^^^^^^

.. code-block:: python

    from noisemaker.composer import Preset

    preset = Preset('acid')
    preset.render(seed=1, shape=[1024, 1024, 3], filename='acid.png')

JavaScript
^^^^^^^^^^

.. code-block:: javascript

    import { PRESETS } from './js/noisemaker/presets.js';
    import { Preset } from './js/noisemaker/composer.js';

    const presets = PRESETS();
    const preset = new Preset('acid', presets);
    await preset.render(1, {
      width: 1024,
      height: 1024,
      canvas: document.getElementById('output')
    });

Working with Arrays
~~~~~~~~~~~~~~~~~~~

Python
^^^^^^

.. code-block:: python

    from noisemaker.composer import Preset

    preset = Preset('voronoi')
    tensor = preset.render(seed=42, shape=[512, 512, 3])
    array = tensor.numpy()

JavaScript
^^^^^^^^^^

.. code-block:: javascript

    import { PRESETS } from './js/noisemaker/presets.js';
    import { Preset } from './js/noisemaker/composer.js';

    const presets = PRESETS();
    const preset = new Preset('voronoi', presets);
    const tensor = await preset.render(42, { width: 512, height: 512 });
    const array = tensor.read();

Override Settings
~~~~~~~~~~~~~~~~~

Python
^^^^^^

.. code-block:: python

    from noisemaker.composer import Preset

    preset = Preset('acid', settings={'freq': 20, 'octaves': 12})
    preset.render(seed=1, shape=[1024, 1024, 3], filename='custom.png')

JavaScript
^^^^^^^^^^

.. code-block:: javascript

    import { PRESETS } from './js/noisemaker/presets.js';
    import { Preset } from './js/noisemaker/composer.js';

    const presets = PRESETS();
    const preset = new Preset('acid', presets, { freq: 20, octaves: 12 });
    await preset.render(1, { width: 1024, height: 1024 });

List Available Presets
~~~~~~~~~~~~~~~~~~~~~~

Python
^^^^^^

.. code-block:: python

    from noisemaker.presets import PRESETS

    presets = PRESETS()
    print(list(presets.keys()))

JavaScript
^^^^^^^^^^

.. code-block:: javascript

    import { PRESETS } from './js/noisemaker/presets.js';

    const presets = PRESETS();
    console.log(Object.keys(presets));

Architecture Overview
---------------------

The Noisemaker Composer system has three layers:

1. **DSL Layer** (:mod:`noisemaker.dsl`)
   
   This layer parses and evaluates the Composer DSL from :file:`share/dsl/presets.dsl`. Both Python and JavaScript use the same DSL file for consistency across platforms.

2. **Preset Layer** (:mod:`noisemaker.presets`, :mod:`noisemaker.composer`)
   
   This layer loads preset definitions and provides the ``Preset`` class for rendering. It handles preset inheritance (layering), resolves settings, and applies effects.

3. **Generator/Effect Layer** (:mod:`noisemaker.generators`, :mod:`noisemaker.effects`)
   
   Low-level TensorFlow operations for generating procedural noise and applying image effects.

The DSL provides a declarative interface to these lower-level APIs. You can compose complex generative art without writing imperative code.

Cross-Platform Compatibility
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Both the Python and JavaScript implementations:

* Parse the same DSL file (:file:`share/dsl/presets.dsl`)
* Use identical tokenizer, parser, and evaluator logic
* Produce deterministic output given the same seed
* Support the same set of helper functions and enums

Any change to the DSL immediately applies to both environments. This shared source helps maintain consistency across platforms.

See Also
--------

* :doc:`api` - Low-level generator and effect APIs
* :doc:`cli` - Command-line interface documentation
* :mod:`noisemaker.presets` - Preset loading and evaluation
* :mod:`noisemaker.dsl` - DSL parser and evaluator modules
* :mod:`noisemaker.composer` - Composer class and rendering API
