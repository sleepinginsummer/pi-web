import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { trimLogPrefix, LOG_TRIM_RATIO } = await jiti.import("./bounded-log.ts");

const charsOf = (entries) => entries.reduce((sum, line) => sum + line.length + 1, 0);

test("未超限时原样返回，不搬动数组", () => {
  const lines = ["a", "b"];
  assert.equal(trimLogPrefix(lines, charsOf(lines), 100, (l) => l.length + 1), charsOf(lines));
  assert.deepEqual(lines, ["a", "b"]);
});

test("超限时一次裁到低水位，留住的最后几行不丢", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`);
  const maxChars = 2000;
  let chars = charsOf(lines);
  chars = trimLogPrefix(lines, chars, maxChars, (l) => l.length + 1);

  assert.ok(chars <= maxChars * LOG_TRIM_RATIO, `裁到 ${chars}`);
  assert.ok(chars > 0);
  assert.equal(chars, charsOf(lines), "计数器与数组内容一致");
  assert.ok(lines.at(-1).startsWith("line-999"), "最新的行必须留着");

  // 裁剪后要隔很久才会再裁：一次追加不该立刻触发第二次搬运。
  const before = lines.length;
  lines.push("next");
  const after = trimLogPrefix(lines, charsOf(lines), maxChars, (l) => l.length + 1);
  assert.equal(lines.length, before + 1);
  assert.equal(after, charsOf(lines));
});

test("一条超大的输出也会留下自己，不会被裁成空数组", () => {
  const lines = ["short", "x".repeat(5000)];
  const chars = trimLogPrefix(lines, charsOf(lines), 1000, (l) => l.length + 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 5000);
  assert.equal(chars, 5001);
});
