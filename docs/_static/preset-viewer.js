/**
 * Embedded Preset Viewer for Composer docs
 * Lightweight version of demo/js for inline documentation
 */

(function() {
    'use strict';

    // Will be populated when noisemaker bundle loads
    let Preset = null;
    let PRESETS = null;
    let render = null;
    let Context = null;
    let rng = null;
    let presetSource = {};
    const bundleDslCache = new Map();

    // Root-absolute so they resolve the same from any page depth. The
    // dirhtml builder puts non-index pages one level down
    // (/composer-api/), where a bare '_static/...' would resolve to
    // /composer-api/_static/... and 404.
    const BUNDLE_CANDIDATES = [
        '/_static/noisemaker.min.js',
        '/_static/noisemaker.bundle.js',
        '/_static/noisemaker.umd.js',
        '/_static/noisemaker.js',
    ];

    const BUNDLE_MAX_ATTEMPTS = 50;
    const BUNDLE_WAIT_DELAY_MS = 100;

    let bundleLoadPromise = null;

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function findExistingBundleScript() {
        return document.querySelector('script[data-noisemaker-bundle="true"]') ||
            document.querySelector('script[src*="noisemaker"]:not([src*="noisemaker-live"])');
    }

    function createBundleScript(src) {
        const script = document.createElement('script');
        script.src = src;
        script.defer = true;
        script.dataset.noisemakerBundle = 'true';
        return script;
    }

    function loadBundleScript(script) {
        return new Promise((resolve, reject) => {
            script.addEventListener('load', () => resolve(script), { once: true });
            script.addEventListener('error', () => {
                script.remove();
                reject(new Error(`Failed to load Noisemaker bundle at ${script.src}`));
            }, { once: true });
            document.head.appendChild(script);
        });
    }

    async function resolveNoisemakerFromWindow() {
        let module = window.Noisemaker;
        if (!module) {
            throw new Error('Noisemaker bundle did not attach to window');
        }

        if (typeof module.then === 'function') {
            module = await module;
        }

        if (module && typeof module === 'object' && !module.Preset && module.default && typeof module.default === 'object') {
            const candidate = module.default;
            if (candidate && candidate.Preset) {
                module = candidate;
            }
        }

        if (!module || typeof module.Preset !== 'function' || typeof module.render !== 'function') {
            throw new Error('Noisemaker bundle missing expected exports');
        }

        window.Noisemaker = module;
        return module;
    }

    async function ensureNoisemakerBundle() {
        if (bundleLoadPromise) {
            return bundleLoadPromise;
        }

        bundleLoadPromise = (async () => {
            let lastError = null;
            const existingModule = window.Noisemaker;
            if (existingModule) {
                try {
                    const module = await resolveNoisemakerFromWindow();
                    const script = findExistingBundleScript();
                    return { module, bundleUrl: script ? script.src : null };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
            }

            for (const candidate of BUNDLE_CANDIDATES) {
                let script = null;
                try {
                    script = await loadBundleScript(createBundleScript(candidate));
                    await Promise.resolve();
                    const module = await resolveNoisemakerFromWindow();
                    return { module, bundleUrl: script.src };
                } catch (error) {
                    if (script) {
                        script.remove();
                    }
                    if (error instanceof Error) {
                        lastError = error;
                    } else {
                        lastError = new Error(String(error));
                    }
                    try {
                        window.Noisemaker = window.Noisemaker || undefined;
                    } catch (_) {
                        // Ignore cleanup issues; continue to next candidate
                    }
                }
            }

            let attempts = 0;
            while (!window.Noisemaker && attempts < BUNDLE_MAX_ATTEMPTS) {
                await delay(BUNDLE_WAIT_DELAY_MS);
                attempts++;
            }

            if (!window.Noisemaker) {
                throw lastError || new Error('Unable to load Noisemaker bundle');
            }

            try {
                const module = await resolveNoisemakerFromWindow();
                const script = findExistingBundleScript();
                return { module, bundleUrl: script ? script.src : null };
            } catch (error) {
                throw (error instanceof Error ? error : new Error(String(error)));
            }
        })();

        bundleLoadPromise.catch(() => {
            bundleLoadPromise = null;
        });

        return bundleLoadPromise;
    }

    async function fetchPresetDslFromBundle(bundleUrl) {
        if (!bundleUrl) {
            return '';
        }

        if (bundleDslCache.has(bundleUrl)) {
            return bundleDslCache.get(bundleUrl);
        }

        const promise = (async () => {
            try {
                const response = await fetch(bundleUrl);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const bundleText = await response.text();
                // Match the DSL string - variable names change with each minification
                const match = bundleText.match(/[a-z]+\s*=\s*`(\{[\s\S]*?\n\}\n)`\s*;function\s+\w+/);
                if (match && match[1]) {
                    return match[1];
                }
                console.warn('Preset viewer: DSL string not found in bundle');
                return '';
            } catch (error) {
                console.error('Preset viewer: failed to read presets from bundle', error);
                return '';
            }
        })();

        bundleDslCache.set(bundleUrl, promise);
        return promise;
    }

    function formatPreset(obj, indent = 0) {
        const pad = '  '.repeat(indent);
        if (typeof obj === 'function') {
            if (obj.length === 0) {
                try {
                    const result = obj();
                    if (result && typeof result === 'object') {
                        return formatPreset(result, indent);
                    }
                } catch (e) {
                    // ignore invocation failures
                }
            }
            return obj.toString();
        }
        if (obj && typeof obj === 'object') {
            if (Array.isArray(obj)) {
                return '[\n' + obj.map((v) => pad + '  ' + formatPreset(v, indent + 1)).join(',\n') + '\n' + pad + ']';
            }
            return '{\n' + Object.entries(obj).map(([k, v]) => pad + '  ' + JSON.stringify(k) + ': ' + formatPreset(v, indent + 1)).join(',\n') + '\n' + pad + '}';
        }
        return JSON.stringify(obj);
    }

    function toSnake(str) {
        return str.replace(/([A-Z])/g, (m) => '_' + m.toLowerCase());
    }

    function toSnakeKeys(obj) {
        const result = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                result[toSnake(key)] = obj[key];
            }
        }
        return result;
    }

    function serializePreset(preset, seed) {
        const toPlain = (effects) =>
            effects.map((fn) => ({
                effect: toSnake(fn.__effectName || fn.name || 'fn'),
                ...toSnakeKeys(fn.__params || {}),
            }));

        return {
            name: preset.name || 'unknown',
            layers: preset.layers || [],
            settings: preset.settings || {},
            generator: preset.generator ? {
                name: preset.generator.name || 'basic',
                ...toSnakeKeys(preset.generator.kwargs || {}),
            } : null,
            octaves: preset.octaves ? toPlain(preset.octaves) : [],
            post: preset.post ? toPlain(preset.post) : [],
            final: preset.final ? toPlain(preset.final) : [],
        };
    }

    async function initPresetViewer(container) {
        const canvas = container.querySelector('.preset-viewer-canvas');
        const select = container.querySelector('.preset-viewer-select');
        const codeArea = container.querySelector('.preset-viewer-code');
        const loadingIndicator = container.querySelector('.preset-viewer-loading');
        const randomButton = container.querySelector('.preset-viewer-random');

        if (!canvas || !select || !codeArea) {
            console.error('Preset viewer: missing required elements');
            return;
        }

        // Lazy load noisemaker bundle
        if (!Preset) {
            try {
                const { module: noisemakerModule, bundleUrl } = await ensureNoisemakerBundle();

                // Import exactly like javascript.rst shows
                Preset = noisemakerModule.Preset;
                PRESETS = noisemakerModule.PRESETS();
                render = noisemakerModule.render;
                Context = noisemakerModule.Context;
                rng = noisemakerModule.rng;

                const dslText = await fetchPresetDslFromBundle(bundleUrl);

                // Extract preset source exactly like demo/js does
                function extractPresetSource(source, name) {
                    const quotedName = `"${name}"`;
                    let searchStart = 0;

                    while (searchStart < source.length) {
                        const nameIdx = source.indexOf(quotedName, searchStart);
                        if (nameIdx === -1) return '';

                        let idx = nameIdx + quotedName.length;
                        while (idx < source.length && /\s/.test(source[idx])) idx++;

                        if (idx >= source.length || source[idx] !== ':') {
                            searchStart = nameIdx + quotedName.length;
                            continue;
                        }

                        idx++;
                        let braceIdx = idx;
                        while (braceIdx < source.length) {
                            const ch = source[braceIdx];
                            if (/\s/.test(ch)) {
                                braceIdx++;
                                continue;
                            }
                            if (ch === '/' && source[braceIdx + 1] === '/') {
                                braceIdx += 2;
                                while (braceIdx < source.length && source[braceIdx] !== '\n') braceIdx++;
                                continue;
                            }
                            if (ch === '/' && source[braceIdx + 1] === '*') {
                                braceIdx += 2;
                                while (braceIdx + 1 < source.length &&
                                    !(source[braceIdx] === '*' && source[braceIdx + 1] === '/')) {
                                    braceIdx++;
                                }
                                if (braceIdx + 1 < source.length) braceIdx += 2;
                                continue;
                            }
                            break;
                        }

                        if (braceIdx >= source.length || source[braceIdx] !== '{') {
                            searchStart = nameIdx + quotedName.length;
                            continue;
                        }

                        let end = braceIdx;
                        let depth = 0;
                        let inString = false;
                        let escaped = false;

                        while (end < source.length) {
                            const ch = source[end++];
                            if (inString) {
                                if (escaped) {
                                    escaped = false;
                                    continue;
                                }
                                if (ch === '\\') {
                                    escaped = true;
                                } else if (ch === '"') {
                                    inString = false;
                                }
                                continue;
                            }
                            if (ch === '"') {
                                inString = true;
                            } else if (ch === '{') {
                                depth++;
                            } else if (ch === '}') {
                                depth--;
                                if (depth === 0) {
                                    return source.slice(nameIdx, end);
                                }
                            }
                        }
                        return '';
                    }
                    return '';
                }

                if (!Object.keys(presetSource).length && dslText) {
                    const extractedSources = {};
                    for (const name of Object.keys(PRESETS)) {
                        extractedSources[name] = extractPresetSource(dslText, name);
                    }
                    presetSource = extractedSources;
                }
            } catch (error) {
                console.error('Failed to load noisemaker:', error);
                codeArea.textContent = 'Error loading Noisemaker module\n' + error.message + '\n\nMake sure to run "npm run build" before building docs.';
                return;
            }
        }

        // Validate that presets were loaded
        if (!PRESETS || Object.keys(PRESETS).length === 0) {
            codeArea.textContent = 'Error: No presets found in bundle.\n\nPRESSTS object is: ' + JSON.stringify(PRESETS, null, 2);
            select.innerHTML = '<option>No presets available</option>';
            return;
        }

        // Clear placeholder and populate preset dropdown
        select.innerHTML = '';
        const presetNames = Object.keys(PRESETS).sort();
        
        if (presetNames.length === 0) {
            codeArea.textContent = 'Error: PRESETS object is empty';
            select.innerHTML = '<option>No presets available</option>';
            return;
        }
        
        presetNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });

        // Set initial preset (use first one or 'cool-water' if available)
        const initialPreset = presetNames.includes('cool-water') ? 'cool-water' : presetNames[0];
        
        if (!initialPreset) {
            codeArea.textContent = 'Error: Could not determine initial preset';
            return;
        }
        
        select.value = initialPreset;

        async function renderPreset(presetName, seed = 42) {
            if (!presetName) {
                codeArea.textContent = `Error: No preset name provided`;
                return;
            }
            
            if (!PRESETS[presetName]) {
                codeArea.textContent = `Preset "${presetName}" not found\n\nAvailable presets: ${Object.keys(PRESETS).join(', ')}`;
                return;
            }

            // Show loading - exactly like demo/js
            if (loadingIndicator) {
                loadingIndicator.textContent = 'Rendering...';
                loadingIndicator.style.display = 'block';
            }
            canvas.style.opacity = '0.5';

            // Update progress callback - exactly like demo/js
            function updateRenderProgress(percent) {
                const percentInt = Math.floor(Math.min(100, Math.max(0, percent)));
                if (loadingIndicator) {
                    loadingIndicator.textContent = `Rendering (${percentInt}%)`;
                }
            }

            try {
                // Set seed
                if (rng && rng.setSeed) {
                    rng.setSeed(seed);
                }

                // Create preset exactly like demo/js does
                const presetTable = PRESETS;
                const preset = new Preset(presetName, presetTable, {}, seed, { debug: false });
                
                // If it's an effect-only preset, render on top of basic
                let renderPreset = preset;
                let renderPresets = presetTable;
                if (!preset.is_generator() && preset.is_effect()) {
                    renderPresets = PRESETS;
                    const basePreset = new Preset('basic', renderPresets, {}, seed, { debug: false });
                    basePreset.name = `${presetName}-on-basic`;
                    const combinedFinal = Array.isArray(basePreset.final_effects)
                        ? basePreset.final_effects.slice()
                        : [];
                    combinedFinal.push(preset);
                    basePreset.final_effects = combinedFinal;
                    renderPreset = basePreset;
                }
                
                // Render exactly like demo/js does
                updateRenderProgress(30);
                const ctx = new Context(canvas);
                await render(renderPreset, seed, {
                    width: canvas.width,
                    height: canvas.height,
                    ctx: ctx,
                    presets: renderPresets,
                    debug: false,
                    time: 1.0,
                    frameIndex: 0,
                    progressCallback: updateRenderProgress,
                });
                updateRenderProgress(100);

                // Show original source
                let sourceText = presetSource[presetName] || '// Source not available';
                
                // Trim 2 leading spaces from all lines except the first
                const lines = sourceText.split('\n');
                if (lines.length > 1) {
                    sourceText = lines[0] + '\n' + lines.slice(1).map(line => 
                        line.startsWith('  ') ? line.slice(2) : line
                    ).join('\n');
                }
                
                codeArea.textContent = sourceText;

                canvas.style.opacity = '1';
            } catch (error) {
                console.error('Render error:', error);
                codeArea.textContent = `Error rendering preset:\n${error.message}`;
            } finally {
                if (loadingIndicator) {
                    loadingIndicator.style.display = 'none';
                }
            }
        }

        // Handle preset selection
        select.addEventListener('change', () => {
            renderPreset(select.value);
        });

        // Handle random button - exactly like javascript.rst
        if (randomButton) {
            randomButton.addEventListener('click', () => {
                const newSeed = Math.floor(Math.random() * 1000000);
                renderPreset(select.value, newSeed);
            });
        }

        // Initial render
        await renderPreset(initialPreset);
    }

    // Initialize all preset viewers on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

    function initAll() {
        const viewers = document.querySelectorAll('.preset-viewer-container');
        viewers.forEach(viewer => {
            initPresetViewer(viewer);
        });
    }

})();
