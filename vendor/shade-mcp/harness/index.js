// src/harness/browser-session.ts
import { chromium } from "playwright";
import { resolve as resolve2 } from "path";

// src/harness/types.ts
var DEFAULT_GLOBALS = {
  canvasRenderer: "__shadeCanvasRenderer",
  renderingPipeline: "__shadeRenderingPipeline",
  currentBackend: "__shadeCurrentBackend",
  currentEffect: "__shadeCurrentEffect",
  setPaused: "__shadeSetPaused",
  setPausedTime: "__shadeSetPausedTime",
  frameCount: "__shadeFrameCount"
};
function globalsFromPrefix(prefix) {
  return {
    canvasRenderer: `${prefix}CanvasRenderer`,
    renderingPipeline: `${prefix}RenderingPipeline`,
    currentBackend: `${prefix}CurrentBackend`,
    currentEffect: `${prefix}CurrentEffect`,
    setPaused: `${prefix}SetPaused`,
    setPausedTime: `${prefix}SetPausedTime`,
    frameCount: `${prefix}FrameCount`
  };
}

// src/harness/server-manager.ts
import { createServer } from "http";
import { createReadStream, existsSync, realpathSync } from "fs";
import { extname, join, resolve as pathResolve, normalize, basename, relative, sep } from "path";
var httpServer = null;
var refCount = 0;
var activePort = 0;
var requestedPort = 0;
var MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".glsl": "text/plain",
  ".wgsl": "text/plain",
  ".frag": "text/plain",
  ".vert": "text/plain",
  ".comp": "text/plain"
};
function safePath(root, relPath) {
  const rootResolved = pathResolve(root);
  const resolved = pathResolve(rootResolved, normalize(relPath));
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) return null;
  const rel = relative(rootResolved, resolved);
  if (rel && rel.split(sep).some((segment) => segment.startsWith("."))) return null;
  try {
    const realRoot = realpathSync(rootResolved);
    const realTarget = realpathSync(resolved);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
  } catch {
  }
  return resolved;
}
function serveFile(filePath, res) {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    if (!res.headersSent) {
      const status = err.code === "ENOENT" ? 404 : 500;
      res.writeHead(status);
    }
    res.end();
  });
  stream.on("open", () => {
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store"
    });
    stream.pipe(res);
  });
}
async function acquireServer(port, viewerRoot, effectsDir) {
  if (refCount > 0) {
    if (port !== requestedPort) {
      throw new Error(`Server already running on port ${activePort} (requested ${requestedPort}), cannot switch to ${port}`);
    }
    refCount++;
    return getServerUrl();
  }
  requestedPort = port;
  const isFlatLayout = existsSync(join(effectsDir, "definition.json")) || existsSync(join(effectsDir, "definition.js"));
  const flatEffectName = isFlatLayout ? basename(effectsDir) : null;
  const route = (req, res) => {
    let url;
    try {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      url = decodeURIComponent(parsedUrl.pathname);
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    if (url.startsWith("/effects/")) {
      const relPath2 = url.slice("/effects/".length);
      if (flatEffectName && relPath2.startsWith(flatEffectName + "/")) {
        const innerPath = relPath2.slice(flatEffectName.length + 1);
        const filePath3 = safePath(effectsDir, innerPath);
        if (!filePath3) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        serveFile(filePath3, res);
        return;
      }
      const filePath2 = safePath(effectsDir, relPath2);
      if (!filePath2) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      serveFile(filePath2, res);
      return;
    }
    let relPath = url === "/" ? "index.html" : url.slice(1);
    if (relPath.endsWith("/")) {
      relPath += "index.html";
    }
    const filePath = safePath(viewerRoot, relPath);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    serveFile(filePath, res);
  };
  httpServer = createServer((req, res) => {
    try {
      route(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  httpServer.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  await new Promise((resolve4, reject) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      activePort = typeof addr === "object" && addr ? addr.port : port;
      resolve4();
    });
    httpServer.on("error", reject);
  });
  refCount = 1;
  return getServerUrl();
}
function releaseServer() {
  if (refCount <= 0) return;
  refCount--;
  if (refCount === 0 && httpServer) {
    httpServer.close();
    httpServer = null;
    activePort = 0;
    requestedPort = 0;
  }
}
function getServerUrl() {
  return `http://127.0.0.1:${activePort}`;
}
function getRefCount() {
  return refCount;
}

// src/harness/browser-queue.ts
var maxConcurrency = 1;
var waiting = [];
var active = 0;
function setMaxBrowsers(n) {
  maxConcurrency = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}
function getMaxBrowsers() {
  return maxConcurrency;
}
function getActiveBrowsers() {
  return active;
}
function getQueueDepth() {
  return waiting.length;
}
async function acquireBrowserSlot() {
  if (active < maxConcurrency) {
    active++;
    return;
  }
  await new Promise((resolve4) => {
    waiting.push(resolve4);
  });
}
function releaseBrowserSlot() {
  if (waiting.length > 0) {
    const next = waiting.shift();
    next();
  } else {
    active = Math.max(0, active - 1);
  }
}
function resetBrowserQueue() {
  while (waiting.length > 0) waiting.shift()();
  active = 0;
  maxConcurrency = 1;
}

// src/harness/live-sessions.ts
var live = /* @__PURE__ */ new Set();
function trackSession(session) {
  live.add(session);
}
function untrackSession(session) {
  live.delete(session);
}

// src/config.ts
import { resolve } from "path";
var VALID_BACKENDS = ["webgl2", "webgpu"];
function parseCount(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function parseDuration(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function parseBackend(value) {
  if (value && VALID_BACKENDS.includes(value)) {
    return value;
  }
  return "webgl2";
}
function getConfig() {
  const projectRoot = process.env.SHADE_PROJECT_ROOT || process.cwd();
  return {
    effectsDir: process.env.SHADE_EFFECTS_DIR || resolve(projectRoot, "effects"),
    viewerPort: parseCount(process.env.SHADE_VIEWER_PORT, 0),
    defaultBackend: parseBackend(process.env.SHADE_BACKEND),
    projectRoot,
    globalsPrefix: process.env.SHADE_GLOBALS_PREFIX || void 0,
    viewerPath: process.env.SHADE_VIEWER_PATH || void 0,
    maxBrowsers: parseCount(process.env.SHADE_MAX_BROWSERS, 1),
    timeoutMs: parseDuration(process.env.SHADE_TIMEOUT_MS, 12e4),
    aiTimeoutMs: parseDuration(process.env.SHADE_AI_TIMEOUT_MS, 12e4),
    aiModel: process.env.SHADE_AI_MODEL || void 0
  };
}

// src/harness/browser-session.ts
function getBrowserLaunchOptions(headless, backend) {
  const args = ["--disable-gpu-sandbox"];
  if (backend === "webgpu") {
    args.push(
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--enable-webgpu-developer-features",
      process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=vulkan"
    );
  } else {
    if (process.platform === "darwin") {
      args.push("--use-angle=metal");
    }
  }
  if (process.env.SHADE_SWIFTSHADER === "1" || process.env.SHADE_SWIFTSHADER === "true") {
    args.push("--enable-unsafe-swiftshader");
  }
  return { headless, args };
}
var BrowserSession = class {
  options;
  viewerPath;
  /** Ceiling for every page operation this session performs. */
  timeoutMs;
  browser = null;
  context = null;
  page = null;
  globals;
  baseUrl = "";
  consoleMessages = [];
  _isSetup = false;
  _serverAcquired = false;
  _slotAcquired = false;
  constructor(opts) {
    const config = getConfig();
    this.globals = opts.globals ?? (config.globalsPrefix ? globalsFromPrefix(config.globalsPrefix) : DEFAULT_GLOBALS);
    this.viewerPath = opts.viewerPath ?? config.viewerPath ?? "/";
    this.timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    this.options = {
      backend: opts.backend,
      // Headless by default: a visible window on every tool call is noise, and
      // launching headed fails outright wherever there is no display. Opt back
      // in with { headless: false } or SHADE_HEADLESS=0.
      headless: opts.headless ?? !(process.env.SHADE_HEADLESS === "0" || process.env.SHADE_HEADLESS === "false"),
      viewerPort: opts.viewerPort ?? config.viewerPort,
      viewerRoot: opts.viewerRoot ?? process.env.SHADE_VIEWER_ROOT ?? resolve2(config.projectRoot, "viewer"),
      effectsDir: opts.effectsDir ?? config.effectsDir
    };
  }
  async setup() {
    if (this._isSetup) throw new Error("Session already set up. Call teardown() first.");
    await acquireBrowserSlot();
    this._slotAcquired = true;
    try {
      this.baseUrl = await acquireServer(this.options.viewerPort, this.options.viewerRoot, this.options.effectsDir);
      this._serverAcquired = true;
      this.browser = await chromium.launch(
        getBrowserLaunchOptions(this.options.headless, this.options.backend)
      );
      const viewportSize = process.env.CI ? { width: 256, height: 256 } : { width: 1280, height: 720 };
      this.context = await this.browser.newContext({
        viewport: viewportSize,
        ignoreHTTPSErrors: true
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.timeoutMs);
      this.page.setDefaultNavigationTimeout(this.timeoutMs);
      this.consoleMessages = [];
      this.page.on("console", (msg) => {
        const text = msg.text();
        if (text.includes("Error") || text.includes("error") || text.includes("warning") || text.includes("[compileEffect]") || text.includes("[expand]") || text.includes("[Pipeline") || text.includes("[MCP-UNIFORM]") || msg.type() === "error" || msg.type() === "warning") {
          this.consoleMessages.push({ type: msg.type(), text });
        }
      });
      this.page.on("pageerror", (error) => {
        this.consoleMessages.push({ type: "pageerror", text: error.message });
      });
      await this.page.goto(`${this.baseUrl}${this.viewerPath}`, { waitUntil: "networkidle" });
      const rendererGlobal = this.globals.canvasRenderer;
      await this.page.waitForFunction(
        (name) => !!window[name],
        rendererGlobal,
        { timeout: this.timeoutMs }
      );
      this._isSetup = true;
      trackSession(this);
    } catch (err) {
      if (this.page) await this.page.close().catch(() => {
      });
      if (this.context) await this.context.close().catch(() => {
      });
      if (this.browser) await this.browser.close().catch(() => {
      });
      this.page = null;
      this.context = null;
      this.browser = null;
      this.releaseShared();
      throw err;
    }
  }
  /**
   * Hands back the server ref and browser slot exactly once. Tools call
   * teardown() from a finally block that also runs after a failed setup, so
   * releasing unconditionally would hand back another session's resources.
   */
  releaseShared() {
    if (this._serverAcquired) {
      releaseServer();
      this._serverAcquired = false;
    }
    if (this._slotAcquired) {
      releaseBrowserSlot();
      this._slotAcquired = false;
    }
  }
  async teardown() {
    if (this.page) {
      await this.page.close().catch(() => {
      });
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {
      });
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {
      });
      this.browser = null;
    }
    this.releaseShared();
    untrackSession(this);
    this.consoleMessages = [];
    this._isSetup = false;
  }
  async setBackend(backend) {
    const targetBackend = backend === "webgpu" ? "wgsl" : "glsl";
    await this.page.evaluate(async ({ targetBackend: targetBackend2, timeout, globals }) => {
      const w = window;
      const current = typeof w[globals.currentBackend] === "function" ? w[globals.currentBackend]() : "glsl";
      if (current === targetBackend2) return;
      const renderer = w[globals.canvasRenderer];
      if (renderer && typeof renderer.switchBackend === "function") {
        await renderer.switchBackend(targetBackend2);
      } else {
        const btn = document.querySelector(`button[data-backend="${targetBackend2}"]`);
        if (btn) {
          btn.click();
        } else {
          const radio = document.querySelector(`input[name="backend"][value="${targetBackend2}"]`);
          if (radio) radio.click();
        }
      }
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const nowBackend = typeof w[globals.currentBackend] === "function" ? w[globals.currentBackend]() : "glsl";
        if (nowBackend === targetBackend2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }, { targetBackend, timeout: this.timeoutMs, globals: this.globals });
  }
  clearConsoleMessages() {
    this.consoleMessages = [];
  }
  getConsoleMessages() {
    return this.consoleMessages;
  }
  async runWithConsoleCapture(fn) {
    this.clearConsoleMessages();
    const result = await fn();
    if (this.consoleMessages.length > 0) {
      result.console_errors = this.consoleMessages.map((m) => m.text);
    }
    return result;
  }
  get backend() {
    return this.options.backend;
  }
  async selectEffect(effectId) {
    await this.page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
  }
  async getEffectGlobals() {
    return await this.page.evaluate((globals) => {
      const effect = window[globals.currentEffect];
      if (!effect?.instance?.globals) return {};
      return effect.instance.globals;
    }, this.globals);
  }
  async resetUniformsToDefaults() {
    await this.page.evaluate((globals) => {
      const w = window;
      const pipeline = w[globals.renderingPipeline];
      const effect = w[globals.currentEffect];
      if (!pipeline || !effect?.instance?.globals) return;
      for (const spec of Object.values(effect.instance.globals)) {
        if (!spec.uniform) continue;
        const val = spec.default ?? spec.min ?? 0;
        if (pipeline.setUniform) {
          pipeline.setUniform(spec.uniform, val);
        } else if (pipeline.globalUniforms) {
          pipeline.globalUniforms[spec.uniform] = val;
        }
      }
    }, this.globals);
  }
};

// src/harness/pixel-reader.ts
function computeImageMetrics(data, width, height) {
  const pixelCount = width * height;
  const isFloat = data instanceof Float32Array;
  const scale = isFloat ? 1 : 1 / 255;
  const sampleStride = Math.max(1, Math.floor(pixelCount / 1e3));
  let sampleCount = 0;
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;
  let sumLuma = 0, sumLuma2 = 0;
  let allZero = true;
  let allTransparent = true;
  const colorSet = /* @__PURE__ */ new Set();
  for (let p = 0; p < pixelCount; p += sampleStride) {
    const i = p * 4;
    const r = data[i] * scale;
    const g = data[i + 1] * scale;
    const b = data[i + 2] * scale;
    const a = data[i + 3] * scale;
    sumR += r;
    sumG += g;
    sumB += b;
    sumA += a;
    sumR2 += r * r;
    sumG2 += g * g;
    sumB2 += b * b;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sumLuma += luma;
    sumLuma2 += luma * luma;
    if (r > 1e-3 || g > 1e-3 || b > 1e-3) allZero = false;
    if (a > 1e-3) allTransparent = false;
    const qr = Math.floor(r * 63);
    const qg = Math.floor(g * 63);
    const qb = Math.floor(b * 63);
    colorSet.add(qr << 12 | qg << 6 | qb);
    sampleCount++;
  }
  const n = sampleCount || 1;
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;
  const meanA = sumA / n;
  const meanLuma = sumLuma / n;
  const stdR = Math.sqrt(Math.max(0, sumR2 / n - meanR * meanR));
  const stdG = Math.sqrt(Math.max(0, sumG2 / n - meanG * meanG));
  const stdB = Math.sqrt(Math.max(0, sumB2 / n - meanB * meanB));
  const lumaVariance = Math.max(0, sumLuma2 / n - meanLuma * meanLuma);
  const uniqueColors = colorSet.size;
  const isBlank = meanR < 0.01 && meanG < 0.01 && meanB < 0.01 && uniqueColors <= 10;
  return {
    mean_rgb: [meanR, meanG, meanB],
    mean_alpha: meanA,
    std_rgb: [stdR, stdG, stdB],
    luma_variance: lumaVariance,
    unique_sampled_colors: uniqueColors,
    is_all_zero: allZero,
    is_all_transparent: allTransparent,
    is_essentially_blank: isBlank,
    is_monochrome: uniqueColors <= 1
  };
}

// src/tools/browser/compile.ts
import { z } from "zod";

// src/tools/resolve-effects.ts
import { readdirSync, existsSync as existsSync2, statSync } from "fs";
import { join as join2, basename as basename2, resolve as resolve3, isAbsolute, sep as sep2 } from "path";
function resolveEffectIds(args, effectsDir) {
  if (args.effects) {
    return args.effects.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (args.effect_id) {
    return [args.effect_id];
  }
  if (!existsSync2(effectsDir)) {
    throw new Error(`Effects directory not found: ${effectsDir}. Specify effect_id or set SHADE_EFFECTS_DIR.`);
  }
  if (existsSync2(join2(effectsDir, "definition.json")) || existsSync2(join2(effectsDir, "definition.js"))) {
    const dirName = basename2(effectsDir) || "effect";
    console.warn(`[shade-mcp] Auto-detected flat effect layout: ${dirName}`);
    return [dirName];
  }
  const found = [];
  try {
    const namespaces = readdirSync(effectsDir).filter((n) => !n.startsWith("."));
    for (const ns of namespaces) {
      const nsDir = join2(effectsDir, ns);
      if (!statSync(nsDir).isDirectory()) continue;
      const effects = readdirSync(nsDir).filter((n) => !n.startsWith("."));
      for (const effect of effects) {
        const effectDir = join2(nsDir, effect);
        if (!statSync(effectDir).isDirectory()) continue;
        if (existsSync2(join2(effectDir, "definition.json")) || existsSync2(join2(effectDir, "definition.js"))) {
          found.push(`${ns}/${effect}`);
        }
      }
    }
  } catch (err) {
    throw new Error(`Failed to scan effects directory: ${effectsDir}`, { cause: err });
  }
  if (found.length === 0) {
    throw new Error(`No effects found in ${effectsDir}. Specify effect_id.`);
  }
  if (found.length === 1) {
    console.warn(`[shade-mcp] Auto-detected single effect: ${found[0]}`);
    return found;
  }
  throw new Error(
    `Multiple effects found (${found.length}). Please specify effect_id or effects parameter. Available: ${found.slice(0, 10).join(", ")}${found.length > 10 ? "..." : ""}`
  );
}
function resolveEffectDir(effectId, effectsDir) {
  const dirName = basename2(effectsDir) || "effect";
  if (effectId === dirName && (existsSync2(join2(effectsDir, "definition.json")) || existsSync2(join2(effectsDir, "definition.js")))) {
    return effectsDir;
  }
  const segments = effectId.split("/");
  if (isAbsolute(effectId) || segments.some((s) => s === ".." || s === ".")) {
    throw new Error(`Invalid effect id: ${effectId}`);
  }
  const root = resolve3(effectsDir);
  const target = resolve3(effectsDir, ...segments);
  if (target !== root && !target.startsWith(root + sep2)) {
    throw new Error(`Invalid effect id: ${effectId}`);
  }
  return join2(effectsDir, ...segments);
}
function matchEffects(allEffects, pattern) {
  if (!pattern.includes("*")) {
    return allEffects.filter((e) => e === pattern);
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, "[^/]+") + "$");
  return allEffects.filter((e) => regex.test(e));
}

// src/tools/browser/compile.ts
var compileEffectSchema = {
  effect_id: z.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z.string().optional().describe("CSV of effect IDs"),
  backend: z.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend")
};
async function compileEffect(session, effectId) {
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    await page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
    const result = await page.evaluate(({ timeout, globals }) => {
      return new Promise((resolve4) => {
        const start = Date.now();
        const poll = () => {
          const status = document.getElementById("status");
          const text = (status?.textContent || "").toLowerCase();
          const pipeline = window[globals.renderingPipeline];
          if (text.includes("error") || text.includes("failed")) {
            const passes = pipeline?.graph?.passes?.map((p, i) => ({
              id: p.name || `pass_${i}`,
              status: "error"
            })) || [];
            resolve4({ status: "error", passes, message: status?.textContent || "Compilation failed" });
            return;
          }
          if (text.includes("loaded") || text.includes("compiled") || text.includes("ready")) {
            const passes = pipeline?.graph?.passes?.map((p, i) => ({
              id: p.name || `pass_${i}`,
              status: "ok"
            })) || [{ id: "main", status: "ok" }];
            resolve4({ status: "ok", passes, message: "Compiled successfully" });
            return;
          }
          if (Date.now() - start > timeout) {
            resolve4({ status: "error", passes: [], message: "Compile timeout" });
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      });
    }, { timeout: session.timeoutMs, globals: session.globals });
    return { ...result, backend: session.backend };
  });
}

// src/tools/browser/render.ts
import { z as z2 } from "zod";
var renderEffectFrameSchema = {
  effect_id: z2.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z2.string().optional().describe("CSV of effect IDs"),
  backend: z2.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend"),
  warmup_frames: z2.number().optional().default(10).describe("Frames to wait before capture"),
  capture_image: z2.boolean().optional().default(false).describe("Capture PNG data URI"),
  uniforms: z2.record(z2.string(), z2.number()).optional().describe("Uniform overrides"),
  time: z2.number().optional().describe("Pause and render at specific time value (seconds)"),
  resolution: z2.tuple([z2.number(), z2.number()]).optional().describe("Viewport resolution [width, height]")
};
async function renderEffectFrame(session, effectId, options = {}) {
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    if (options.resolution) {
      await page.setViewportSize({ width: options.resolution[0], height: options.resolution[1] });
    }
    await page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
    await page.waitForFunction(() => {
      const s = document.getElementById("status");
      const t = (s?.textContent || "").toLowerCase();
      return t.includes("loaded") || t.includes("compiled") || t.includes("ready") || t.includes("error");
    }, { timeout: session.timeoutMs });
    if (options.uniforms) {
      await page.evaluate(({ unis, globals }) => {
        const pipeline = window[globals.renderingPipeline];
        if (!pipeline) return;
        for (const [k, v] of Object.entries(unis)) {
          if (pipeline.setUniform) pipeline.setUniform(k, v);
          else if (pipeline.globalUniforms) pipeline.globalUniforms[k] = v;
        }
      }, { unis: options.uniforms, globals: session.globals });
    }
    if (options.time !== void 0) {
      await page.evaluate(({ time, globals }) => {
        const w = window;
        if (w[globals.setPaused]) w[globals.setPaused](true);
        if (w[globals.setPausedTime]) w[globals.setPausedTime](time);
      }, { time: options.time, globals: session.globals });
    }
    const warmup = options.warmupFrames ?? 10;
    await page.evaluate(({ frames, globals }) => {
      return new Promise((resolve4) => {
        const start = window[globals.frameCount] || 0;
        const poll = () => {
          const current = window[globals.frameCount] || 0;
          if (current - start >= frames) resolve4();
          else requestAnimationFrame(poll);
        };
        poll();
      });
    }, { frames: warmup, globals: session.globals });
    const result = await page.evaluate(({ captureImage, globals }) => {
      const renderer = window[globals.canvasRenderer];
      const pipeline = window[globals.renderingPipeline];
      if (!renderer || !pipeline) return { status: "error", backend: "unknown", error: "No renderer" };
      const canvas = renderer.canvas;
      const gl = pipeline.backend?.gl;
      let pixels = null;
      let width = canvas.width, height = canvas.height;
      if (gl) {
        pixels = new Uint8Array(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      if (!pixels) return { status: "error", backend: "unknown", error: "Failed to read pixels" };
      const pixelCount = width * height;
      const stride = Math.max(1, Math.floor(pixelCount / 1e3));
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
      let sumR2 = 0, sumG2 = 0, sumB2 = 0;
      let samples = 0;
      const colorSet = /* @__PURE__ */ new Set();
      for (let i = 0; i < pixelCount; i += stride) {
        const idx = i * 4;
        const r = pixels[idx] / 255, g = pixels[idx + 1] / 255, b = pixels[idx + 2] / 255, a = pixels[idx + 3] / 255;
        sumR += r;
        sumG += g;
        sumB += b;
        sumA += a;
        sumR2 += r * r;
        sumG2 += g * g;
        sumB2 += b * b;
        colorSet.add(`${pixels[idx]},${pixels[idx + 1]},${pixels[idx + 2]}`);
        samples++;
      }
      const meanR = sumR / samples, meanG = sumG / samples, meanB = sumB / samples;
      const stdR = Math.sqrt(sumR2 / samples - meanR * meanR);
      const stdG = Math.sqrt(sumG2 / samples - meanG * meanG);
      const stdB = Math.sqrt(sumB2 / samples - meanB * meanB);
      const luma = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;
      let lumaVar = 0;
      for (let i = 0; i < pixelCount; i += stride) {
        const idx = i * 4;
        const l = 0.299 * pixels[idx] / 255 + 0.587 * pixels[idx + 1] / 255 + 0.114 * pixels[idx + 2] / 255;
        lumaVar += (l - luma) * (l - luma);
      }
      lumaVar /= samples;
      const isAllZero = meanR === 0 && meanG === 0 && meanB === 0;
      const isAllTransparent = sumA / samples < 0.01;
      const isBlank = lumaVar < 1e-4;
      const isMono = colorSet.size <= 1;
      let imageUri = null;
      if (captureImage) {
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = width;
        tmpCanvas.height = height;
        const ctx = tmpCanvas.getContext("2d");
        const imgData = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const srcIdx = ((height - 1 - y) * width + x) * 4;
            const dstIdx = (y * width + x) * 4;
            imgData.data[dstIdx] = pixels[srcIdx];
            imgData.data[dstIdx + 1] = pixels[srcIdx + 1];
            imgData.data[dstIdx + 2] = pixels[srcIdx + 2];
            imgData.data[dstIdx + 3] = pixels[srcIdx + 3];
          }
        }
        ctx.putImageData(imgData, 0, 0);
        imageUri = tmpCanvas.toDataURL("image/png");
      }
      return {
        status: "ok",
        backend: pipeline.backend?.getName?.() || "unknown",
        frame: { image_uri: imageUri, width, height },
        metrics: {
          mean_rgb: [meanR, meanG, meanB],
          mean_alpha: sumA / samples,
          std_rgb: [stdR, stdG, stdB],
          luma_variance: lumaVar,
          unique_sampled_colors: colorSet.size,
          is_all_zero: isAllZero,
          is_all_transparent: isAllTransparent,
          is_essentially_blank: isBlank,
          is_monochrome: isMono
        }
      };
    }, { captureImage: options.captureImage ?? false, globals: session.globals });
    if (options.time !== void 0) {
      await page.evaluate((globals) => {
        const w = window;
        if (w[globals.setPaused]) w[globals.setPaused](false);
      }, session.globals);
    }
    return result;
  });
}

// src/tools/browser/benchmark.ts
import { z as z3 } from "zod";
var benchmarkEffectFPSSchema = {
  effect_id: z3.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z3.string().optional().describe("CSV of effect IDs"),
  backend: z3.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend"),
  target_fps: z3.number().optional().default(60).describe("Target FPS"),
  duration_seconds: z3.number().optional().default(5).describe("Benchmark duration in seconds"),
  resolution: z3.tuple([z3.number(), z3.number()]).optional().describe("Viewport resolution [width, height]")
};
async function benchmarkEffectFPS(session, effectId, options = {}) {
  const targetFps = options.targetFps ?? 60;
  const duration = options.durationSeconds ?? 5;
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    if (options.resolution) {
      await page.setViewportSize({ width: options.resolution[0], height: options.resolution[1] });
    }
    await page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
    await page.waitForFunction(() => {
      const s = document.getElementById("status");
      const t = (s?.textContent || "").toLowerCase();
      return t.includes("loaded") || t.includes("compiled") || t.includes("ready") || t.includes("error");
    }, { timeout: session.timeoutMs });
    const result = await page.evaluate(({ duration: duration2 }) => {
      return new Promise((resolve4) => {
        const frameTimes = [];
        let lastTime = performance.now();
        let running = true;
        function onFrame() {
          if (!running) return;
          const now = performance.now();
          frameTimes.push(now - lastTime);
          lastTime = now;
          requestAnimationFrame(onFrame);
        }
        requestAnimationFrame(onFrame);
        setTimeout(() => {
          running = false;
          const frameCount = frameTimes.length;
          const totalMs = frameTimes.reduce((a, b) => a + b, 0);
          const fps = frameCount / (totalMs / 1e3);
          const avgFrameTime = totalMs / Math.max(frameCount, 1);
          let minFrameTime = Infinity, maxFrameTime = 0;
          for (const t of frameTimes) {
            if (t < minFrameTime) minFrameTime = t;
            if (t > maxFrameTime) maxFrameTime = t;
          }
          let sumSq = 0;
          for (const t of frameTimes) sumSq += (t - avgFrameTime) ** 2;
          const jitter = frameCount > 1 ? Math.sqrt(sumSq / (frameCount - 1)) : 0;
          resolve4({
            frame_count: frameCount,
            achieved_fps: Math.round(fps * 100) / 100,
            avg_frame_time_ms: Math.round(avgFrameTime * 100) / 100,
            min_frame_time_ms: Math.round((minFrameTime === Infinity ? 0 : minFrameTime) * 100) / 100,
            max_frame_time_ms: Math.round(maxFrameTime * 100) / 100,
            jitter_ms: Math.round(jitter * 100) / 100
          });
        }, duration2 * 1e3);
      });
    }, { duration });
    const backend = session.backend;
    return {
      status: "ok",
      backend,
      achieved_fps: result.achieved_fps,
      meets_target: result.achieved_fps >= targetFps,
      stats: {
        frame_count: result.frame_count,
        avg_frame_time_ms: result.avg_frame_time_ms,
        jitter_ms: result.jitter_ms,
        min_frame_time_ms: result.min_frame_time_ms,
        max_frame_time_ms: result.max_frame_time_ms
      }
    };
  });
}

