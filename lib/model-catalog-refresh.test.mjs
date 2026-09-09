import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { forceRefreshModelCatalog } = await jiti.import("./model-catalog-refresh.ts");

test("强制刷新会去重 provider 并绕过远程目录新鲜度窗口", async () => {
  let received;
  const signal = new AbortController().signal;

  await forceRefreshModelCatalog(["deepseek", " deepseek ", "custom", ""], {
    createRuntime: async () => ({
      refresh: async (options) => {
        received = options;
        return { aborted: false, errors: new Map() };
      },
    }),
    createSignal: () => signal,
  });

  assert.deepEqual(received.providers, ["deepseek", "custom"]);
  assert.equal(received.allowNetwork, true);
  assert.equal(received.force, true);
  assert.equal(received.signal, signal);
});

test("强制刷新不会吞掉 provider 刷新失败", async () => {
  await assert.rejects(
    forceRefreshModelCatalog(["deepseek"], {
      createRuntime: async () => ({
        refresh: async () => ({
          aborted: false,
          errors: new Map([["deepseek", new Error("HTTP 503")]]),
        }),
      }),
      createSignal: () => new AbortController().signal,
    }),
    /模型目录强制刷新失败/,
  );
});

test("强制刷新超时会明确失败", async () => {
  await assert.rejects(
    forceRefreshModelCatalog(["deepseek"], {
      createRuntime: async () => ({
        refresh: async () => ({ aborted: true, errors: new Map() }),
      }),
      createSignal: () => new AbortController().signal,
    }),
    /模型目录强制刷新超时/,
  );
});
