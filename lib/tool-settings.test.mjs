import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  effectiveReviewConfigPath,
  findReviewPackageDir,
  parseToolModel,
  readReviewToolSettings,
  resolveLocalPackageSource,
  reviewConfigPath,
  writeReviewToolSettings,
} = await jiti.import("./tool-settings.ts");

const SYSTEM_PROMPT = "你是一名务实的代码审查者。";

async function tempAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

async function writeConfig(agentDir, config) {
  const path = reviewConfigPath(agentDir);
  await mkdir(join(agentDir, "pi-session-review"), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

/** 一个 git 安装形态的扩展包：模板目录 + 包名。 */
async function installPackage(agentDir) {
  const dir = join(agentDir, "git", "github.com", "owner", "pi-session-review");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pi-session-review" }));
  await writeFile(join(dir, "config.example.json"), JSON.stringify({
    run_with_model: "",
    thinking_level: "medium",
    system_prompt: SYSTEM_PROMPT,
  }));
  return dir;
}

test("reads the extension's own config, with an empty model meaning follow-the-session", async (t) => {
  const agentDir = await tempAgentDir(t);
  await writeConfig(agentDir, { run_with_model: "magpie/codex/gpt-6.2-sol", thinking_level: "high", system_prompt: SYSTEM_PROMPT });

  const settings = readReviewToolSettings(agentDir);
  assert.equal(settings.configured, true);
  assert.equal(settings.installed, false);
  // 模型按第一个 "/" 切分：provider 里可以有 "/" 的模型名（这里是 provider magpie、模型 codex/gpt-6.2-sol）。
  assert.deepEqual(settings.model, { provider: "magpie", modelId: "codex/gpt-6.2-sol" });
  assert.equal(settings.thinkingLevel, "high");
  assert.equal(settings.configPath, reviewConfigPath(agentDir));

  await writeConfig(agentDir, { run_with_model: "", thinking_level: "low", system_prompt: SYSTEM_PROMPT });
  assert.equal(readReviewToolSettings(agentDir).model, null, "空字符串表示跟随当前会话模型");

  assert.equal(parseToolModel(undefined), null);
  assert.equal(parseToolModel("/model"), null);
  assert.equal(parseToolModel("provider/"), null);
});

test("saving keeps the system prompt and every field it does not own", async (t) => {
  const agentDir = await tempAgentDir(t);
  const path = await writeConfig(agentDir, {
    run_with_model: "magpie/codex/gpt-6.2-sol",
    thinking_level: "high",
    system_prompt: SYSTEM_PROMPT,
    unknownField: { keep: true },
  });

  const saved = await writeReviewToolSettings({ model: null, thinkingLevel: "low" }, agentDir);
  assert.equal(saved.model, null);
  assert.equal(saved.thinkingLevel, "low");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.system_prompt, SYSTEM_PROMPT);
  assert.deepEqual(stored.unknownField, { keep: true });
  assert.equal(stored.run_with_model, "");
  assert.equal(stored.thinking_level, "low");
});

test("refuses a thinking level or model the extension would reject", async (t) => {
  const agentDir = await tempAgentDir(t);
  await writeConfig(agentDir, { run_with_model: "", thinking_level: "high", system_prompt: SYSTEM_PROMPT });

  await assert.rejects(() => writeReviewToolSettings({ model: null, thinkingLevel: "auto" }, agentDir), /thinkingLevel/);
  await assert.rejects(
    () => writeReviewToolSettings({ model: { provider: "a/b", modelId: "c" }, thinkingLevel: "high" }, agentDir),
    /provider\/modelId/,
  );
  await assert.rejects(
    () => writeReviewToolSettings({ model: { provider: "a", modelId: "" }, thinkingLevel: "high" }, agentDir),
    /provider\/modelId/,
  );
  // 扩展按 "/" 切分并拒绝结尾是 "/" 的值，这里就必须拦住，不能让一份跑不起来的配置写盘。
  await assert.rejects(
    () => writeReviewToolSettings({ model: { provider: "foo", modelId: "bar/" }, thinkingLevel: "high" }, agentDir),
    /provider\/modelId/,
  );
  // 失败的写入不能改动原文件。
  const stored = JSON.parse(await readFile(reviewConfigPath(agentDir), "utf8"));
  assert.equal(stored.thinking_level, "high");
});

test("a missing config is created from the extension's template", async (t) => {
  const agentDir = await tempAgentDir(t);
  const packageDir = await installPackage(agentDir);
  assert.equal(findReviewPackageDir(agentDir), packageDir);
  assert.equal(readReviewToolSettings(agentDir).configured, false);
  assert.equal(readReviewToolSettings(agentDir).installed, true);

  const saved = await writeReviewToolSettings({ model: { provider: "anthropic", modelId: "claude-sonnet-4" }, thinkingLevel: "medium" }, agentDir);
  assert.equal(saved.configured, true);
  assert.deepEqual(saved.model, { provider: "anthropic", modelId: "claude-sonnet-4" });
  const stored = JSON.parse(await readFile(reviewConfigPath(agentDir), "utf8"));
  assert.equal(stored.system_prompt, SYSTEM_PROMPT, "模板里的系统提示词被沿用");
});


test("reads and seeds from the config the extension actually uses", async (t) => {
  const agentDir = await tempAgentDir(t);
  const packageDir = await installPackage(agentDir);
  const customPrompt = "你只挑阻塞级问题。";
  await writeFile(join(packageDir, "config.json"), JSON.stringify({
    run_with_model: "magpie/codex/gpt-6.2-sol",
    thinking_level: "high",
    system_prompt: customPrompt,
  }));

  const settings = readReviewToolSettings(agentDir);
  assert.equal(settings.configured, false);
  assert.equal(settings.effectiveConfigPath, join(packageDir, "config.json"));
  assert.deepEqual(settings.model, { provider: "magpie", modelId: "codex/gpt-6.2-sol" }, "显示扩展正在用的模型，而不是空默认");
  assert.equal(settings.thinkingLevel, "high");

  // 只改强度：模型和自定义提示词都保留，用户配置以正在生效的那份为底稿。
  await writeReviewToolSettings({ model: settings.model, thinkingLevel: "low" }, agentDir);
  const stored = JSON.parse(await readFile(reviewConfigPath(agentDir), "utf8"));
  assert.equal(stored.run_with_model, "magpie/codex/gpt-6.2-sol");
  assert.equal(stored.thinking_level, "low");
  assert.equal(stored.system_prompt, customPrompt);
  assert.equal(effectiveReviewConfigPath(agentDir), reviewConfigPath(agentDir), "用户配置优先");
});

test("finds local packages stored the way pi stores them", async (t) => {
  const agentDir = await tempAgentDir(t);
  // pi 把本地包装成相对 agentDir 的路径（不带 "./"），也有手写的 ~/ 形式。
  assert.equal(resolveLocalPackageSource("extensions/review", agentDir), join(agentDir, "extensions/review"));
  assert.equal(resolveLocalPackageSource("~/pkgs/review", agentDir), join(homedir(), "pkgs/review"));
  assert.equal(resolveLocalPackageSource("../sibling/review", agentDir), join(agentDir, "..", "sibling", "review"));
  assert.equal(resolveLocalPackageSource("npm:pi-session-review", agentDir), null);
  assert.equal(resolveLocalPackageSource("git:github.com/a/b", agentDir), null);
  assert.equal(resolveLocalPackageSource("https://example.com/b.git", agentDir), null);

  const localDir = join(agentDir, "extensions", "review");
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, "package.json"), JSON.stringify({ name: "pi-session-review" }));
  await writeFile(join(localDir, "config.example.json"), JSON.stringify({
    run_with_model: "", thinking_level: "medium", system_prompt: SYSTEM_PROMPT,
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["extensions/review"] }));

  assert.equal(findReviewPackageDir(agentDir), localDir);
  const settings = readReviewToolSettings(agentDir);
  assert.equal(settings.installed, true, "已装的本地扩展不能显示成未安装");
  const saved = await writeReviewToolSettings({ model: null, thinkingLevel: "low" }, agentDir);
  assert.equal(saved.configured, true);
});
test("without a template nor a config, saving fails instead of writing an unusable file", async (t) => {
  const agentDir = await tempAgentDir(t);
  await assert.rejects(
    () => writeReviewToolSettings({ model: null, thinkingLevel: "medium" }, agentDir),
    /配置模板/,
  );
});

test("a damaged config is reported, not silently replaced", async (t) => {
  const agentDir = await tempAgentDir(t);
  const path = reviewConfigPath(agentDir);
  await mkdir(join(agentDir, "pi-session-review"), { recursive: true });
  await writeFile(path, "{ not json");
  assert.throws(() => readReviewToolSettings(agentDir), /无法解析/);
  await assert.rejects(() => writeReviewToolSettings({ model: null, thinkingLevel: "high" }, agentDir), /无法解析/);
  assert.equal(await readFile(path, "utf8"), "{ not json", "原文件保持原样");
});
