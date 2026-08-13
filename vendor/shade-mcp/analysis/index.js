// src/tools/analysis/alg-equiv.ts
import { z } from "zod";
import { readFileSync as readFileSync2, readdirSync as readdirSync2, existsSync as existsSync2 } from "fs";
import { join as join3, basename as basename2 } from "path";

// src/ai/provider.ts
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

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

// src/ai/provider.ts
var DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
var DEFAULT_OPENAI_MODEL = "gpt-5.2";
var DEFAULT_MAX_TOKENS = 2e3;
function aiClientOptions() {
  return { timeout: getConfig().aiTimeoutMs, maxRetries: 1 };
}
function readKeyFile(projectRoot, filename) {
  try {
    const key = readFileSync(join(projectRoot, filename), "utf-8").trim();
    return key || null;
  } catch {
    return null;
  }
}
function getAIProvider(options) {
  const model = getConfig().aiModel;
  const anthropicEnv = process.env.ANTHROPIC_API_KEY;
  if (anthropicEnv) {
    return { provider: "anthropic", apiKey: anthropicEnv, model: model ?? DEFAULT_ANTHROPIC_MODEL };
  }
  const openaiEnv = process.env.OPENAI_API_KEY;
  if (openaiEnv) {
    return { provider: "openai", apiKey: openaiEnv, model: model ?? DEFAULT_OPENAI_MODEL };
  }
  const anthropicKey = readKeyFile(options.projectRoot, ".anthropic");
  if (anthropicKey) {
    return { provider: "anthropic", apiKey: anthropicKey, model: model ?? DEFAULT_ANTHROPIC_MODEL };
  }
  const openaiKey = readKeyFile(options.projectRoot, ".openai");
  if (openaiKey) {
    return { provider: "openai", apiKey: openaiKey, model: model ?? DEFAULT_OPENAI_MODEL };
  }
  return null;
}
async function callAI(options) {
  if (options.ai.provider === "anthropic") {
    return callAnthropic(options);
  }
  return callOpenAI(options);
}
async function callAnthropic(options) {
  const client = new Anthropic({ apiKey: options.ai.apiKey, ...aiClientOptions() });
  const content = options.userContent.map((block) => {
    if (block.type === "image_url" && block.image_url) {
      const url = block.image_url.url;
      const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        return {
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] }
        };
      }
    }
    return { type: "text", text: block.text || "" };
  });
  let system = options.system;
  if (options.jsonMode) {
    system += "\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation.";
  }
  const response = await client.messages.create({
    model: options.ai.model,
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: "user", content }]
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : null;
}
async function callOpenAI(options) {
  const client = new OpenAI({ apiKey: options.ai.apiKey, ...aiClientOptions() });
  const messages = [
    { role: "system", content: options.system },
    { role: "user", content: options.userContent.map((block) => {
      if (block.type === "image_url" && block.image_url) {
        return { type: "image_url", image_url: { url: block.image_url.url } };
      }
      return { type: "text", text: block.text || "" };
    }) }
  ];
  const response = await client.chat.completions.create({
    model: options.ai.model,
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    messages,
    ...options.jsonMode ? { response_format: { type: "json_object" } } : {}
  });
  return response.choices[0]?.message?.content || null;
}
var NO_AI_KEY_MESSAGE = "No AI API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or create .anthropic/.openai file in project root.";

