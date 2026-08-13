// src/formats/index.ts
import { existsSync, readFileSync as readFileSync2 } from "fs";
import { join } from "path";

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
  const jsonPath = join(effectDir, "definition.json");
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync2(jsonPath, "utf-8"));
    return parseDefinitionJson(raw, effectDir);
  }
  const jsPath = join(effectDir, "definition.js");
  if (existsSync(jsPath)) {
    return parseDefinitionJs(jsPath, effectDir);
  }
  throw new Error(`No definition.json or definition.js found in ${effectDir}`);
}
export {
  loadEffectDefinition,
  parseDefinitionJs,
  parseDefinitionJson
};
//# sourceMappingURL=index.js.map