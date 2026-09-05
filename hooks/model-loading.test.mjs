import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
const { fetchModelsData, retryModelLoad } = await jiti.import("./useModelSelection.ts");

test("模型接口优先展示服务端错误，并为非 JSON 响应补充 HTTP 状态", async (t) => {
  const responses = [
    Response.json({ error: "Access denied" }, { status: 403 }),
    new Response("Unavailable", { status: 503 }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());

  await assert.rejects(fetchModelsData("/project"), /Access denied/);
  await assert.rejects(fetchModelsData("/project"), /Failed to load models \(HTTP 503\)/);
});

test("模型加载失败按固定间隔有限重试，恢复后立即停止", async () => {
  const delays = [];
  let attempts = 0;
  const controller = new AbortController();

  await retryModelLoad(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("temporary failure");
  }, controller.signal, async (milliseconds) => { delays.push(milliseconds); });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2_000, 5_000]);
});

test("模型加载重试达到上限后停止", async () => {
  const delays = [];
  let attempts = 0;
  const controller = new AbortController();

  await retryModelLoad(async () => {
    attempts += 1;
    throw new Error("unavailable");
  }, controller.signal, async (milliseconds) => { delays.push(milliseconds); });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [2_000, 5_000, 10_000]);
});

test("取消模型加载后不再重试", async () => {
  const controller = new AbortController();
  let attempts = 0;

  await retryModelLoad(async () => {
    attempts += 1;
    controller.abort();
    throw controller.signal.reason;
  }, controller.signal, async () => assert.fail("取消后不应等待"));

  assert.equal(attempts, 1);
});