// src/tools/browser/passthrough.ts
import { z as z4 } from "zod";
var testNoPassthroughSchema = {
  effect_id: z4.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z4.string().optional().describe("CSV of effect IDs"),
  backend: z4.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend")
};
async function testNoPassthrough(session, effectId) {
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    await page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
    await page.waitForFunction(() => {
      const s = document.getElementById("status");
      const t = (s?.textContent || "").toLowerCase();
      return t.includes("loaded") || t.includes("compiled") || t.includes("ready") || t.includes("error");
    }, { timeout: session.timeoutMs });
    const result = await page.evaluate((globals) => {
      const w = window;
      const pipeline = w[globals.renderingPipeline];
      const effect = w[globals.currentEffect];
      if (!pipeline || !effect) return { status: "error", isFilterEffect: false, similarity: null, details: "No effect loaded" };
      const renderer = w[globals.canvasRenderer];
      const gl = pipeline.backend?.gl;
      if (!renderer || !gl) return { status: "error", isFilterEffect: false, similarity: null, details: "No GL context" };
      const passes = pipeline.graph?.passes || [];
      const isFilter = passes.some((p) => {
        const inputs = p.inputs || {};
        return Object.values(inputs).some((v) => String(v).includes("input"));
      });
      if (!isFilter) return { status: "skipped", isFilterEffect: false, similarity: null, details: "Not a filter effect" };
      const canvas = renderer.canvas;
      const width = canvas.width, height = canvas.height;
      renderer.render(0);
      const pixels0 = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels0);
      renderer.render(1);
      const pixels1 = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels1);
      const pixelCount = width * height;
      const stride = Math.max(1, Math.floor(pixelCount / 1e3));
      let diffSum = 0, samples = 0;
      const colors = /* @__PURE__ */ new Set();
      for (let i = 0; i < pixelCount; i += stride) {
        const idx = i * 4;
        diffSum += Math.abs(pixels0[idx] - pixels1[idx]) + Math.abs(pixels0[idx + 1] - pixels1[idx + 1]) + Math.abs(pixels0[idx + 2] - pixels1[idx + 2]);
        colors.add(`${pixels0[idx]},${pixels0[idx + 1]},${pixels0[idx + 2]}`);
        samples++;
      }
      const temporalDiff = diffSum / (samples * 3 * 255);
      const uniqueColors = colors.size;
      const isModifying = temporalDiff > 0.01 || uniqueColors > 5;
      return {
        status: isModifying ? "ok" : "passthrough",
        isFilterEffect: true,
        temporalDiff,
        uniqueColors,
        details: isModifying ? "Effect modifies input" : "Effect may be passing through unchanged"
      };
    }, session.globals);
    return result;
  });
}

