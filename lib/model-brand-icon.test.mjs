import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_MODEL_BRAND_ICONS_CONFIG,
  compileModelBrandIcons,
  mergeModelBrandIconsConfig,
  resolveModelBrandIcon,
} = await jiti.import("./model-brand-icon.ts");
const {
  USER_MODEL_ICONS_FILENAME,
  loadModelBrandIconsConfig,
  resetModelBrandIconsCacheForTests,
} = await jiti.import("./model-brand-icons-server.ts");

test("默认 JSON 规则可识别主流直连与中转桥接模型", () => {
  assert.equal(resolveModelBrandIcon({ provider: "anthropic", modelId: "claude-sonnet-4-5" })?.symbol, "anthropic");
  assert.equal(resolveModelBrandIcon({ provider: "openai", modelId: "gpt-5.2-codex" })?.symbol, "openai");
  assert.equal(resolveModelBrandIcon({ provider: "openai", modelId: "o3-mini" })?.symbol, "openai");
  assert.equal(resolveModelBrandIcon({ provider: "google", modelId: "gemini-2.5-pro" })?.symbol, "google");
  assert.equal(resolveModelBrandIcon({ provider: "deepseek", modelId: "deepseek-reasoner" })?.symbol, "deepseek");
  assert.equal(resolveModelBrandIcon({ provider: "qwen", modelId: "qwen3-coder-plus" })?.symbol, "qwen");
  assert.equal(resolveModelBrandIcon({ provider: "kimi-coding", modelId: "kimi-k2" })?.symbol, "kimi");
  assert.equal(resolveModelBrandIcon({ provider: "zhipu", modelId: "glm-4.5" })?.symbol, "zhipu");
  assert.equal(resolveModelBrandIcon({ provider: "minimax", modelId: "MiniMax-M1" })?.symbol, "minimax");
  assert.equal(resolveModelBrandIcon({ provider: "xai", modelId: "grok-4" })?.symbol, "grok");

  // 桥接渠道（如 magpie）下按展示名识别品牌图标
  assert.equal(
    resolveModelBrandIcon({ provider: "magpie", modelId: "opaque-1", name: "Claude Fable 5.2 · anyrouter.top" })?.symbol,
    "anthropic",
  );
  assert.equal(
    resolveModelBrandIcon({ provider: "magpie", modelId: "opaque-2", name: "DeepSeek-V4.1-Flash · WorkBuddy" })?.symbol,
    "deepseek",
  );
  assert.equal(
    resolveModelBrandIcon({ provider: "magpie", modelId: "opaque-3", name: "Gemini 4 Neon · Antigravity (local agy CLI)" })?.symbol,
    "google",
  );
  assert.equal(
    resolveModelBrandIcon({ provider: "magpie", modelId: "opaque-4", name: "GPT-6.1 Sol · sub2api" })?.symbol,
    "openai",
  );
});

test("展示名中 · 后的渠道名不干扰主模型厂商判断，未命中时再按渠道兜底", () => {
  // 模型是 Claude、渠道叫 deepseek365，必须优先认成 Claude
  assert.equal(
    resolveModelBrandIcon({ provider: "deepseek365", modelId: "claude-opus-5", name: "Claude Opus 5 · deepseek365" })?.symbol,
    "anthropic",
  );
  // 模型名无特征时，按 provider / 渠道前缀兜底
  assert.equal(
    resolveModelBrandIcon({ provider: "deepseek365", modelId: "v4-fast" })?.symbol,
    "deepseek",
  );
  assert.equal(
    resolveModelBrandIcon({ provider: "magpie", modelId: "unknown-1", name: "Custom Fast · deepseek365" })?.symbol,
    "deepseek",
  );
  // 完全未知的自定义模型与供应商返回 null，不乱猜
  assert.equal(
    resolveModelBrandIcon({ provider: "acme-internal", modelId: "alpha-1", name: "Alpha 1" }),
    null,
  );
});

test("用户自定义 JSON 规则优先于内置规则，且自动过滤非法正则与不安全图标地址", () => {
  const merged = mergeModelBrandIconsConfig(DEFAULT_MODEL_BRAND_ICONS_CONFIG, {
    icons: {
      nebula: { badge: "NB", vendor: "Nebula Labs" },
      unsafe: { src: "javascript:alert(1)", vendor: "Bad" },
      safeImg: { src: "/custom/logo.svg", color: true, vendor: "Custom Corp" },
    },
    modelRules: [
      { pattern: "[", icon: "nebula" }, // 非法正则应被忽略
      { pattern: "^nebula[-_]", icon: "nebula", vendor: "Nebula Labs" },
      { pattern: "^custom-corp-", icon: "safeImg" },
      { pattern: "claude", icon: "nebula", vendor: "Override Test" },
    ],
    providerRules: [
      { pattern: "^nebula-cloud", icon: "nebula" },
    ],
  });
  const compiled = compileModelBrandIcons(merged);

  assert.equal(merged.icons.unsafe, undefined);
  assert.deepEqual(resolveModelBrandIcon({ provider: "other", modelId: "nebula-1" }, compiled), {
    id: "nebula",
    badge: "NB",
    color: false,
    vendor: "Nebula Labs",
  });
  assert.deepEqual(resolveModelBrandIcon({ provider: "other", modelId: "custom-corp-pro" }, compiled), {
    id: "safeImg",
    src: "/custom/logo.svg",
    color: true,
    vendor: "Custom Corp",
  });
  // 用户规则前置，覆盖内置 claude 规则
  assert.equal(resolveModelBrandIcon({ provider: "anthropic", modelId: "claude-sonnet-4" }, compiled)?.id, "nebula");
  // 展示名命中内置规则时，高优先级的针对 modelId 的自定义规则仍必须优先命中
  const customById = mergeModelBrandIconsConfig(DEFAULT_MODEL_BRAND_ICONS_CONFIG, {
    icons: { custom42: { badge: "C42", vendor: "Custom 42" } },
    modelRules: [{ pattern: "^custom-42$", icon: "custom42", vendor: "Custom 42" }],
  });
  assert.deepEqual(
    resolveModelBrandIcon(
      { provider: "anthropic", modelId: "custom-42", name: "Claude Custom" },
      compileModelBrandIcons(customById),
    ),
    { id: "custom42", badge: "C42", color: false, vendor: "Custom 42" },
  );
});

test("服务端读取 <agentDir>/pi-web-model-icons.json 并在文件损坏时安全回退", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "pi-web-model-icons-"));
  resetModelBrandIconsCacheForTests();
  t.after(() => {
    resetModelBrandIconsCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 不存在时返回内置默认规则
  assert.equal(loadModelBrandIconsConfig(dir), DEFAULT_MODEL_BRAND_ICONS_CONFIG);

  // 写入合法自定义规则
  const filePath = join(dir, USER_MODEL_ICONS_FILENAME);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      icons: { nova: { badge: "NV", vendor: "Nova AI" } },
      modelRules: [{ pattern: "^nova-", icon: "nova" }],
    }),
  );
  const loaded = loadModelBrandIconsConfig(dir);
  const resolved = resolveModelBrandIcon({ provider: "custom", modelId: "nova-2" }, compileModelBrandIcons(loaded));
  assert.equal(resolved?.id, "nova");
  assert.equal(resolved?.badge, "NV");

  // 写入损坏 JSON 时安全回退，不抛错
  fs.writeFileSync(filePath, "{broken json");
  const fallback = loadModelBrandIconsConfig(dir);
  assert.equal(fallback, DEFAULT_MODEL_BRAND_ICONS_CONFIG);
});
