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
export {
  NO_AI_KEY_MESSAGE,
  aiClientOptions,
  callAI,
  getAIProvider
};
//# sourceMappingURL=provider.js.map