// src/tools/browser/parity.ts
import { z as z5 } from "zod";
var testPixelParitySchema = {
  effect_id: z5.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z5.string().optional().describe("CSV of effect IDs"),
  epsilon: z5.number().optional().default(1).describe("Allowed per-channel difference (0-255)"),
  seed: z5.number().optional().default(42).describe("Random seed for reproducible noise")
};
async function waitReady(session) {
  await session.page.waitForFunction((globals) => {
    const w = window;
    const p = w[globals.renderingPipeline];
    if (!p || p.isCompiling) return false;
    return !!(p.graph && p.graph.passes && p.graph.passes.length > 0);
  }, session.globals, { timeout: session.timeoutMs, polling: 50 });
}
async function warmUp(session, frames = 6) {
  const start = await session.page.evaluate((globals) => {
    const w = window;
    if (w[globals.setPaused]) w[globals.setPaused](false);
    return w[globals.frameCount] || 0;
  }, session.globals);
  await session.page.waitForFunction(
    ({ globals, target }) => (window[globals.frameCount] || 0) >= target,
    { globals: session.globals, target: start + frames },
    { timeout: 3e4, polling: 30 }
  );
}
async function captureSurface(session, seed) {
  return await session.page.evaluate(async ({ globals, seed: seed2 }) => {
    const w = window;
    if (w[globals.setPaused]) w[globals.setPaused](true);
    if (w[globals.setPausedTime]) w[globals.setPausedTime](0);
    const p = w[globals.renderingPipeline];
    if (!p) return null;
    if (p.globalUniforms) p.globalUniforms.seed = seed2;
    for (const pass of p.graph?.passes || []) if (pass.uniforms) pass.uniforms.seed = seed2;
    const r = w[globals.canvasRenderer];
    const b = p.backend;
    if (!r || !b || !b.readPixels || !b.textures) return null;
    const surf = p.graph?.renderSurface;
    if (!surf) return null;
    const readSurface = async () => {
      const candidates = ["global_" + surf + "_read"];
      try {
        const nodes = [];
        for (const k of b.textures.keys()) if (/node_\d+_out/.test(k)) nodes.push(k);
        nodes.sort((a, c) => parseInt(a.match(/node_(\d+)/)[1], 10) - parseInt(c.match(/node_(\d+)/)[1], 10));
        if (nodes.length) candidates.push(nodes[nodes.length - 1]);
      } catch (e) {
      }
      for (const id of candidates) {
        try {
          const px2 = await b.readPixels(id);
          if (px2 && px2.width && px2.height && px2.data) return px2;
        } catch (e) {
        }
      }
      return null;
    };
    let px = null;
    for (let attempt = 0; attempt < 6 && !px; attempt++) {
      r.render(0);
      r.render(0);
      px = await readSurface();
      if (!px) await new Promise((res) => setTimeout(res, 80));
    }
    if (!px) return null;
    let data = px.data;
    if (!b.gl) {
      const flipped = new Uint8Array(px.width * px.height * 4);
      const rowBytes = px.width * 4;
      for (let y = 0; y < px.height; y++) {
        flipped.set(data.subarray((px.height - 1 - y) * rowBytes, (px.height - y) * rowBytes), y * rowBytes);
      }
      data = flipped;
    }
    return { data: Array.from(data), width: px.width, height: px.height };
  }, { globals: session.globals, seed });
}
async function testPixelParity(session, effectId, options = {}) {
  const epsilon = options.epsilon ?? 1;
  const seed = options.seed ?? 42;
  await session.setBackend("webgl2");
  await session.selectEffect(effectId);
  await waitReady(session);
  await warmUp(session);
  const glslPixels = await captureSurface(session, seed);
  if (!glslPixels) {
    return { status: "error", maxDiff: 0, meanDiff: 0, mismatchCount: 0, mismatchPercent: 0, resolution: [0, 0], details: "Failed to capture WebGL2" };
  }
  await session.setBackend("webgpu");
  await session.selectEffect(effectId);
  await waitReady(session);
  await warmUp(session);
  const wgslPixels = await captureSurface(session, seed);
  await session.page.evaluate((globals) => {
    const w2 = window;
    if (w2[globals.setPaused]) w2[globals.setPaused](false);
  }, session.globals);
  if (!wgslPixels) {
    return { status: "error", maxDiff: 0, meanDiff: 0, mismatchCount: 0, mismatchPercent: 0, resolution: [glslPixels.width, glslPixels.height], details: "Failed to capture WebGPU" };
  }
  if (glslPixels.width !== wgslPixels.width || glslPixels.height !== wgslPixels.height) {
    return {
      status: "error",
      maxDiff: 0,
      meanDiff: 0,
      mismatchCount: 0,
      mismatchPercent: 0,
      resolution: [glslPixels.width, glslPixels.height],
      details: `Capture size mismatch: glsl ${glslPixels.width}x${glslPixels.height} vs wgsl ${wgslPixels.width}x${wgslPixels.height}`
    };
  }
  let maxDiff = 0;
  let totalDiff = 0;
  let mismatchCount = 0;
  const totalChannels = glslPixels.data.length;
  for (let i = 0; i < totalChannels; i++) {
    const diff = Math.abs(glslPixels.data[i] - wgslPixels.data[i]);
    if (diff > maxDiff) maxDiff = diff;
    totalDiff += diff;
    if (diff > epsilon) mismatchCount++;
  }
  const meanDiff = totalDiff / totalChannels;
  const mismatchPercent = mismatchCount / totalChannels * 100;
  const w = glslPixels.width, h = glslPixels.height;
  function checkSolid(pixels, label) {
    const n = pixels.width * pixels.height;
    let rS = 0, gS = 0, bS = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      rS += pixels.data[i];
      gS += pixels.data[i + 1];
      bS += pixels.data[i + 2];
    }
    const rM = rS / n, gM = gS / n, bM = bS / n;
    let rV = 0, gV = 0, bV = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      rV += (pixels.data[i] - rM) ** 2;
      gV += (pixels.data[i + 1] - gM) ** 2;
      bV += (pixels.data[i + 2] - bM) ** 2;
    }
    rV /= n;
    gV /= n;
    bV /= n;
    const isSolid = rV < 5 && gV < 5 && bV < 5;
    return { label, isSolid, variance: [Math.round(rV), Math.round(gV), Math.round(bV)], mean: [Math.round(rM), Math.round(gM), Math.round(bM)] };
  }
  const glslSolid = checkSolid(glslPixels, "glsl");
  const wgslSolid = checkSolid(wgslPixels, "wgsl");
  let yFlipMismatch = 0;
  let yFlipTotalDiff = 0;
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const glslRow = y;
    const wgslFlippedRow = h - 1 - y;
    for (let x = 0; x < rowBytes; x++) {
      const diff = Math.abs(glslPixels.data[glslRow * rowBytes + x] - wgslPixels.data[wgslFlippedRow * rowBytes + x]);
      yFlipTotalDiff += diff;
      if (diff > epsilon) yFlipMismatch++;
    }
  }
  const yFlipPercent = yFlipMismatch / totalChannels * 100;
  const yFlipMeanDiff = yFlipTotalDiff / totalChannels;
  const yFlipRatio = meanDiff > 0 ? yFlipMeanDiff / meanDiff : 1;
  const isYFlipped = meanDiff > 2 && // there is a real difference to explain
  yFlipMeanDiff < meanDiff && // flipping must actually help
  yFlipRatio < 0.7;
  const isCleanYFlip = meanDiff > 2 && yFlipRatio < 0.25;
  const issues = [];
  if (glslSolid.isSolid) issues.push(`GLSL SOLID COLOR (mean=${glslSolid.mean})`);
  if (wgslSolid.isSolid) issues.push(`WGSL SOLID COLOR (mean=${wgslSolid.mean})`);
  if (isYFlipped) {
    issues.push(
      `${isCleanYFlip ? "Y-FLIP" : "PARTIAL Y-FLIP"} DETECTED (flipped meanDiff=${yFlipMeanDiff.toFixed(2)} vs normal meanDiff=${meanDiff.toFixed(2)}, ratio=${yFlipRatio.toFixed(2)}, flip mismatch=${yFlipPercent.toFixed(1)}% vs normal=${mismatchPercent.toFixed(1)}%)`
    );
  }
  const status = mismatchPercent < 1 ? "ok" : "mismatch";
  return {
    status,
    maxDiff,
    meanDiff: Math.round(meanDiff * 100) / 100,
    mismatchCount,
    mismatchPercent: Math.round(mismatchPercent * 100) / 100,
    resolution: [w, h],
    glslSolid: glslSolid.isSolid,
    wgslSolid: wgslSolid.isSolid,
    glslVariance: glslSolid.variance,
    wgslVariance: wgslSolid.variance,
    yFlipDetected: isYFlipped,
    yFlipCleanFlip: isCleanYFlip,
    yFlipMismatchPercent: Math.round(yFlipPercent * 100) / 100,
    yFlipMeanDiff: Math.round(yFlipMeanDiff * 100) / 100,
    yFlipRatio: Math.round(yFlipRatio * 1e3) / 1e3,
    issues,
    details: issues.length > 0 ? issues.join("; ") : mismatchPercent < 1 ? `Pixel parity OK (maxDiff=${maxDiff}, meanDiff=${meanDiff.toFixed(2)})` : `Pixel mismatch: ${mismatchPercent.toFixed(1)}% channels differ by >${epsilon}`
  };
}

