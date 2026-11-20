import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sameJson } = await jiti.import("./usePolledJson.ts");
const source = await readFile(new URL("./usePolledJson.ts", import.meta.url), "utf8");

test("内容相同的轮询快照保持同一个引用", () => {
  const previous = { servers: [{ id: "a", status: "running" }] };
  const identical = { servers: [{ id: "a", status: "running" }] };
  assert.equal(sameJson(previous, previous), true);
  assert.equal(sameJson(previous, identical), true, "结构相同就算没变，下游不用重渲染");
  assert.equal(sameJson(previous, { servers: [{ id: "a", status: "stopped" }] }), false);
  assert.equal(sameJson(null, previous), false);
  assert.equal(sameJson(undefined, undefined), true);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(sameJson(cyclic, cyclic), true, "同一个对象直接命中");
  assert.equal(sameJson(cyclic, {}), false, "没法序列化时保守认为有变化");
});

test("轮询只在可见时发请求，回前台与定时器共用一次请求", () => {
  assert.match(source, /if \(document\.visibilityState === "visible"\) await load\(\);/);
  assert.match(source, /if \(inFlight\) return inFlight;/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisible\);/);
  // 数据换新前先比内容：相同就返回旧对象。
  assert.match(source, /setData\(\(current\) => \(sameJson\(current, next\) \? current : next\)\);/);
});
