.. _releases:

Release Process
===============

Noisemaker is a monorepo with three release tracks: Python, JavaScript, and Shaders. The ``pyproject.toml`` and ``package.json`` files define the project version as a ``MAJOR.MINOR`` string. Never write patch numbers by hand. CI computes them for every release from the existing git tags.

Versioning
----------

Noisemaker follows a **Living Version** scheme for in-repo metadata combined with **tag-on-commit** for the shader track:

- In-repo metadata (``pyproject.toml``, ``package.json``, ``js/bin/noisemaker-js``, ``docs/conf.py``) carries **only** ``MAJOR.MINOR``. You never see a ``PATCH`` segment in source, and you never see a ``-SNAPSHOT`` / ``.dev0`` suffix.
- Humans only edit the metadata when crossing a minor (``1.0`` → ``1.1``) or major (``1.x`` → ``2.0``) boundary.
- Every qualifying push to ``main`` is a shader release. CI computes the next patch as ``max existing vMAJOR.MINOR.* tag + 1``, or ``0`` if no matching tag exists. CI builds, deploys, and creates the ``vMAJOR.MINOR.PATCH`` annotated tag automatically.

For any given commit on ``main``, the resulting release has a concrete patch version derived from history.

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
- **Push to main** (after tests pass): builds browser bundles (``noisemaker.bundle.js``, ``.min.js``, ``.esm.js``, ``.cjs``) and a CLI bundle. It builds standalone executables for Linux x64, macOS arm64, and Windows x64.
- **Snapshot release**: the workflow creates or replaces a GitHub pre-release tagged ``{version}-SNAPSHOT`` with all JS bundles and platform executables. It updates the snapshot on every qualifying push to ``main``.

Shaders (``shaders.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^

Runs on push/PR to ``main`` when ``shaders/``, ``scripts/``, ``demo/``, or related files change.

- **PR / push**: CPU-only verification that changed dual-language shader sources
  carry current cross-backend parity attestations, DSL language tests,
  Playwright render tests (WebGL2), and structure tests.
- **Push to main** (after tests pass): builds shader bundles and packages them as ``noisemaker-shaders.tar.gz`` for the automatically created GitHub release. It then delegates the release to the platform release infrastructure.
- **Automated release** (delegated): the platform workflow performs these steps:

  1. Checks out noisemaker at the pushed commit.
  2. Reads ``MAJOR.MINOR`` from ``pyproject.toml``.
  3. Computes the next patch from existing ``v*`` tags.
  4. Rebuilds the shader bundles.
  5. Deploys them to the CDN origin at ``/MAJOR.MINOR.PATCH/``.
  6. Atomically updates the rolling ``/MAJOR/`` and ``/MAJOR.MINOR/`` symlinks to the new patch directory.
  7. Creates the ``vMAJOR.MINOR.PATCH`` annotated tag.
  8. Pushes the tag to this repository.
- **Demo site deploy**: each qualifying push also builds and syncs the noisemaker.app demo site, which is separate from the shader CDN.

There is no manual tagging step. There is no ``-SNAPSHOT`` for shaders. Every commit that touches shader code produces a concrete, immutable patch release and a new ``v*`` tag.

Tagged release (``release.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Any ``v*`` tag push triggers this workflow. Under the current tag-on-commit scheme, the automated shader release creates every tag. Humans do not push tags.

- Builds all artifacts in parallel: JS browser bundles, CLI bundle, standalone executables (Linux/macOS/Windows), and shader bundles.
- Creates a GitHub release with auto-generated notes and attaches all artifacts.

Downstream triggers (``trigger-noisedeck.yml``)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Runs on push to ``main``/``master`` when ``shaders/`` or ``demo/shaders/`` change. Also supports manual dispatch.

- Sends ``repository_dispatch`` events to downstream consumer repos so they can pull the latest noisemaker changes.

CDN Versioning
--------------

The ``shaders.noisedeck.app`` CDN hosts shader bundles in per-patch directories. Two rolling symlinks track the newest patch in their respective scope:

::

    shaders.noisedeck.app/
    ├── 1.0.0/      ← immutable exact release
    ├── 1.0.1/      ← immutable exact release
    ├── 1.0   → 1.0.1   ← rolling latest within the 1.0 minor series
    ├── 1      → 1.0.1   ← rolling latest within major 1

Three pinning levels are available to consumers:

- ``shaders.noisedeck.app/1/`` — rolling latest within **major 1**. It automatically tracks every minor and patch release until ``2.0`` ships. At that point, ``/1/`` freezes and consumers explicitly migrate to ``/2/``. This is the recommended default for most integrations.
- ``shaders.noisedeck.app/1.0/`` — rolling latest within the **1.0 minor series**. It stays pinned to the 1.0.x line and never automatically crosses a minor boundary.
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
- **Shaders**: released automatically on every qualifying push to ``main``. Each release creates a new immutable ``/MAJOR.MINOR.PATCH/`` directory on the CDN and refreshes the rolling ``/MAJOR/`` and ``/MAJOR.MINOR/`` symlinks. CI creates the git ``v*`` tag. The tag triggers the tagged release workflow, which publishes a GitHub release with all artifacts.
- **Minor and major bumps**: a human initiates these with a commit that edits ``MAJOR.MINOR`` in metadata. The next automated release produces ``.0`` of the new series. For example, changing ``1.0`` to ``1.1`` produces ``v1.1.0``. Changing ``1.9`` to ``2.0`` produces ``v2.0.0``. The workflow never applies patches to older series.