// src/tools/browser/uniforms.ts
import { z as z6 } from "zod";
var testUniformResponsivenessSchema = {
  effect_id: z6.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z6.string().optional().describe("CSV of effect IDs"),
  backend: z6.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend")
};
async function testUniformResponsiveness(session, effectId) {
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    await page.evaluate((id) => {
      const select = document.getElementById("effect-select");
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event("change"));
      }
    }, effectId);
    await page.waitForFunction(() => {
      const s = document.getElementById("status");
      const t = (s?.textContent || "").toLowerCase();
      return t.includes("loaded") || t.includes("compiled") || t.includes("ready");
    }, { timeout: session.timeoutMs });
    await page.evaluate((globals) => {
      const w = window;
      if (w[globals.setPaused]) w[globals.setPaused](true);
      if (w[globals.setPausedTime]) w[globals.setPausedTime](0);
    }, session.globals);
    const result = await page.evaluate((globals) => {
      const w = window;
      const pipeline = w[globals.renderingPipeline];
      const effect = w[globals.currentEffect];
      if (!pipeline || !effect?.instance?.globals) {
        return { status: "error", tested_uniforms: [], details: "No effect loaded" };
      }
      const renderer = w[globals.canvasRenderer];
      const gl = pipeline.backend?.gl;
      function captureMetrics() {
        if (!renderer || !gl) return null;
        renderer.render(0);
        const canvas = renderer.canvas;
        const width = canvas.width, height = canvas.height;
        const pixels = new Uint8Array(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const count = width * height;
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          sumR += pixels[i] / 255;
          sumG += pixels[i + 1] / 255;
          sumB += pixels[i + 2] / 255;
        }
        return [sumR / count, sumG / count, sumB / count];
      }
      const baseline = captureMetrics();
      if (!baseline) return { status: "error", tested_uniforms: [], details: "Failed to capture baseline" };
      const effectGlobals = effect.instance.globals;
      const tested = [];
      let anyResponded = false;
      for (const [name, spec] of Object.entries(effectGlobals)) {
        if (!spec.uniform) continue;
        if (spec.type === "boolean" || spec.type === "button") continue;
        if (typeof spec.min !== "number" || typeof spec.max !== "number" || spec.min === spec.max) continue;
        const defaultVal = spec.default ?? spec.min;
        const range = spec.max - spec.min;
        let testVal = defaultVal === spec.min ? spec.min + range * 0.75 : spec.min + range * 0.25;
        if (spec.type === "int") testVal = Math.round(testVal);
        if (pipeline.setUniform) pipeline.setUniform(spec.uniform, testVal);
        else if (pipeline.globalUniforms) pipeline.globalUniforms[spec.uniform] = testVal;
        const testMetrics = captureMetrics();
        if (testMetrics) {
          const lumaDiff = Math.abs(
            (testMetrics[0] + testMetrics[1] + testMetrics[2]) / 3 - (baseline[0] + baseline[1] + baseline[2]) / 3
          );
          const maxChannelDiff = Math.max(
            Math.abs(testMetrics[0] - baseline[0]),
            Math.abs(testMetrics[1] - baseline[1]),
            Math.abs(testMetrics[2] - baseline[2])
          );
          if (lumaDiff > 2e-3 || maxChannelDiff > 2e-3) {
            anyResponded = true;
            tested.push(`${name}:pass`);
          } else {
            tested.push(`${name}:fail`);
          }
        } else {
          tested.push(`${name}:error`);
        }
        if (pipeline.setUniform) pipeline.setUniform(spec.uniform, defaultVal);
        else if (pipeline.globalUniforms) pipeline.globalUniforms[spec.uniform] = defaultVal;
      }
      return {
        status: anyResponded ? "ok" : tested.length === 0 ? "skipped" : "error",
        tested_uniforms: tested,
        details: anyResponded ? "Uniforms affect output" : tested.length === 0 ? "No testable uniforms" : "No uniforms affected output"
      };
    }, session.globals);
    await page.evaluate((globals) => {
      const w = window;
      if (w[globals.setPaused]) w[globals.setPaused](false);
    }, session.globals);
    return result;
  });
}

