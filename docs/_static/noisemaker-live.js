/**
 * Noisemaker Live Examples Runtime
 * 
 * Automatically renders all noisemaker-live-canvas elements on the page
 * using the bundled Noisemaker.js library.
 */

(function() {
    'use strict';
    
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
    let bundleReadyPromise = null;

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

    async function ensureNoisemakerReady() {
        if (bundleReadyPromise) {
            return bundleReadyPromise;
        }

        bundleReadyPromise = (async () => {
            let lastError = null;
            const existingModule = window.Noisemaker;
            if (existingModule) {
                try {
                    return await resolveNoisemakerFromWindow();
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
                    return module;
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
                        // Ignore cleanup issues; continue trying others
                    }
                }
            }

            let attempts = 0;
            while (!window.Noisemaker && attempts < BUNDLE_MAX_ATTEMPTS) {
                await delay(BUNDLE_WAIT_DELAY_MS);
                attempts++;
            }

            if (!window.Noisemaker) {
                throw lastError || new Error('Noisemaker bundle not loaded');
            }

            try {
                return await resolveNoisemakerFromWindow();
            } catch (error) {
                throw (error instanceof Error ? error : new Error(String(error)));
            }
        })();

        bundleReadyPromise.catch(() => {
            bundleReadyPromise = null;
        });

        return bundleReadyPromise;
    }
    
    const ENUM_PARAM_MAP = {
        distMetric: 'DistanceMetric',
        sobel_metric: 'DistanceMetric',
        sobelMetric: 'DistanceMetric',
        diagramType: 'VoronoiDiagramType',
        colorSpace: 'ColorSpace',
        color_space: 'ColorSpace',
        behavior: 'WormBehavior',
        pointDistrib: 'PointDistribution',
        mask: 'ValueMask',
        spline_order: 'InterpolationType',
        splineOrder: 'InterpolationType'
    };

    const TRUTHY_STRINGS = new Set(['true', '1', 'yes', 'on']);
    const FALSY_STRINGS = new Set(['false', '0', 'no', 'off']);

    function parseBoolean(rawValue, fallback = false) {
        if (typeof rawValue === 'boolean') {
            return rawValue;
        }

        if (rawValue === null || rawValue === undefined) {
            return fallback;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        if (TRUTHY_STRINGS.has(normalized)) {
            return true;
        }
        if (FALSY_STRINGS.has(normalized)) {
            return false;
        }
        return fallback;
    }

    const INTEGER_PARAM_EXACT = new Set([
        'brightness_freq',
        'color_space',
        'colorspace',
        'distrib',
        'freq',
        'octaves',
        'seed',
        'spline_order',
        'splineorder'
    ]);

    const INTEGER_PARAM_SUFFIXES = [
        '_count',
        'count',
        '_freq',
        'freq',
        '_index',
        'index',
        '_iterations',
        'iterations',
        '_levels',
        'levels',
        '_octaves',
        'octaves',
        '_order',
        'order',
        '_passes',
        'passes',
        '_points',
        'points',
        '_segments',
        'segments',
        '_sides',
        'sides',
        '_seed',
        'seed',
        '_steps',
        'steps'
    ];

    function isLikelyIntegerParam(paramName) {
        if (!paramName) {
            return false;
        }
        const lower = paramName.toLowerCase();
        if (INTEGER_PARAM_EXACT.has(lower)) {
            return true;
        }
        if (lower.includes('freq') || lower.includes('seed') || lower.includes('octave')) {
            return true;
        }
        return INTEGER_PARAM_SUFFIXES.some(suffix => lower.endsWith(suffix));
    }

    function inferNumericType(paramName, defaultValue, explicitHint) {
        if (explicitHint) {
            return explicitHint;
        }

        if (typeof defaultValue === 'number') {
            if (!Number.isFinite(defaultValue)) {
                return null;
            }
            if (!Number.isInteger(defaultValue)) {
                return 'float';
            }
            return isLikelyIntegerParam(paramName) ? 'int' : 'float';
        }

        if (defaultValue === null || defaultValue === undefined) {
            if (isLikelyIntegerParam(paramName)) {
                return 'int';
            }
            const lower = typeof paramName === 'string' ? paramName.toLowerCase() : '';
            if (lower.includes('rotation') || lower.includes('range') || lower.includes('saturation') || lower.includes('drift') || lower.includes('sin')) {
                return 'float';
            }
        }

        return null;
    }

    function getEnumForParam(paramName, effectName, defaultValue) {
        if (!window.Noisemaker) {
            return null;
        }

        if (paramName === 'distrib' || paramName === 'hue_distrib' || paramName === 'brightness_distrib' || paramName === 'saturation_distrib') {
            if (typeof defaultValue === 'number' && defaultValue >= 1000000) {
                return 'PointDistribution';
            }
            return 'ValueDistribution';
        }

        if (paramName === 'name' && effectName === 'palette') {
            return 'PALETTES';
        }

        return ENUM_PARAM_MAP[paramName] ?? null;
    }

    function buildEnumOptions(enumSource) {
        const nm = window.Noisemaker;
        if (enumSource === 'PALETTES') {
            const palettes = nm?.PALETTES ?? {};
            return Object.keys(palettes)
                .sort((a, b) => a.localeCompare(b))
                .map(name => ({ value: name, label: humanizeLabel(name) }));
        }

        const enumObject = nm?.[enumSource] ?? nm?.enums?.[enumSource];
        if (!enumObject) {
            return [];
        }

        return Object.entries(enumObject)
            .sort((a, b) => {
                const [, valueA] = a;
                const [, valueB] = b;
                if (typeof valueA === 'number' && typeof valueB === 'number') {
                    return valueA - valueB;
                }
                return String(valueA).localeCompare(String(valueB));
            })
            .map(([key, value]) => ({
                value: String(value),
                label: humanizeLabel(key)
            }));
    }

    function humanizeLabel(value) {
        return String(value)
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function resolveValue(rawValue, defaultValue) {
        if (rawValue === undefined) {
            return defaultValue;
        }

        if (typeof defaultValue === 'boolean') {
            return parseBoolean(rawValue, defaultValue);
        }

        if (typeof defaultValue === 'number') {
            const parsed = Number(rawValue);
            return Number.isFinite(parsed) ? parsed : defaultValue;
        }

        if (defaultValue === null || defaultValue === undefined) {
            if (rawValue === null || rawValue === undefined) {
                return rawValue;
            }
            const normalized = String(rawValue).trim();
            if (normalized.length === 0) {
                return defaultValue;
            }
            if (TRUTHY_STRINGS.has(normalized.toLowerCase())) {
                return true;
            }
            if (FALSY_STRINGS.has(normalized.toLowerCase())) {
                return false;
            }
            const parsed = Number(normalized);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
            return rawValue;
        }

        return rawValue;
    }

    function coerceParamValue(rawValue, defaultValue, enumSource, paramName = '', typeHint) {
        if (rawValue === undefined) {
            return undefined;
        }

        const normalizedValue = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
        if (typeof normalizedValue === 'string' && normalizedValue.length === 0) {
            return undefined;
        }

        if (enumSource === 'PALETTES') {
            return normalizedValue;
        }

        if (enumSource) {
            const parsedEnumValue = Number(normalizedValue);
            if (Number.isNaN(parsedEnumValue)) {
                return undefined;
            }
            return Math.round(parsedEnumValue);
        }

        const resolvedTypeHint = (() => {
            if (typeHint) {
                return typeHint;
            }
            if (typeof defaultValue === 'boolean') {
                return 'bool';
            }
            if (typeof defaultValue === 'string') {
                return 'string';
            }
            const inferred = inferNumericType(paramName, defaultValue, null);
            if (inferred) {
                return inferred;
            }
            return null;
        })();

        if (resolvedTypeHint === 'bool') {
            return parseBoolean(normalizedValue, Boolean(defaultValue));
        }

        if (resolvedTypeHint === 'int' || resolvedTypeHint === 'float') {
            const parsedNumber = Number(normalizedValue);
            if (Number.isNaN(parsedNumber)) {
                return undefined;
            }
            return resolvedTypeHint === 'int' ? Math.round(parsedNumber) : parsedNumber;
        }

        if (resolvedTypeHint === 'string') {
            return normalizedValue;
        }

        if (defaultValue === null || defaultValue === undefined) {
            if (typeof normalizedValue === 'string') {
                const lower = normalizedValue.toLowerCase();
                if (TRUTHY_STRINGS.has(lower)) {
                    return true;
                }
                if (FALSY_STRINGS.has(lower)) {
                    return false;
                }
            }
            const parsedFallback = Number(normalizedValue);
            if (!Number.isNaN(parsedFallback)) {
                return parsedFallback;
            }
        }

        return normalizedValue;
    }

    const GENERATOR_PARAM_TYPE_HINTS = {
        brightness_freq: 'int',
        color_space: 'int',
        distrib: 'int',
        freq: 'int',
        hue_range: 'float',
        hue_rotation: 'float',
        lattice_drift: 'float',
        saturation: 'float',
        sin: 'float',
        spline_order: 'int',
        octaves: 'int'
    };

    // Wait for both DOM and Noisemaker to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLiveExamples);
    } else {
        initLiveExamples();
    }
    
    async function initLiveExamples() {
        let noisemakerModule;
        try {
            noisemakerModule = await ensureNoisemakerReady();
        } catch (error) {
            console.error('Noisemaker live examples: failed to load bundle', error);
            return;
        }
        const nm = noisemakerModule;
        
        // Find all canvas elements
        const canvases = document.querySelectorAll('.noisemaker-live-canvas');
        
        console.log(`Found ${canvases.length} Noisemaker live example(s)`);
        
        // Set up lazy loading with IntersectionObserver
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !entry.target.dataset.rendered) {
                    entry.target.dataset.rendered = 'true';
                    renderCanvas(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: '200px',
            threshold: 0.5
        });
        
        // Render each canvas (lazy or immediate based on data attribute)
        for (const canvas of canvases) {
            const isLazy = canvas.dataset.lazy === 'true';
            
            if (isLazy) {
                // Use IntersectionObserver for lazy loading
                observer.observe(canvas);
            } else {
                // Render immediately
                await renderCanvas(canvas);
            }
            
            // Attach random button handler
            const wrapper = canvas.closest('.noisemaker-live-canvas-wrapper');
            const example = canvas.closest('.noisemaker-live-example');
            const randomBtn = wrapper?.querySelector('.noisemaker-live-random');
            const controlsContainer = example?.querySelector('.noisemaker-live-controls');
            
            if (randomBtn) {
                randomBtn.addEventListener('click', () => {
                    // Generate new random seed
                    const newSeed = Math.floor(Math.random() * 100000);
                    canvas.dataset.seed = newSeed;
                    renderCanvas(canvas);
                });
            }
            
            // Generate parameter controls for effects or generators
            const effectName = canvas.dataset.effect;
            const generatorName = canvas.dataset.generator;
            
            if (effectName && controlsContainer && nm?.EFFECTS) {
                const effectNameSnake = effectName.replace(/-/g, '_');
                const effect = nm.EFFECTS[effectName] || nm.EFFECTS[effectNameSnake];
                
                if (effect) {
                    // Clear existing controls (except structure)
                    controlsContainer.innerHTML = '';

                    const effectMetadata = nm?.EFFECT_METADATA ?? {};
                    const effectDefaults = effectMetadata[effectName] || effectMetadata[effectNameSnake] || effect;

                    // Get parameter names (everything except 'func')
                    const paramNames = Object.keys(effect).filter(k => k !== 'func');
                    
                    if (paramNames.length > 0) {
                        paramNames.forEach(paramName => {
                            const defaultValue = effectDefaults[paramName] ?? effect[paramName];
                            const { dataset } = canvas;
                            const rawDatasetValue = dataset[paramName];

                            const control = document.createElement('div');
                            control.className = 'noisemaker-live-control';

                            const label = document.createElement('label');
                            label.textContent = humanizeLabel(paramName);
                            control.appendChild(label);

                            const enumSource = getEnumForParam(paramName, effectName, defaultValue);
                            let resolvedValue = resolveValue(rawDatasetValue, defaultValue);
                            let input;

                            if (enumSource) {
                                input = document.createElement('select');
                                input.className = `control-${paramName}`;

                                const options = buildEnumOptions(enumSource);
                                const includeNullChoice = defaultValue === null || defaultValue === undefined;
                                const availableValues = [];

                                if (includeNullChoice) {
                                    const noneOption = document.createElement('option');
                                    noneOption.value = '';
                                    noneOption.textContent = 'None';
                                    input.appendChild(noneOption);
                                    availableValues.push('');
                                }

                                options.forEach(({ value, label: optionLabel }) => {
                                    const option = document.createElement('option');
                                    option.value = value;
                                    option.textContent = optionLabel;
                                    input.appendChild(option);
                                    availableValues.push(String(value));
                                });

                                const hasDatasetValue = rawDatasetValue !== undefined;
                                let initialValue;

                                if (hasDatasetValue) {
                                    initialValue = String(rawDatasetValue);
                                } else if (includeNullChoice) {
                                    initialValue = '';
                                } else if (defaultValue !== null && defaultValue !== undefined) {
                                    initialValue = String(defaultValue);
                                    dataset[paramName] = initialValue;
                                } else {
                                    initialValue = availableValues[0] ?? '';
                                    if (initialValue) {
                                        dataset[paramName] = initialValue;
                                    }
                                }

                                if (!availableValues.includes(initialValue)) {
                                    initialValue = availableValues[0] ?? '';
                                    if (initialValue) {
                                        dataset[paramName] = initialValue;
                                    } else {
                                        delete dataset[paramName];
                                    }
                                }

                                if (initialValue === '') {
                                    delete dataset[paramName];
                                }

                                input.value = initialValue;

                                input.addEventListener('change', (e) => {
                                    const { value: newValue } = e.target;
                                    if (newValue === '') {
                                        delete dataset[paramName];
                                    } else {
                                        dataset[paramName] = newValue;
                                    }
                                    renderCanvas(canvas);
                                });

                                control.appendChild(input);
                            } else if (typeof defaultValue === 'boolean') {
                                // Checkbox for boolean
                                input = document.createElement('input');
                                input.type = 'checkbox';
                                input.className = `control-${paramName}`;
                                input.checked = resolvedValue;
                                
                                input.addEventListener('change', (e) => {
                                    dataset[paramName] = String(e.target.checked);
                                    renderCanvas(canvas);
                                });
                                
                                control.appendChild(input);
                            } else if (typeof defaultValue === 'string') {
                                // Text input for string
                                input = document.createElement('input');
                                input.type = 'text';
                                input.className = `control-${paramName}`;
                                input.value = resolvedValue ?? '';
                                input.style.width = '120px';
                                
                                input.addEventListener('change', (e) => {
                                    dataset[paramName] = e.target.value;
                                    renderCanvas(canvas);
                                });
                                
                                control.appendChild(input);
                            } else if (typeof defaultValue === 'number') {
                                const resolvedTypeHint = inferNumericType(paramName, defaultValue, null) ?? 'float';
                                const isInteger = resolvedTypeHint === 'int';

                                input = document.createElement('input');
                                input.type = 'range';
                                input.className = `control-${paramName}`;

                                let min, max, step;

                                if (paramName === 'alpha') {
                                    min = 0; max = 1; step = 0.01;
                                } else if (paramName.includes('freq') || paramName.includes('Freq')) {
                                    min = 1; max = 20; step = 1;
                                } else if (paramName === 'octaves') {
                                    min = 1; max = 8; step = 1;
                                } else if (paramName === 'iterations') {
                                    min = 1; max = 200; step = 1;
                                } else if (paramName === 'displacement') {
                                    if (defaultValue >= 10) { min = 0; max = 100; step = 1; }
                                    else { min = -2; max = 2; step = 0.01; }
                                } else if (paramName === 'amount') {
                                    min = 0; max = 2; step = 0.01;
                                } else if (paramName === 'angle') {
                                    min = 0; max = 360; step = 1;
                                } else if (paramName === 'sides' || paramName === 'sdfSides') {
                                    min = 3; max = 12; step = 1;
                                } else if (paramName === 'levels') {
                                    min = 2; max = 32; step = 1;
                                } else if (paramName === 'kink') {
                                    min = 0; max = 5; step = 0.1;
                                } else if (paramName === 'splineOrder') {
                                    min = 0; max = 5; step = 1;
                                } else if (paramName === 'zoom') {
                                    min = 0.1; max = 5; step = 0.1;
                                } else if (paramName === 'saturation' || paramName === 'hueRange' || paramName === 'hueRotation') {
                                    min = 0; max = 2; step = 0.01;
                                } else if (paramName === 'a' || paramName === 'b') {
                                    min = 0; max = 1; step = 0.01;
                                } else if (defaultValue > 100) {
                                    min = 0;
                                    max = Math.max(10000, defaultValue * 2);
                                    step = isInteger ? Math.max(1, Math.floor(defaultValue / 100)) : Math.max(0.1, defaultValue / 100);
                                } else if (defaultValue >= 0 && defaultValue <= 1) {
                                    min = 0; max = 1; step = isInteger ? 1 : 0.01;
                                } else if (defaultValue >= 1 && defaultValue <= 10 && isInteger) {
                                    min = 1; max = 20; step = 1;
                                } else if (defaultValue > 10) {
                                    min = 0;
                                    max = Math.ceil(defaultValue * 3);
                                    step = isInteger ? Math.max(1, Math.floor(defaultValue / 10)) : Math.max(0.1, defaultValue / 10);
                                } else {
                                    min = Math.floor(defaultValue - Math.abs(defaultValue) * 2 - 1);
                                    max = Math.ceil(defaultValue + Math.abs(defaultValue) * 2 + 1);
                                    step = isInteger ? 1 : 0.01;
                                }

                                input.min = String(min);
                                input.max = String(max);
                                input.step = String(step);

                                const minValue = Number(min);
                                const maxValue = Number(max);
                                const stepValue = Number(step);
                                let currentValue = typeof resolvedValue === 'number' ? resolvedValue : defaultValue;
                                currentValue = Math.min(maxValue, Math.max(minValue, currentValue));
                                if (isInteger) {
                                    currentValue = Math.round(currentValue);
                                }
                                input.value = String(currentValue);

                                const valueDisplay = document.createElement('span');
                                valueDisplay.className = 'control-value';
                                const decimals = resolvedTypeHint === 'int' ? 0 : (stepValue >= 1 ? 0 : (stepValue >= 0.1 ? 1 : 2));
                                valueDisplay.textContent = Number(currentValue).toFixed(decimals);

                                input.addEventListener('input', (e) => {
                                    const newValue = parseFloat(e.target.value);
                                    const displayValue = isInteger ? Math.round(newValue) : newValue;
                                    valueDisplay.textContent = Number(displayValue).toFixed(decimals);
                                });

                                input.addEventListener('change', (e) => {
                                    const rawValue = parseFloat(e.target.value);
                                    const newValue = isInteger ? Math.round(rawValue) : rawValue;
                                    input.value = String(newValue);
                                    dataset[paramName] = String(newValue);
                                    valueDisplay.textContent = Number(newValue).toFixed(decimals);
                                    renderCanvas(canvas);
                                });
                                
                                control.appendChild(input);
                                control.appendChild(valueDisplay);
                            } else {
                                // Null or object - show type and value
                                const valueSpan = document.createElement('span');
                                valueSpan.className = 'control-value';
                                valueSpan.textContent = defaultValue === null ? 'null' : `[${typeof defaultValue}]`;
                                control.appendChild(valueSpan);
                            }
                            
                            controlsContainer.appendChild(control);
                        });
                        
                        if (controlsContainer.children.length === 0) {
                            controlsContainer.innerHTML = '<p class="no-params-message">No adjustable parameters</p>';
                        }
                    } else {
                        controlsContainer.innerHTML = '<p class="no-params-message">No adjustable parameters</p>';
                    }
                }
            } else if (generatorName && controlsContainer && nm) {
                // Generator controls
                const generator = nm[generatorName];
                
                if (generator) {
                    const GENERATOR_PARAMS = {
                        basic: {
                            ridges: false,
                            sin: 0.0,
                            spline_order: 3,
                            distrib: 1,
                            corners: false,
                            mask: null,
                            mask_inverse: false,
                            mask_static: false,
                            lattice_drift: 0.0,
                            color_space: 21,
                            hue_range: 0.125,
                            hue_rotation: null,
                            saturation: 1.0,
                            hue_distrib: null,
                            brightness_distrib: null,
                            brightness_freq: null,
                            saturation_distrib: null
                        },
                        multires: {
                            freq: 3,
                            octaves: 1,
                            ridges: false,
                            sin: 0.0,
                            spline_order: 3,
                            distrib: 1,
                            corners: false,
                            mask: null,
                            mask_inverse: false,
                            mask_static: false,
                            lattice_drift: 0.0,
                            color_space: 21,
                            hue_range: 0.125,
                            hue_rotation: null,
                            saturation: 1.0,
                            hue_distrib: null,
                            saturation_distrib: null,
                            brightness_distrib: null,
                            brightness_freq: null
                        }
                    };

                    const params = GENERATOR_PARAMS[generatorName];
                    if (params) {
                        controlsContainer.innerHTML = '';
                        const FORCE_NUMERIC_PARAMS = new Set(['hue_rotation', 'brightness_freq']);
                        
                        Object.keys(params).forEach(paramName => {
                            const defaultValue = params[paramName];
                            const { dataset } = canvas;
                            const rawDatasetValue = dataset[paramName];
                            const normalizedParamName = paramName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                            const lowerParamName = normalizedParamName.toLowerCase();
                            const shouldForceNumeric = FORCE_NUMERIC_PARAMS.has(paramName);
                            const typeHint = GENERATOR_PARAM_TYPE_HINTS[paramName] ?? (shouldForceNumeric ? (paramName === 'brightness_freq' ? 'int' : 'float') : undefined);

                            const control = document.createElement('div');
                            control.className = 'noisemaker-live-control';

                            const label = document.createElement('label');
                            label.textContent = humanizeLabel(paramName);
                            control.appendChild(label);

                            const enumSource = getEnumForParam(paramName, generatorName, defaultValue);
                            let resolvedValue = resolveValue(rawDatasetValue, defaultValue);
                            let input;

                            if (enumSource) {
                                input = document.createElement('select');
                                input.className = `control-${paramName}`;

                                const options = buildEnumOptions(enumSource);
                                const includeNullChoice = defaultValue === null || defaultValue === undefined;
                                const availableValues = [];

                                if (includeNullChoice) {
                                    const noneOption = document.createElement('option');
                                    noneOption.value = '';
                                    noneOption.textContent = 'None';
                                    input.appendChild(noneOption);
                                    availableValues.push('');
                                }

                                options.forEach(({ value, label: optionLabel }) => {
                                    const option = document.createElement('option');
                                    option.value = value;
                                    option.textContent = optionLabel;
                                    input.appendChild(option);
                                    availableValues.push(String(value));
                                });

                                const hasDatasetValue = rawDatasetValue !== undefined;
                                let initialValue;

                                if (hasDatasetValue) {
                                    initialValue = String(rawDatasetValue);
                                } else if (includeNullChoice) {
                                    initialValue = '';
                                } else if (defaultValue !== null && defaultValue !== undefined) {
                                    initialValue = String(defaultValue);
                                    dataset[paramName] = initialValue;
                                } else {
                                    initialValue = availableValues[0] ?? '';
                                    if (initialValue) {
                                        dataset[paramName] = initialValue;
                                    }
                                }

                                if (!availableValues.includes(initialValue)) {
                                    initialValue = availableValues[0] ?? '';
                                    if (initialValue) {
                                        dataset[paramName] = initialValue;
                                    } else {
                                        delete dataset[paramName];
                                    }
                                }

                                if (initialValue === '') {
                                    delete dataset[paramName];
                                }

                                input.value = initialValue;

                                input.addEventListener('change', (e) => {
                                    const { value: newValue } = e.target;
                                    if (newValue === '') {
                                        delete dataset[paramName];
                                    } else {
                                        dataset[paramName] = newValue;
                                    }
                                    renderCanvas(canvas);
                                });

                                control.appendChild(input);
                            } else if (typeof defaultValue === 'boolean') {
                                input = document.createElement('input');
                                input.type = 'checkbox';
                                input.className = `control-${paramName}`;
                                input.checked = resolvedValue;
                                
                                input.addEventListener('change', (e) => {
                                    dataset[paramName] = String(e.target.checked);
                                    renderCanvas(canvas);
                                });
                                
                                control.appendChild(input);
                            } else if (typeof defaultValue === 'number' || shouldForceNumeric) {
                                const numericDefault = typeof defaultValue === 'number' ? defaultValue : 0;
                                const resolvedTypeHint = inferNumericType(paramName, defaultValue, typeHint) ?? 'float';
                                const isInteger = resolvedTypeHint === 'int';
                                
                                input = document.createElement('input');
                                input.type = 'range';
                                input.className = `control-${paramName}`;
                                
                                let min, max, step;
                                
                                if (lowerParamName === 'sin' || lowerParamName === 'latticedrift') {
                                    min = 0; max = 1; step = 0.01;
                                } else if (lowerParamName === 'huerange' || lowerParamName === 'saturation') {
                                    min = 0; max = 2; step = 0.01;
                                } else if (lowerParamName === 'huerotation') {
                                    min = 0; max = 2; step = 0.01;
                                } else if (lowerParamName === 'brightnessfreq') {
                                    min = 1; max = 64; step = 1;
                                } else if (paramName === 'freq') {
                                    min = 1; max = 20; step = 1;
                                } else if (paramName === 'octaves') {
                                    min = 1; max = 8; step = 1;
                                } else if (numericDefault >= 0 && numericDefault <= 1) {
                                    min = 0; max = 1; step = isInteger ? 1 : 0.01;
                                } else if (numericDefault >= 1 && numericDefault <= 10 && isInteger) {
                                    min = 1; max = 20; step = 1;
                                } else {
                                    const safeDefault = Math.max(1, Math.abs(numericDefault));
                                    min = 0; 
                                    max = Math.ceil(safeDefault * 3); 
                                    step = isInteger ? Math.max(1, Math.floor(safeDefault / 10)) : 0.01;
                                }
                                
                                input.min = String(min);
                                input.max = String(max);
                                input.step = String(step);

                                const minValue = Number(min);
                                const maxValue = Number(max);
                                const stepValue = Number(step);
                                const parsedDatasetValue = rawDatasetValue !== undefined ? Number(rawDatasetValue) : undefined;
                                let currentValue = Number.isFinite(parsedDatasetValue) ? parsedDatasetValue : numericDefault;
                                if (!Number.isFinite(currentValue)) {
                                    currentValue = resolvedTypeHint === 'int' ? Math.round(minValue) : minValue;
                                }
                                currentValue = Math.min(maxValue, Math.max(minValue, currentValue));
                                if (resolvedTypeHint === 'int') {
                                    currentValue = Math.round(currentValue);
                                }
                                input.value = String(currentValue);

                                const valueDisplay = document.createElement('span');
                                valueDisplay.className = 'control-value';
                                const decimals = resolvedTypeHint === 'int' ? 0 : (stepValue >= 1 ? 0 : (stepValue >= 0.1 ? 1 : 2));
                                valueDisplay.textContent = Number(currentValue).toFixed(decimals);

                                input.addEventListener('input', (e) => {
                                    const newValue = parseFloat(e.target.value);
                                    const displayValue = resolvedTypeHint === 'int' ? Math.round(newValue) : newValue;
                                    valueDisplay.textContent = Number(displayValue).toFixed(decimals);
                                });

                                input.addEventListener('change', (e) => {
                                    const rawValue = parseFloat(e.target.value);
                                    const newValue = resolvedTypeHint === 'int' ? Math.round(rawValue) : rawValue;
                                    input.value = String(newValue);
                                    dataset[paramName] = String(newValue);
                                    valueDisplay.textContent = Number(newValue).toFixed(decimals);
                                    renderCanvas(canvas);
                                });
                                
                                control.appendChild(input);
                                control.appendChild(valueDisplay);
                            }
                            
                            controlsContainer.appendChild(control);
                        });
                    }
                }
            }
        }
    }
    
    async function renderCanvas(canvas) {
        const wrapper = canvas.closest('.noisemaker-live-canvas-wrapper');
        const loadingDiv = wrapper?.querySelector('.noisemaker-live-loading');
        const errorDiv = wrapper?.querySelector('.noisemaker-live-error');
        
        try {
            // Get parameters from data attributes
            const presetName = canvas.dataset.preset;
            const effectName = canvas.dataset.effect;
            const generatorName = canvas.dataset.generator;
            const showPercent = !generatorName && !effectName;
            const inputName = canvas.dataset.input || 'basic';
            const seed = parseInt(canvas.dataset.seed, 10) || 42;
            const width = parseInt(canvas.dataset.width, 10) || 512;
            const height = parseInt(canvas.dataset.height, 10) || 512;
            const time = parseFloat(canvas.dataset.time) || 1.0;
            const frame = parseFloat(canvas.dataset.frame) || 0.0;
            
            if (!presetName && !effectName && !generatorName) {
                throw new Error('No preset, effect, or generator specified');
            }
            
            async function resolveTensorCandidate(candidate) {
                if (candidate && typeof candidate.then === 'function') {
                    return await candidate;
                }
                if (candidate && typeof candidate === 'object') {
                    const asyncIterator = candidate[Symbol.asyncIterator];
                    if (typeof asyncIterator === 'function') {
                        let lastValue = null;
                        for await (const value of candidate) {
                            if (value !== undefined) {
                                lastValue = value;
                            }
                        }
                        return lastValue;
                    }
                    const iterator = candidate[Symbol.iterator];
                    if (typeof iterator === 'function') {
                        let lastValue = null;
                        for (const value of candidate) {
                            if (value !== undefined) {
                                lastValue = value;
                            }
                        }
                        return lastValue;
                    }
                }
                return candidate;
            }

            // Update progress callback - exactly like demo/js
            function updateRenderProgress(percent) {
                if (!loadingDiv) {
                    return;
                }
                if (showPercent && Number.isFinite(percent)) {
                    const percentInt = Math.floor(Math.min(100, Math.max(0, percent)));
                    loadingDiv.textContent = `Rendering (${percentInt}%)`;
                } else {
                    loadingDiv.textContent = 'Rendering...';
                }
            }
            
            // Show loading state - exactly like demo/js
            if (loadingDiv) {
                loadingDiv.textContent = 'Rendering...';
                loadingDiv.style.display = 'block';
            }
            canvas.style.opacity = '0.3';
            
            // Create preset and render
            // Note: The bundled API requires loading the preset table first
            const { Preset, PRESETS } = window.Noisemaker;
            
            const PRESET_TABLE = PRESETS();
            
            let tensor;
            const startTime = performance.now();
            
            // If rendering a generator directly
            if (generatorName) {
                const generator = window.Noisemaker[generatorName];
                if (!generator) {
                    throw new Error(`Generator "${generatorName}" not found`);
                }
                
                const { dataset } = canvas;
                const opts = {};
                
                // Collect custom parameters from dataset
                const GENERATOR_PARAMS = {
                    basic: ['ridges', 'sin', 'spline_order', 'distrib', 'corners', 'mask', 'mask_inverse', 'mask_static', 'lattice_drift', 'color_space', 'hue_range', 'hue_rotation', 'saturation', 'hue_distrib', 'brightness_distrib', 'brightness_freq', 'saturation_distrib'],
                    multires: ['freq', 'octaves', 'ridges', 'sin', 'spline_order', 'distrib', 'corners', 'mask', 'mask_inverse', 'mask_static', 'lattice_drift', 'color_space', 'hue_range', 'hue_rotation', 'saturation', 'hue_distrib', 'saturation_distrib', 'brightness_distrib', 'brightness_freq']
                };
                
                const paramNames = GENERATOR_PARAMS[generatorName] || [];
                paramNames.forEach(paramName => {
                    if (dataset[paramName] === undefined) {
                        return;
                    }
                    
                    const defaultValue = paramName === 'ridges' ? false :
                                       paramName === 'corners' ? false :
                                       paramName === 'mask_inverse' ? false :
                                       paramName === 'mask_static' ? false :
                                       paramName === 'freq' ? 3 :
                                       paramName === 'octaves' ? 1 :
                                       paramName === 'sin' ? 0.0 :
                                       paramName === 'lattice_drift' ? 0.0 :
                                       paramName === 'hue_range' ? 0.125 :
                                       paramName === 'saturation' ? 1.0 :
                                       paramName === 'distrib' ? 1 :
                                       paramName === 'spline_order' ? 3 :
                                       paramName === 'color_space' ? 21 :
                                       paramName === 'mask' ? null :
                                       paramName === 'hue_rotation' ? null :
                                       paramName === 'hue_distrib' ? null :
                                       paramName === 'brightness_distrib' ? null :
                                       paramName === 'brightness_freq' ? null :
                                       paramName === 'saturation_distrib' ? null : null;
                    const enumSource = getEnumForParam(paramName, generatorName, defaultValue);
                    const typeHint = GENERATOR_PARAM_TYPE_HINTS[paramName];
                    const coercedValue = coerceParamValue(dataset[paramName], defaultValue, enumSource, paramName, typeHint);
                    
                    if (coercedValue !== undefined && coercedValue !== null) {
                        if (enumSource && defaultValue === null && (coercedValue === '' || coercedValue === null)) {
                            return;
                        }
                        opts[paramName] = coercedValue;
                        const jsParamName = paramName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                        if (jsParamName !== paramName) {
                            opts[jsParamName] = coercedValue;
                        }
                    }
                });
                
                opts.time = time;
                opts.seed = seed;
                
                const shape = [height, width, 3];
                const freqValue = Number(opts.freq) || 3;
                const freq = [freqValue, freqValue];
                delete opts.freq;
                
                const candidate = generator(freq, shape, opts);
                tensor = await resolveTensorCandidate(candidate);
                if (!tensor) {
                    throw new Error(`Generator "${generatorName}" did not return a tensor`);
                }
            }
            // If rendering an effect, we need to render the input then apply the effect
            else if (effectName) {
                // Check if effect exists (EFFECTS is the registry from effectsRegistry.js)
                const { EFFECTS, Effect } = window.Noisemaker;
                
                // Try both dash and underscore versions (e.g., "adjust-hue" and "adjust_hue")
                const effectNameSnake = effectName.replace(/-/g, '_');
                if (!EFFECTS || (!EFFECTS[effectName] && !EFFECTS[effectNameSnake])) {
                    throw new Error(`Effect "${effectName}" is not available in the JavaScript implementation yet. This effect exists in Python but hasn't been ported.`);
                }
                
                // Step 1: Render the input preset to get a tensor
                if (!PRESET_TABLE[inputName]) {
                    throw new Error(`Input preset "${inputName}" not found. Available presets: ${Object.keys(PRESET_TABLE).slice(0, 5).join(', ')}...`);
                }
                
                const inputPreset = new Preset(inputName, PRESET_TABLE, {}, seed, { debug: false });
                updateRenderProgress(30);
                const inputTensor = await inputPreset.render(seed, {
                    width: width,
                    height: height,
                    time: time,
                    speed: 1.0,
                    progressCallback: updateRenderProgress,
                });
                updateRenderProgress(70);
                
                // Step 2: Collect custom parameters from canvas dataset
                const effect = EFFECTS[effectName] || EFFECTS[effectNameSnake];
                const customParams = {};

                // Get all parameter names from the effect (excluding 'func')
                const paramNames = Object.keys(effect).filter(k => k !== 'func');
                paramNames.forEach(paramName => {
                    const rawValue = canvas.dataset[paramName];
                    if (rawValue === undefined) {
                        return;
                    }

                    const defaultValue = effect[paramName];
                    const enumSource = getEnumForParam(paramName, effectName, defaultValue);
                    const coercedValue = coerceParamValue(rawValue, defaultValue, enumSource, paramName);

                    if (coercedValue !== undefined && coercedValue !== null && !(enumSource && rawValue === '')) {
                        customParams[paramName] = coercedValue;
                    }
                });
                
                // Step 3: Create an effect function with custom parameters
                const effectFunc = Effect(effectName, customParams);
                
                // Step 4: Apply the effect function to the tensor
                // Note: effects might be async, and shape needs channels
                const shape = inputTensor.shape; // Use the input tensor's shape which has [h, w, c]
                const result = effectFunc(inputTensor, shape, 0, 1);
                tensor = await resolveTensorCandidate(result);
                if (!tensor) {
                    tensor = inputTensor;
                }
            } else {
                // Just render a preset directly
                if (!PRESET_TABLE[presetName]) {
                    throw new Error(`Preset "${presetName}" not found. Available presets: ${Object.keys(PRESET_TABLE).slice(0, 5).join(', ')}...`);
                }
                
                const preset = new Preset(presetName, PRESET_TABLE, {}, seed, { debug: false });
                updateRenderProgress(30);
                tensor = await preset.render(seed, {
                    width: width,
                    height: height,
                    time: time,
                    speed: 1.0,
                    progressCallback: updateRenderProgress,
                });
                updateRenderProgress(100);
            }

            
            // Convert tensor to ImageData and draw on canvas
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(width, height);
            const dataMaybe = tensor.read();
            const data = dataMaybe && typeof dataMaybe.then === 'function'
                ? await dataMaybe
                : dataMaybe;
            const channels = tensor.shape?.[2] || 3;
            
            for (let i = 0; i < width * height; i++) {
                const base = i * channels;
                const red = data?.[base] ?? 0;
                const green = data?.[base + 1] ?? red;
                const blue = data?.[base + 2] ?? red;
                const r = Math.floor(red * 255);
                const g = Math.floor(green * 255);
                const b = Math.floor(blue * 255);
                
                imageData.data[i * 4 + 0] = r;
                imageData.data[i * 4 + 1] = g;
                imageData.data[i * 4 + 2] = b;
                imageData.data[i * 4 + 3] = 255;
            }
            
            ctx.putImageData(imageData, 0, 0);
            
            // Show canvas, hide loading
            if (loadingDiv) loadingDiv.style.display = 'none';
            
            // Add a subtle fade-in effect
            canvas.style.transition = 'opacity 0.3s ease-in';
            canvas.style.opacity = '1';
            
        } catch (error) {
            console.error(`Error rendering canvas:`, error);
            
            // Show error message
            if (errorDiv) {
                errorDiv.textContent = `Error: ${error.message}`;
                errorDiv.style.display = 'block';
            }
            if (loadingDiv) {
                loadingDiv.style.display = 'none';
            }
            
            // Draw error on canvas
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffe6e6';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#cc0000';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Render Error', canvas.width / 2, canvas.height / 2 - 10);
            ctx.font = '12px monospace';
            ctx.fillText(error.message, canvas.width / 2, canvas.height / 2 + 10);
            
            canvas.style.opacity = '1';
            if (loadingDiv) loadingDiv.style.display = 'none';
        }
    }
    
    // Expose render function for manual control if needed
    window.renderNoisemakerCanvas = renderCanvas;
    
})();
