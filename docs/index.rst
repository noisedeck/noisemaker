.. Noisemaker documentation master file

Noisemaker
==========

.. toctree::
   :maxdepth: 1
   :caption: Contents:
   :hidden:

   shaders
   composer-api
   coding-agents
   releases


**Noisemaker** is a GPU rendering engine for real-time visual effects in the browser with no required build step or dependencies.

* **Dual backends** — WebGL2 and WebGPU
* **Composable DSL** for building effect chains
* **Growing library** of shader effects


.. raw:: html

   <div class="shader-viewer-container">
     <div class="shader-viewer-example">
       <div class="shader-viewer-canvas-wrapper">
         <canvas class="shader-viewer-canvas" width="384" height="384"></canvas>
         <pre class="shader-viewer-dsl-overlay"></pre>
         <button class="shader-viewer-random">Random</button>
         <div class="shader-viewer-loading">Loading...</div>
       </div>
       <div class="shader-viewer-controls">
         <div class="shader-viewer-select-wrapper">
           <label for="shader-effect-select">Effect</label>
           <select class="shader-viewer-select" id="shader-effect-select">
             <option>Loading effects...</option>
           </select>
         </div>
         <div class="shader-viewer-params-label">Parameters</div>
         <div class="shader-viewer-params">
           <!-- Dynamic controls will be inserted here -->
         </div>
       </div>
     </div>
   </div>
   <style>
   .shader-viewer-canvas-wrapper {
     position: relative;
   }
   .shader-viewer-dsl-overlay {
     position: absolute;
     top: 8px;
     left: 8px;
     right: 8px;
     margin: 0;
     padding: 0;
     background: transparent;
     font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
     font-size: 11px;
     line-height: 1.4;
     pointer-events: none;
     z-index: 10;
     overflow: visible;
     white-space: pre-wrap;
     word-wrap: break-word;
   }
   .shader-viewer-dsl-overlay span {
     background: rgba(0, 0, 0, 0.7);
     color: #fff;
     padding: 2px 4px;
     display: inline;
     box-decoration-break: clone;
     -webkit-box-decoration-break: clone;
   }
   </style>
   <script src="/_static/noisemaker-shaders-core.min.js"></script>
   <script src="/_static/shader-viewer.js"></script>

Quick Start
-----------

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    const { CanvasRenderer } = await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

    const renderer = new CanvasRenderer({
        canvas: document.getElementById('canvas'),
        width: 1024, height: 1024,
        basePath: SHADER_CDN,
        useBundles: true,
        bundlePath: `${SHADER_CDN}/effects`
    })

    await renderer.loadManifest()
    await renderer.loadEffect('synth/noise')

    await renderer.compile(`
        search synth
        noise().write(o0)
        render(o0)
    `)

    renderer.start()

See :doc:`shaders/integration` for full API documentation.

----

Noisemaker is the open source engine behind `Noisedeck <https://noisedeck.app/>`_,
`Layers <https://layers.noisefactor.io/>`_, and other
`Noise Factor <https://noisefactor.io/>`_ tools.

.. _`Noisemaker`: https://github.com/noisefactorllc/noisemaker