// src/tools/browser/dsl.ts
import { z as z7 } from "zod";
var runDslProgramSchema = {
  dsl: z7.string().describe("DSL program string"),
  backend: z7.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend"),
  warmup_frames: z7.number().optional().default(10).describe("Frames to wait"),
  capture_image: z7.boolean().optional().default(false).describe("Capture PNG data URI"),
  uniforms: z7.record(z7.string(), z7.number()).optional().describe("Uniform overrides")
};
async function runDslProgram(session, dsl, options = {}) {
  return session.runWithConsoleCapture(async () => {
    const page = session.page;
    await session.setBackend(session.backend);
    const compileResult = await page.evaluate(({ dsl: dsl2, timeout, globals }) => {
      return new Promise((resolve4) => {
        const editor = document.getElementById("dsl-editor");
        const runBtn = document.getElementById("dsl-run-btn");
        if (editor && runBtn) {
          editor.value = dsl2;
          editor.dispatchEvent(new Event("input"));
          runBtn.click();
        } else {
          const renderer = window[globals.canvasRenderer];
          if (renderer?.compile) {
            renderer.compile(dsl2).then(() => {
              resolve4({ status: "ok", message: "Compiled via renderer" });
            }).catch((err) => {
              resolve4({ status: "error", message: err?.message || String(err) });
            });
            return;
          }
          resolve4({ status: "error", message: "No DSL editor or renderer found" });
          return;
        }
        const start = Date.now();
        const poll = () => {
          const status = document.getElementById("status");
          const text = (status?.textContent || "").toLowerCase();
          if (text.includes("error") || text.includes("failed")) {
            resolve4({ status: "error", message: status?.textContent });
            return;
          }
          if (text.includes("loaded") || text.includes("compiled") || text.includes("ready")) {
            resolve4({ status: "ok", message: "Compiled" });
            return;
          }
          if (Date.now() - start > timeout) {
            resolve4({ status: "error", message: "Compile timeout" });
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      });
    }, { dsl, timeout: session.timeoutMs, globals: session.globals });
    if (compileResult.status === "error") {
      return { status: "error", error: compileResult.message };
    }
    if (options.uniforms) {
      await page.evaluate(({ unis, globals }) => {
        const pipeline = window[globals.renderingPipeline];
        if (!pipeline) return;
        for (const [k, v] of Object.entries(unis)) {
          if (pipeline.setUniform) pipeline.setUniform(k, v);
          else if (pipeline.globalUniforms) pipeline.globalUniforms[k] = v;
        }
      }, { unis: options.uniforms, globals: session.globals });
    }
    const warmup = options.warmupFrames ?? 10;
    await page.evaluate(({ frames, globals }) => {
      return new Promise((resolve4) => {
        const start = window[globals.frameCount] || 0;
        const poll = () => {
          if ((window[globals.frameCount] || 0) - start >= frames) resolve4();
          else requestAnimationFrame(poll);
        };
        poll();
      });
    }, { frames: warmup, globals: session.globals });
    const result = await page.evaluate(({ captureImage, globals }) => {
      const renderer = window[globals.canvasRenderer];
      const pipeline = window[globals.renderingPipeline];
      if (!renderer || !pipeline) return { status: "error", error: "No renderer" };
      const canvas = renderer.canvas;
      const gl = pipeline.backend?.gl;
      if (!gl) return { status: "error", error: "No GL context" };
      const width = canvas.width, height = canvas.height;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const count = width * height;
      const stride = Math.max(1, Math.floor(count / 1e3));
      let sumR = 0, sumG = 0, sumB = 0, samples = 0;
      const colors = /* @__PURE__ */ new Set();
      for (let i = 0; i < count; i += stride) {
        const idx = i * 4;
        sumR += pixels[idx] / 255;
        sumG += pixels[idx + 1] / 255;
        sumB += pixels[idx + 2] / 255;
        colors.add(`${pixels[idx]},${pixels[idx + 1]},${pixels[idx + 2]}`);
        samples++;
      }
      const meanR = sumR / samples, meanG = sumG / samples, meanB = sumB / samples;
      let imageUri = null;
      if (captureImage) {
        const tmp = document.createElement("canvas");
        tmp.width = width;
        tmp.height = height;
        const ctx = tmp.getContext("2d");
        const imgData = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const src = ((height - 1 - y) * width + x) * 4;
            const dst = (y * width + x) * 4;
            imgData.data[dst] = pixels[src];
            imgData.data[dst + 1] = pixels[src + 1];
            imgData.data[dst + 2] = pixels[src + 2];
            imgData.data[dst + 3] = pixels[src + 3];
          }
        }
        ctx.putImageData(imgData, 0, 0);
        imageUri = tmp.toDataURL("image/png");
      }
      return {
        status: "ok",
        backend: pipeline.backend?.getName?.() || "unknown",
        frame: { width, height, image_uri: imageUri },
        metrics: {
          mean_rgb: [meanR, meanG, meanB],
          unique_sampled_colors: colors.size,
          is_all_zero: meanR === 0 && meanG === 0 && meanB === 0,
          is_monochrome: colors.size <= 1
        }
      };
    }, { captureImage: options.captureImage ?? false, globals: session.globals });
    return result;
  });
}

