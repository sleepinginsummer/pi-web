import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { startRpcSession } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");

for (const fallback of [false, true]) for (const owner of ["a", "b"]) test(`${fallback ? "SDK 兜底" : "配置默认"}选中 B 时核对 ${owner.toUpperCase()} 的自动推荐`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-recommendation-owner-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let wrapper;
  t.after(async () => {
    await wrapper?.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { synthetic: {
    baseUrl: "https://synthetic.invalid", api: "anthropic-messages", apiKey: "synthetic-not-a-key",
    models: (fallback ? ["b"] : ["a", "b"]).map((id) => ({ id, reasoning: true, contextWindow: 32000, maxTokens: 1024 })),
  } } }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    ...(!fallback ? { defaultProvider: "synthetic", defaultModel: "b", enabledModels: ["synthetic/*"] } : {}),
    defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: false },
  }));
  ({ session: wrapper } = await startRpcSession(`__new__${root}`, "", cwd, {
    toolNames: [], thinkingLevel: "high", thinkingLevelExplicit: false,
    thinkingLevelModel: { provider: "synthetic", modelId: owner },
  }));
  assert.equal(wrapper.inner.model.provider, "synthetic");
  assert.equal(wrapper.inner.model.id, "b");
  assert.equal(wrapper.inner.thinkingLevel, owner === "b" ? "high" : "low");
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultThinkingLevel, "low");
});
