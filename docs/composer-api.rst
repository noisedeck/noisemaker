Composer API (CPU)
==================

This reference covers Noisemaker's original Python effects library and its vanilla JS port. They render on the CPU through TensorFlow (Python) or Canvas 2D (JS). These libraries are separate from the GPU shader engine.

.. raw:: html

   <div class="preset-viewer-container">
     <div class="preset-viewer-example">
       <div class="preset-viewer-canvas-wrapper">
         <canvas class="preset-viewer-canvas" width="384" height="384"></canvas>
         <button class="noisemaker-live-random preset-viewer-random">Random</button>
         <div class="preset-viewer-loading">Rendering (0%)</div>
       </div>
       <div class="preset-viewer-controls">
         <div class="preset-viewer-select-wrapper">
           <label for="composer-preset-select">Preset</label>
           <select class="preset-viewer-select" id="composer-preset-select">
             <option>Loading presets...</option>
           </select>
         </div>
         <div class="preset-viewer-code-wrapper">
           <label>Preset Definition</label>
           <pre class="preset-viewer-code">// Select a preset to view its definition</pre>
         </div>
       </div>
     </div>
   </div>
   <script type="module" src="/_static/preset-viewer.js"></script>

.. toctree::
   :maxdepth: 1

   composer
   api
   cli
   javascript