// src/tools/resolve-effects.ts
import { readdirSync, existsSync, statSync } from "fs";
import { join as join2, basename, resolve as resolve2, isAbsolute, sep } from "path";
function resolveEffectDir(effectId, effectsDir) {
  const dirName = basename(effectsDir) || "effect";
  if (effectId === dirName && (existsSync(join2(effectsDir, "definition.json")) || existsSync(join2(effectsDir, "definition.js")))) {
    return effectsDir;
  }
  const segments = effectId.split("/");
  if (isAbsolute(effectId) || segments.some((s) => s === ".." || s === ".")) {
    throw new Error(`Invalid effect id: ${effectId}`);
  }
  const root = resolve2(effectsDir);
  const target = resolve2(effectsDir, ...segments);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Invalid effect id: ${effectId}`);
  }
  return join2(effectsDir, ...segments);
}

// src/tools/analysis/alg-equiv.ts
var checkAlgEquivSchema = {
  effect_id: z.string().describe('Effect ID (e.g., "synth/noise")')
};
async function checkAlgEquiv(effectId) {
  const config = getConfig();
  const ai = getAIProvider({ projectRoot: config.projectRoot });
  if (!ai) return { status: "error", error: NO_AI_KEY_MESSAGE };
  const effectDir = resolveEffectDir(effectId, config.effectsDir);
  const glslDir = join3(effectDir, "glsl");
  const wgslDir = join3(effectDir, "wgsl");
  if (!existsSync2(glslDir) || !existsSync2(wgslDir)) {
    return { status: "error", error: "Missing glsl/ or wgsl/ directory" };
  }
  const glslFiles = readdirSync2(glslDir).filter((f) => f.endsWith(".glsl"));
  const wgslFiles = readdirSync2(wgslDir).filter((f) => f.endsWith(".wgsl"));
  const pairs = [];
  const unmatchedGlsl = [];
  const unmatchedWgsl = [];
  const wgslMap = new Map(wgslFiles.map((f) => [basename2(f, ".wgsl"), f]));
  for (const gf of glslFiles) {
    const name = basename2(gf, ".glsl");
    const wf = wgslMap.get(name);
    if (wf) {
      pairs.push({
        program: name,
        glsl: readFileSync2(join3(glslDir, gf), "utf-8"),
        wgsl: readFileSync2(join3(wgslDir, wf), "utf-8")
      });
      wgslMap.delete(name);
    } else {
      unmatchedGlsl.push(name);
    }
  }
  for (const name of wgslMap.keys()) {
    unmatchedWgsl.push(name);
  }
  if (pairs.length === 0) {
    return { status: "error", error: "No matching GLSL/WGSL pairs found" };
  }
  let defContext = "";
  try {
    const defPath = existsSync2(join3(effectDir, "definition.json")) ? join3(effectDir, "definition.json") : join3(effectDir, "definition.js");
    defContext = readFileSync2(defPath, "utf-8").slice(0, 1e3);
  } catch (err) {
    console.warn(`[shade-mcp] no definition context for ${effectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const results = [];
  for (const pair of pairs) {
    const response = await callAI({
      system: 'You are an expert shader programmer. Compare GLSL and WGSL shader implementations for algorithmic equivalence. Ignore syntax differences. Respond with JSON: {parity: "equivalent"|"divergent", confidence: "high"|"medium"|"low", notes: string, concerns: string[]}',
      userContent: [
        { type: "text", text: `Effect definition context:
${defContext}

GLSL (${pair.program}.glsl):
${pair.glsl}

WGSL (${pair.program}.wgsl):
${pair.wgsl}

Are these algorithmically equivalent?` }
      ],
      maxTokens: 1500,
      jsonMode: true,
      ai
    });
    let parsed = { parity: "error", notes: "Failed to analyze" };
    if (response) {
      try {
        parsed = JSON.parse(response);
      } catch {
        parsed = { parity: "error", notes: response };
      }
    }
    results.push({ ...parsed, program: pair.program });
  }
  const divergent = results.filter((r) => r.parity === "divergent").length;
  const status = divergent > 0 ? "divergent" : "ok";
  return {
    status,
    pairs: results,
    unmatchedGlsl: unmatchedGlsl.length > 0 ? unmatchedGlsl : void 0,
    unmatchedWgsl: unmatchedWgsl.length > 0 ? unmatchedWgsl : void 0,
    summary: `${results.length} pairs analyzed: ${results.length - divergent} equivalent, ${divergent} divergent`
  };
}

// src/tools/analysis/branching.ts
import { z as z2 } from "zod";
import { readFileSync as readFileSync3, readdirSync as readdirSync3, existsSync as existsSync3 } from "fs";
import { join as join4 } from "path";
var analyzeBranchingSchema = {
  effect_id: z2.string().describe('Effect ID (e.g., "synth/noise")'),
  backend: z2.enum(["webgl2", "webgpu"]).default("webgl2").describe("Which shader language to analyze")
};
async function analyzeBranching(effectId, backend) {
  const config = getConfig();
  const ai = getAIProvider({ projectRoot: config.projectRoot });
  if (!ai) return { status: "error", error: NO_AI_KEY_MESSAGE };
  const effectDir = resolveEffectDir(effectId, config.effectsDir);
  const shaderDir = join4(effectDir, backend === "webgpu" ? "wgsl" : "glsl");
  const ext = backend === "webgpu" ? ".wgsl" : ".glsl";
  if (!existsSync3(shaderDir)) {
    return { status: "error", error: `Shader directory not found: ${shaderDir}` };
  }
  const files = readdirSync3(shaderDir).filter((f) => f.endsWith(ext));
  if (files.length === 0) {
    return { status: "error", error: "No shader files found" };
  }
  const sources = files.map((f) => ({
    file: f,
    source: readFileSync3(join4(shaderDir, f), "utf-8")
  }));
  let defContext = "";
  try {
    const defPath = existsSync3(join4(effectDir, "definition.json")) ? join4(effectDir, "definition.json") : join4(effectDir, "definition.js");
    defContext = readFileSync3(defPath, "utf-8").slice(0, 1e3);
  } catch (err) {
    console.warn(`[shade-mcp] no definition context for ${effectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const shaderText = sources.map((s) => `--- ${s.file} ---
${s.source}`).join("\n\n");
  const response = await callAI({
    system: "You are a senior GPU shader developer. Identify UNNECESSARY branching in shader code that could be flattened for better GPU performance. Focus on simple if/else over uniforms, not complex algorithms. Severity: high (inner loops), medium (per-fragment), low (negligible). Respond with JSON: {shaders: [{file, opportunities: [{location, description, severity}], notes}], summary}",
    userContent: [
      { type: "text", text: `Effect definition:
${defContext}

Shader sources:
${shaderText}

Identify unnecessary branching.` }
    ],
    maxTokens: 3e3,
    jsonMode: true,
    ai
  });
  let parsed = { shaders: [], summary: "Failed to analyze" };
  if (response) {
    try {
      parsed = JSON.parse(response);
    } catch {
      parsed = { shaders: [], summary: response };
    }
  }
  const totalOpportunities = parsed.shaders?.reduce(
    (sum, s) => sum + (s.opportunities?.length || 0),
    0
  ) || 0;
  return {
    ...parsed,
    status: totalOpportunities >= 2 ? "warning" : "ok"
  };
}

// src/tools/browser/describe.ts
import { z as z4 } from "zod";

// src/harness/browser-session.ts
import { chromium } from "playwright";
import { resolve as resolve3 } from "path";

// src/harness/server-manager.ts
import { createServer } from "http";
import { createReadStream, existsSync as existsSync4, realpathSync } from "fs";
import { extname, join as join5, resolve as pathResolve, normalize, basename as basename3, relative, sep as sep2 } from "path";

// src/tools/browser/render.ts
import { z as z3 } from "zod";
var renderEffectFrameSchema = {
  effect_id: z3.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z3.string().optional().describe("CSV of effect IDs"),
  backend: z3.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend"),
  warmup_frames: z3.number().optional().default(10).describe("Frames to wait before capture"),
  capture_image: z3.boolean().optional().default(false).describe("Capture PNG data URI"),
  uniforms: z3.record(z3.string(), z3.number()).optional().describe("Uniform overrides"),
  time: z3.number().optional().describe("Pause and render at specific time value (seconds)"),
  resolution: z3.tuple([z3.number(), z3.number()]).optional().describe("Viewport resolution [width, height]")
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

// src/tools/browser/describe.ts
var describeEffectFrameSchema = {
  effect_id: z4.string().optional().describe('Single effect ID (e.g., "synth/noise")'),
  effects: z4.string().optional().describe("CSV of effect IDs"),
  prompt: z4.string().describe("Analysis prompt for the AI vision model"),
  backend: z4.enum(["webgl2", "webgpu"]).default("webgl2").describe("Rendering backend"),
  capture_image: z4.boolean().optional().default(false).describe("Return the rendered PNG data URI alongside the description")
};
async function describeEffectFrame(session, effectId, prompt, options = {}) {
  const config = getConfig();
  const ai = getAIProvider({ projectRoot: config.projectRoot });
  if (!ai) return { status: "error", error: NO_AI_KEY_MESSAGE };
  const renderResult = await renderEffectFrame(session, effectId, { captureImage: true });
  if (renderResult.status === "error" || !renderResult.frame?.image_uri) {
    const reason = renderResult.error;
    return { status: "error", error: reason ? `Failed to render frame: ${reason}` : "Failed to render frame" };
  }
  const vision = await callAI({
    system: "You are an expert shader effect analyzer. Describe shader visuals precisely. Respond with JSON: {description, tags, notes}",
    userContent: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: renderResult.frame.image_uri } }
    ],
    maxTokens: 1500,
    jsonMode: true,
    ai
  });
  let parsed = null;
  if (vision) {
    try {
      const raw = JSON.parse(vision);
      parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { description: typeof raw === "string" ? raw : vision, tags: [], notes: null };
    } catch {
      parsed = { description: vision, tags: [], notes: null };
    }
  }
  return {
    status: "ok",
    ...options.captureImage ? { frame: { image_uri: renderResult.frame.image_uri } } : {},
    vision: parsed
  };
}
export {
  analyzeBranching,
  checkAlgEquiv,
  describeEffectFrame
};
//# sourceMappingURL=index.js.map