// src/tools/analysis/structure.ts
import { z as z9 } from "zod";
import { readFileSync as readFileSync4, readdirSync as readdirSync3, existsSync as existsSync5 } from "fs";
import { join as join5 } from "path";

// src/formats/index.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
import { join as join3 } from "path";

// src/formats/definition-json.ts
function parseDefinitionJson(json, effectDir) {
  const globals = {};
  const rawGlobals = json.globals || {};
  for (const [key, spec] of Object.entries(rawGlobals)) {
    globals[key] = {
      name: key,
      type: spec.type || "float",
      uniform: spec.uniform || key,
      default: spec.default,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      choices: spec.choices,
      control: spec.control
    };
  }
  const rawPasses = json.passes || [];
  const passes = rawPasses.map((p) => ({
    name: p.name,
    program: p.program || "main",
    type: p.type,
    inputs: p.inputs,
    outputs: p.outputs
  }));
  return {
    func: json.func,
    name: json.name,
    namespace: json.namespace,
    description: json.description,
    starter: json.starter,
    tags: json.tags,
    globals,
    passes,
    format: "json",
    effectDir
  };
}

// src/formats/definition-js.ts
import { readFileSync } from "fs";
function parseDefinitionJs(filePath, effectDir) {
  const source = readFileSync(filePath, "utf-8");
  const func = extractString(source, /func\s*[:=]\s*['"](\w+)['"]/) || "unknown";
  const name = extractQuotedValue(source, "name");
  const namespace = extractString(source, /namespace\s*[:=]\s*['"](\w+)['"]/);
  const description = extractQuotedValue(source, "description");
  const starter = /starter\s*[:=]\s*true/.test(source) ? true : /starter\s*[:=]\s*false/.test(source) ? false : void 0;
  const tagsMatch = source.match(/tags\s*[:=]\s*\[([^\]]+)\]/);
  const tags = tagsMatch ? tagsMatch[1].split(",").map((t) => t.trim().replace(/['"]/g, "")).filter(Boolean) : void 0;
  const passes = [];
  const passRegex = /program:\s*['"](\w+)['"]/g;
  let match;
  while ((match = passRegex.exec(source)) !== null) {
    passes.push({ program: match[1] });
  }
  if (passes.length === 0) {
    passes.push({ program: "main" });
  }
  const globals = {};
  const globalsKey = source.match(/globals\s*[:=]\s*\{/);
  const globalsText = globalsKey ? balancedBraceSlice(source, globalsKey.index + globalsKey[0].length - 1) : null;
  if (globalsText) {
    const body = globalsText.slice(1, -1);
    const keyRegex = /(\w+)\s*:\s*\{/g;
    let kMatch;
    while ((kMatch = keyRegex.exec(body)) !== null) {
      const name2 = kMatch[1];
      const blockStart = kMatch.index + kMatch[0].length - 1;
      const block = balancedBraceSlice(body, blockStart);
      if (!block) continue;
      keyRegex.lastIndex = blockStart + block.length;
      const ownFields = stripNestedObjects(block);
      const uniform = extractString(ownFields, /uniform:\s*['"](\w+)['"]/);
      if (!uniform) continue;
      const type = extractString(ownFields, /type:\s*['"](\w+)['"]/) || "float";
      const min = extractNumber(ownFields, /min:\s*([-\d.]+)/);
      const max = extractNumber(ownFields, /max:\s*([-\d.]+)/);
      const step = extractNumber(ownFields, /step:\s*([-\d.]+)/);
      const defaultVal = extractNumber(ownFields, /default:\s*([-\d.]+)/);
      globals[name2] = {
        name: name2,
        type,
        uniform,
        ...defaultVal !== void 0 && { default: defaultVal },
        ...min !== void 0 && { min },
        ...max !== void 0 && { max },
        ...step !== void 0 && { step }
      };
    }
  }
  return {
    func,
    name,
    namespace,
    description,
    starter,
    tags,
    globals,
    passes,
    format: "js",
    effectDir
  };
}
function extractString(source, regex) {
  const match = source.match(regex);
  return match ? match[1] : void 0;
}
function extractQuotedValue(source, key) {
  const re = new RegExp(`\\b${key}\\s*[:=]\\s*(['"])((?:\\\\.|[^\\\\\\r\\n])*?)\\1`);
  const match = source.match(re);
  return match ? match[2].replace(/\\(['"\\])/g, "$1") : void 0;
}
function balancedBraceSlice(s, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(openIndex, i + 1);
    }
  }
  return null;
}
function stripNestedObjects(block) {
  let depth = 0;
  let out = "";
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{") {
      depth++;
      if (depth <= 1) out += ch;
    } else if (ch === "}") {
      if (depth <= 1) out += ch;
      depth--;
    } else if (depth <= 1) {
      out += ch;
    }
  }
  return out;
}
function extractNumber(source, regex) {
  const match = source.match(regex);
  return match ? parseFloat(match[1]) : void 0;
}

// src/formats/index.ts
function loadEffectDefinition(effectDir) {
  const jsonPath = join3(effectDir, "definition.json");
  if (existsSync3(jsonPath)) {
    const raw = JSON.parse(readFileSync2(jsonPath, "utf-8"));
    return parseDefinitionJson(raw, effectDir);
  }
  const jsPath = join3(effectDir, "definition.js");
  if (existsSync3(jsPath)) {
    return parseDefinitionJs(jsPath, effectDir);
  }
  throw new Error(`No definition.json or definition.js found in ${effectDir}`);
}

// src/tools/analysis/compare.ts
import { z as z8 } from "zod";
import { readFileSync as readFileSync3, readdirSync as readdirSync2, existsSync as existsSync4 } from "fs";
import { join as join4, basename as basename3 } from "path";
var compareShadersSchema = {
  effect_id: z8.string().describe('Effect ID (e.g., "synth/noise")')
};
function extractFunctionNames(source, lang) {
  const stripped = stripComments(source);
  const names = [];
  if (lang === "glsl") {
    const regex = /\b(?:void|bool|u?int|float|[biu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler\w*)\s+(\w+)\s*\(/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      names.push(match[1]);
    }
  } else {
    const regex = /fn\s+(\w+)\s*\(/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      names.push(match[1]);
    }
  }
  return names;
}
function stripComments(source) {
  source = source.replace(/\/\/.*$/gm, "");
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return source;
}
function extractUniforms(source, lang) {
  const stripped = stripComments(source);
  const uniforms = [];
  if (lang === "glsl") {
    const regex = /uniform[ \t]+\w+[ \t]+(\w+)/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      uniforms.push(match[1]);
    }
  } else {
    const regex = /@group\(\d+\)\s+@binding\(\d+\)\s+var<uniform>\s+(\w+)/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      uniforms.push(match[1]);
    }
  }
  return uniforms;
}
async function compareShaders(effectId) {
  const config = getConfig();
  const effectDir = resolveEffectDir(effectId, config.effectsDir);
  const glslDir = join4(effectDir, "glsl");
  const wgslDir = join4(effectDir, "wgsl");
  const results = [];
  const glslFiles = existsSync4(glslDir) ? readdirSync2(glslDir).filter((f) => f.endsWith(".glsl")) : [];
  const wgslFiles = existsSync4(wgslDir) ? readdirSync2(wgslDir).filter((f) => f.endsWith(".wgsl")) : [];
  const wgslMap = new Map(wgslFiles.map((f) => [basename3(f, ".wgsl"), f]));
  for (const gf of glslFiles) {
    const program = basename3(gf, ".glsl");
    const wf = wgslMap.get(program);
    const glslSource = readFileSync3(join4(glslDir, gf), "utf-8");
    const glslFunctions = extractFunctionNames(glslSource, "glsl");
    const glslUniforms = extractUniforms(glslSource, "glsl");
    const glslLines = glslSource.split("\n").length;
    if (wf) {
      const wgslSource = readFileSync3(join4(wgslDir, wf), "utf-8");
      const wgslFunctions = extractFunctionNames(wgslSource, "wgsl");
      const wgslUniforms = extractUniforms(wgslSource, "wgsl");
      const wgslLines = wgslSource.split("\n").length;
      results.push({
        program,
        glsl: { lines: glslLines, functions: glslFunctions, uniforms: glslUniforms },
        wgsl: { lines: wgslLines, functions: wgslFunctions, uniforms: wgslUniforms },
        lineDiff: Math.abs(glslLines - wgslLines),
        functionCountDiff: Math.abs(glslFunctions.length - wgslFunctions.length)
      });
      wgslMap.delete(program);
    } else {
      results.push({
        program,
        glsl: { lines: glslLines, functions: glslFunctions, uniforms: glslUniforms },
        wgsl: null,
        note: "No WGSL counterpart"
      });
    }
  }
  for (const [program, wf] of wgslMap) {
    const wgslSource = readFileSync3(join4(wgslDir, wf), "utf-8");
    results.push({
      program,
      glsl: null,
      wgsl: {
        lines: wgslSource.split("\n").length,
        functions: extractFunctionNames(wgslSource, "wgsl"),
        uniforms: extractUniforms(wgslSource, "wgsl")
      },
      note: "No GLSL counterpart"
    });
  }
  return {
    status: "ok",
    programs: results,
    summary: `${results.length} programs compared`
  };
}

// src/tools/analysis/structure.ts
var GLSL_RESERVED = /* @__PURE__ */ new Set([
  // Type qualifiers
  "const",
  "uniform",
  "in",
  "out",
  "inout",
  "centroid",
  "flat",
  "smooth",
  "layout",
  "invariant",
  "highp",
  "mediump",
  "lowp",
  "precision",
  // Types
  "void",
  "bool",
  "int",
  "uint",
  "float",
  "vec2",
  "vec3",
  "vec4",
  "bvec2",
  "bvec3",
  "bvec4",
  "ivec2",
  "ivec3",
  "ivec4",
  "uvec2",
  "uvec3",
  "uvec4",
  "mat2",
  "mat3",
  "mat4",
  "sampler2D",
  "sampler3D",
  "samplerCube",
  // Control flow
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "discard",
  "struct",
  "true",
  "false"
]);
var GLSL_BUILTINS = /* @__PURE__ */ new Set([
  // Trig
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  // Exponential
  "pow",
  "exp",
  "log",
  "exp2",
  "log2",
  "sqrt",
  "inversesqrt",
  // Common
  "abs",
  "sign",
  "floor",
  "ceil",
  "fract",
  "mod",
  "min",
  "max",
  "clamp",
  "mix",
  "step",
  "smoothstep",
  // Geometric
  "length",
  "distance",
  "dot",
  "cross",
  "normalize",
  "faceforward",
  "reflect",
  "refract",
  // Texture
  "texture",
  "texelFetch",
  "textureSize",
  // Derivative
  "dFdx",
  "dFdy",
  "fwidth"
]);
var checkEffectStructureSchema = {
  effect_id: z9.string().describe('Effect ID (e.g., "synth/noise")')
};
function checkCamelCase(name) {
  return /^[a-z][a-zA-Z0-9]*$/.test(name);
}
async function checkEffectStructure(effectId) {
  const config = getConfig();
  const effectDir = resolveEffectDir(effectId, config.effectsDir);
  if (!existsSync5(effectDir)) {
    return { status: "error", error: `Effect directory not found: ${effectDir}` };
  }
  const issues = {
    unusedFiles: [],
    namingIssues: [],
    nameCollisions: [],
    leakedInternalUniforms: [],
    missingDescription: false,
    structuralParityIssues: [],
    requiredUniformIssues: [],
    multiPass: false,
    passCount: 0
  };
  let def;
  try {
    def = loadEffectDefinition(effectDir);
  } catch (err) {
    return { status: "error", error: `Failed to parse definition: ${err.message}` };
  }
  issues.missingDescription = !def.description;
  issues.passCount = def.passes.length;
  issues.multiPass = def.passes.length > 1;
  if (def.func && !checkCamelCase(def.func)) {
    issues.namingIssues.push({ type: "func", name: def.func, reason: "Must be camelCase" });
  }
  const INTERNAL = /* @__PURE__ */ new Set(["channels", "time", "resolution", "mouse"]);
  for (const [name, spec] of Object.entries(def.globals || {})) {
    if (!checkCamelCase(name)) {
      issues.namingIssues.push({ type: "global", name, reason: "Must be camelCase" });
    }
    if (INTERNAL.has(spec.uniform || name)) {
      issues.leakedInternalUniforms.push(name);
    }
  }
  const glslDir = join5(effectDir, "glsl");
  const wgslDir = join5(effectDir, "wgsl");
  const glslFiles = existsSync5(glslDir) ? readdirSync3(glslDir).filter(
    (f) => f.endsWith(".glsl") || f.endsWith(".frag") || f.endsWith(".vert")
  ) : [];
  const wgslFiles = existsSync5(wgslDir) ? readdirSync3(wgslDir).filter((f) => f.endsWith(".wgsl")) : [];
  function programName(filename) {
    return filename.replace(/\.(glsl|frag|vert|wgsl)$/, "");
  }
  const referencedPrograms = new Set(def.passes.map((p) => p.program));
  for (const f of glslFiles) {
    if (!referencedPrograms.has(programName(f))) {
      issues.unusedFiles.push(`glsl/${f}`);
    }
  }
  for (const f of wgslFiles) {
    if (!referencedPrograms.has(programName(f))) {
      issues.unusedFiles.push(`wgsl/${f}`);
    }
  }
  const glslPrograms = new Set(glslFiles.map((f) => programName(f)));
  const wgslPrograms = new Set(wgslFiles.map((f) => programName(f)));
  for (const p of glslPrograms) {
    if (!wgslPrograms.has(p)) {
      issues.structuralParityIssues.push({ type: "missing_wgsl", program: p, message: `GLSL program "${p}" has no WGSL counterpart` });
    }
  }
  for (const p of wgslPrograms) {
    if (!glslPrograms.has(p)) {
      issues.structuralParityIssues.push({ type: "missing_glsl", program: p, message: `WGSL program "${p}" has no GLSL counterpart` });
    }
  }
  for (const gf of glslFiles) {
    const source = readFileSync4(join5(glslDir, gf), "utf-8");
    const uniforms = extractUniforms(source, "glsl");
    const functions = extractFunctionNames(source, "glsl");
    const functionSet = new Set(functions);
    for (const u of uniforms) {
      if (functionSet.has(u)) {
        issues.nameCollisions.push({
          type: "uniform_function",
          name: u,
          file: `glsl/${gf}`,
          message: `Uniform "${u}" collides with function "${u}()" in same file`
        });
      }
      if (GLSL_RESERVED.has(u)) {
        issues.nameCollisions.push({
          type: "reserved_word",
          name: u,
          file: `glsl/${gf}`,
          message: `Uniform "${u}" is a GLSL reserved word`
        });
      }
      if (GLSL_BUILTINS.has(u)) {
        issues.nameCollisions.push({
          type: "builtin_shadow",
          name: u,
          file: `glsl/${gf}`,
          message: `Uniform "${u}" shadows GLSL built-in function "${u}()"`
        });
      }
    }
  }
  const hasIssues = issues.unusedFiles.length > 0 || issues.namingIssues.length > 0 || issues.nameCollisions.length > 0 || issues.leakedInternalUniforms.length > 0 || issues.missingDescription || issues.structuralParityIssues.length > 0;
  return { ...issues, status: hasIssues ? "warning" : "ok" };
}
export {
  BrowserSession,
  DEFAULT_GLOBALS,
  acquireServer,
  benchmarkEffectFPS,
  checkEffectStructure,
  compareShaders,
  compileEffect,
  computeImageMetrics,
  getActiveBrowsers,
  getMaxBrowsers,
  getQueueDepth,
  getRefCount,
  getServerUrl,
  globalsFromPrefix,
  matchEffects,
  releaseServer,
  renderEffectFrame,
  resetBrowserQueue,
  resolveEffectDir,
  resolveEffectIds,
  runDslProgram,
  setMaxBrowsers,
  testNoPassthrough,
  testPixelParity,
  testUniformResponsiveness
};
//# sourceMappingURL=index.js.map