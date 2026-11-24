import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const { FastSessionSetting } = await createJiti(import.meta.url).import("./fast-session-setting.ts");
const { withSessionReloadWriteGuard } = await createJiti(import.meta.url).import("./session-reload-write-guard.ts");
const source = ts.createSourceFile("rpc-manager.ts", readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function findReload(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "reloadRuntime") return node;
  return ts.forEachChild(node, findReload);
}
const body = findReload(source).body.getText(source);
const script = new Script(ts.transpileModule(`(async function(options) ${body})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);

for (const failFirst of [false, true]) test(`重载按请求顺序读取并安装能力，旧请求不能装回 Priority：failFirst=${failFirst}`, async () => {
  let enabled = true;
  const reads = [];
  const installed = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const catalog = { id: "primary", provider: "synthetic", api: "openai-responses", reasoning: true,
    samplingParams: { service_tier: "default" } };
  let current = { ...catalog, samplingParams: { service_tier: "priority" } };
  let runtime = { generation: "initial", catalogModel: () => catalog, fastModels: new Set(["synthetic/primary"]) };
  let calls = 0;
  let trustSyncs = 0;
  const host = {
    runtimeReloadQueue: Promise.resolve(), runtimeReloadsInProgress: 0,
    assertModelPreferenceWritable() {}, extensionStatuses: new Map(),
    resetExtensionWidgetsForReload() {}, syncProjectTrust() { trustSyncs += 1; },
    inner: { sessionManager: {}, reload: async options => {
      if (++calls === 1) { entered(); await gate; if (failFirst) throw new Error("模拟第一次重载失败"); }
      assert.equal(trustSyncs, calls, "项目信任必须在 SDK 资源加载前同步");
      await options?.beforeSessionStart?.();
    } },
    installFastRuntimeSnapshot: (fastModels, generation) => {
      installed.push(fastModels.has("synthetic/primary"));
      runtime = { ...runtime, generation, fastModels };
    },
  };
  const context = createContext({ Promise, withSessionReloadWriteGuard, readModelsConfigSnapshot: async () => {
    reads.push(enabled);
    return { generation: enabled ? "enabled" : "disabled", fastModels: new Set(enabled ? ["synthetic/primary"] : []) };
  } });
  const reload = script.runInContext(context).bind(host);
  const first = reload();
  await reached;
  enabled = false;
  const second = reload();
  const readsWhileFirstBlocked = [...reads];
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status === "fulfilled", !failFirst);
  assert.equal(results[1].status, "fulfilled", "前一次失败不得阻塞后续重载");
  assert.deepEqual(readsWhileFirstBlocked, [true], "第二次快照读取必须等第一次完整提交");
  assert.deepEqual(reads, [true, false]);
  assert.deepEqual(installed, failFirst ? [false] : [true, false]);
  assert.equal(host.runtimeReloadsInProgress, 0);
  const setting = new FastSessionSetting({
    entries: () => [{ type: "custom", customType: "pi-web-fast-mode-state", data: { enabled: true } }],
    currentModel: () => current, runtimeSnapshot: () => runtime,
    setModel: async (model, beforeWrite) => { beforeWrite(); current = model; },
    appendState() {},
  });
  await setting.restoreAfterRuntimeReset();
  assert.equal(setting.available, false);
  assert.equal(current.samplingParams.service_tier, "default", "最终关闭的 Fast 能力不能被旧快照装回 Priority");
});
