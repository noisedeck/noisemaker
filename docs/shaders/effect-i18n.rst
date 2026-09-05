.. _shader-effect-i18n:

Effect String Localization
==========================

You can translate effect display names, descriptions, parameter labels, and enum
option labels. Translation requires no changes to effect definitions, the
manifest, or existing consumers. The definitions remain the English source of
truth. Translations ship as separate, optional catalogs that consumers enable
at runtime.

How it works
------------

A generated **English base catalog** lists every human-facing effect string,
keyed by stable IDs derived from identifiers effects already use:

.. code-block:: text

   <namespace>/<effect>                        effect display name
   <namespace>/<effect>#desc                   description
   <namespace>/<effect>.<paramId>              parameter label
   <namespace>/<effect>.<paramId>.<choiceKey>  enum option label
   @ns/<namespace>                             namespace label

The generator writes the catalog to ``shaders/effects/strings.en.json``.
Distribution copies it to the CDN beside ``manifest.json``
(``.../effects/strings.en.json``). A translator copies the catalog to
``strings.<locale>.json`` and translates the values. Partial files are valid.
The localizer uses English for any missing key. Names and labels keep the
definition's explicit casing (for example ``Adjust``).

Generating the base catalog
---------------------------

.. code-block:: bash

   npm run strings

Run this command after any of these changes:

- Adding or removing an effect
- Changing a ``name``, ``description``, or ``ui.label``
- Changing a ``choices`` key

The test
``npm run test:shaders:i18n`` fails if the committed ``strings.en.json`` is out
of date.

Consuming translations
----------------------

The localizer belongs to ``CanvasRenderer`` and is **opt-in**. Until a consumer
sets a locale, behavior stays unchanged and the renderer fetches no catalog:

.. code-block:: javascript

   await renderer.setLocale('fr')              // fetches strings.fr.json (+ en base)
   renderer.getLocale()                         // 'fr'

   // generic lookup: active locale -> en base -> fallback
   renderer.localize('filter/adjust', 'adjust')            // effect name
   renderer.localize('filter/adjust.rotation', 'rotation') // parameter label

   // descriptions are localized transparently through the existing API
   renderer.getEffectDescription('filter/adjust')

   await renderer.setLocale(null)               // back to unchanged English

``localize(id, fallback)`` searches in this order:

1. The active locale
2. The English base catalog
3. The ``fallback`` argument

Pass the consumer's current English text as ``fallback``, such as the
``camelToSpaceCase`` display. This preserves the current English output when
no locale is set or a key is missing.

Backward compatibility
----------------------

- ``manifest.json`` and effect definitions are unchanged.
- ``strings.<locale>.json`` are separate, optional downloads.
- With no locale set, every API returns its previous English value.
- For a missing, empty, or unfetchable locale value, the localizer uses the
  English base, then the caller's fallback. To leave a string untranslated,
  omit the key. An empty value also selects English.

Adding a locale
---------------

1. Copy ``shaders/effects/strings.en.json`` to ``strings.<locale>.json``.
2. Translate the values (leave the keys/identifiers untouched).
3. Ship the catalog. The bundler copies ``strings.*.json`` into ``dist``.
4. Consumers call ``renderer.setLocale('<locale>')``.

Not translated
--------------

Never translate identifiers. They are part of the DSL / uniform contract:
``namespace``, ``func``, parameter names, ``choices`` values, ``uniform`` names,
and ``tags``. Parameter ``category`` strings are grouping keys. The catalog excludes them.
