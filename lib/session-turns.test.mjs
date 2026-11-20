import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { countTurnsBefore, turnAnchorShape } = await jiti.import("./session-turns.ts");

const user = (id, parentId) => ({ id, parentId, type: "message", message: { role: "user" } });
const assistant = (id, parentId) => ({ id, parentId, type: "message", message: { role: "assistant" } });
const byIdOf = (entries) => new Map(entries.map((entry) => [entry.id, entry]));

test("页面上方的轮次数按活动分支算，不因分页丢失", () => {
  const entries = [
    user("u1", null), assistant("a1", "u1"),
    user("u2", "a1"), assistant("a2", "u2"),
    user("u3", "a2"), assistant("a3", "u3"),
  ];
  const byId = byIdOf(entries);
  // 页面从 u3 开始：上面还有两轮（u1、u2）。
  assert.equal(countTurnsBefore(byId, [entries[4], entries[5]], turnAnchorShape), 2);
  // 页面从头开始：上面没有轮次。
  assert.equal(countTurnsBefore(byId, entries, turnAnchorShape), 0);
  // 空页面不炸。
  assert.equal(countTurnsBefore(byId, [], turnAnchorShape), 0);
});

test("父链成环时不会卡死", () => {
  // 手改坏的文件可能让自己当自己的祖先。
  const cyclic = [user("u1", "a1"), assistant("a1", "u1")];
  const result = countTurnsBefore(byIdOf(cyclic), [assistant("u2", "a1")], turnAnchorShape);
  assert.equal(typeof result, "number");
  assert.ok(Number.isFinite(result));
});
