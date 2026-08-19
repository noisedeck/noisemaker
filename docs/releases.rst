.. _releases:

Release Process
===============

Noisemaker is a monorepo with three release tracks: Python, JavaScript, and Shaders. The project version is defined in ``pyproject.toml`` and ``package.json`` as a ``MAJOR.MINOR`` string. Patch numbers are never written by hand — they are computed by CI on every release, from the set of existing git tags.

Versioning
----------

Noisemaker follows a **Living Version** scheme for in-repo metadata combined with **tag-on-commit** for the shader track:

- In-repo metadata (``pyproject.toml``, ``package.json``, ``js/bin/noisemaker-js``, ``docs/conf.py``) carries **only** ``MAJOR.MINOR``. You never see a ``PATCH`` segment in source, and you never see a ``-SNAPSHOT`` / ``.dev0`` suffix.
- Humans only edit the metadata when crossing a minor (``1.0`` → ``1.1``) or major (``1.x`` → ``2.0``) boundary.
- Every qualifying push to ``main`` is a shader release. CI computes the next patch as ``max existing vMAJOR.MINOR.* tag + 1`` (or ``0`` if none), builds, deploys, and creates the ``vMAJOR.MINOR.PATCH`` annotated tag automatically.

This means: for any given commit on ``main``, the resulting release has a concrete patch version that nobody typed — it's derived from history.

Workflows
---------

Python (``python.yml``)
^^^^^^^^^^^^^^^^^^^^^^^

Runs on push/PR to ``main`` when ``noisemaker/``, ``pyproject.toml``, or related files change.

- **Verify only** -- tests (pytest across Python 3.10-3.12 on Linux/macOS/Windows), lint (black, ruff), and type-check (mypy).
- No publishing step. Python releases are repo-only for now.

JavaScript (``js.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^

Runs on push/PR to ``main`` when ``js/``, ``scripts/``, or related files change.

- **PR / push**: lint (ESLint) and tests run in parallel.
- **Push to main** (after tests pass): builds browser bundles (``noisemaker.bundle.js``, ``.min.js``, ``.esm.js``, ``.cjs``), a CLI bundle, and standalone executables for Linux x64, macOS arm64, and Windows x64.
- **Snapshot release**: a GitHub pre-release tagged ``{version}-SNAPSHOT`` is created (or replaced) with all JS bundles and platform executables. The snapshot is updated on every qualifying push to ``main``.

Shaders (``shaders.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^

Runs on push/PR to ``main`` when ``shaders/``, ``scripts/``, ``demo/``, or related files change.

- **PR / push**: CPU-only verification that changed dual-language shader sources
  carry current cross-backend parity attestations, DSL language tests,
  Playwright render tests (WebGL2), and structure tests.
- **Push to main** (after tests pass): builds shader bundles and packages them as ``noisemaker-shaders.tar.gz`` (for attachment to the auto-created GitHub release), then delegates the release to the platform release infrastructure.
- **Automated release** (delegated): the platform workflow checks out noisemaker at the pushed commit, reads ``MAJOR.MINOR`` from ``pyproject.toml``, computes the next patch from existing ``v*`` tags, rebuilds the shader bundles, deploys them to the CDN origin at ``/MAJOR.MINOR.PATCH/``, atomically updates the rolling ``/MAJOR/`` and ``/MAJOR.MINOR/`` symlinks to point at the new patch directory, and creates and pushes the ``vMAJOR.MINOR.PATCH`` annotated tag back to this repo.
- **Demo site deploy**: the noisemaker.app demo site (separate from the shader CDN) is also built and synced on each qualifying push.

There is no manual tagging step. There is no ``-SNAPSHOT`` for shaders. Every commit that touches shader code produces a concrete, immutable patch release and a new ``v*`` tag.

Tagged release (``release.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Triggered by any ``v*`` tag push. Under the current tag-on-commit scheme, every tag is created by the automated shader release described above — there are no hand-pushed tags.

- Builds all artifacts in parallel: JS browser bundles, CLI bundle, standalone executables (Linux/macOS/Windows), and shader bundles.
- Creates a GitHub release with auto-generated notes and attaches all artifacts.

Downstream triggers (``trigger-noisedeck.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Runs on push to ``main``/``master`` when ``shaders/`` or ``demo/shaders/`` change. Also supports manual dispatch.

- Sends ``repository_dispatch`` events to downstream consumer repos so they can pull the latest noisemaker changes.

CDN Versioning
--------------

Shader bundles are hosted at ``shaders.noisedeck.app`` in per-patch directories, plus two rolling symlinks that track the newest patch in their respective scope:

::

    shaders.noisedeck.app/
    ├── 1.0.0/      ← immutable exact release
    ├── 1.0.1/      ← immutable exact release
    ├── 1.0   → 1.0.1   ← rolling latest within the 1.0 minor series
    ├── 1      → 1.0.1   ← rolling latest within major 1

Three pinning levels are available to consumers:

- ``shaders.noisedeck.app/1/`` — rolling latest within **major 1**. Automatically tracks every minor and patch release until a ``2.0`` ships; at that point ``/1/`` freezes and consumers explicitly migrate to ``/2/``. This is the recommended default for most integrations.
- ``shaders.noisedeck.app/1.0/`` — rolling latest within the **1.0 minor series**. Stays pinned to the 1.0.x line; never automatically crosses a minor boundary.
- ``shaders.noisedeck.app/1.0.1/`` — **exact pin**, immutable. Required for reproducible builds.

See :doc:`shaders/integration` for usage examples at each pinning level.

Release Artifacts
-----------------

.. list-table::
   :header-rows: 1
   :widths: 30 25 20

   * - Artifact
     - Format
     - Included in
   * - Browser bundles
     - ``.bundle.js``, ``.min.js``, ``.esm.js``, ``.cjs``
     - Snapshot, Tagged
   * - CLI bundle
     - built via ``build:cli``
     - Snapshot, Tagged
   * - Standalone CLI (Linux x64)
     - ``.tar.gz``
     - Snapshot, Tagged
   * - Standalone CLI (macOS arm64)
     - ``.tar.gz``
     - Snapshot, Tagged
   * - Standalone CLI (Windows x64)
     - ``.zip``
     - Snapshot, Tagged
   * - Shader bundle
     - ``.tar.gz``
     - Tagged
   * - Shader bundle (on CDN)
     - directory tree
     - Every commit to ``main``

Release Cadence
---------------

- **Python**: repo-only (CI verification). No published packages yet.
- **JavaScript snapshots**: updated automatically on every push to ``main``.
- **Shaders**: released automatically on every qualifying push to ``main``. Each release creates a new immutable ``/MAJOR.MINOR.PATCH/`` directory on the CDN and refreshes the rolling ``/MAJOR/`` and ``/MAJOR.MINOR/`` symlinks. The git ``v*`` tag is created by CI, which in turn triggers the tagged release workflow to publish a GitHub release with all artifacts.
- **Minor and major bumps**: initiated by a human commit that edits the ``MAJOR.MINOR`` string in metadata. The next automated release after such a commit will land ``.0`` of the new series (e.g., editing ``1.0`` → ``1.1`` produces ``v1.1.0``; editing ``1.9`` → ``2.0`` produces ``v2.0.0``). The workflow never back-patches older series.
