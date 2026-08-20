import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { projectSessionTree } = await createJiti(import.meta.url).import("./session-tree-projection.ts");
const node = (id, children = []) => ({ entry: { id }, children });

function collectIds(nodes) {
  const ids = [];
  const stack = [...nodes];
  while (stack.length) {
    const current = stack.pop();
    ids.push(current.entry.id);
    stack.push(...current.children);
  }
  return ids;
}

test("线性链压缩到根和叶，并保留 compressed IDs", () => {
  const projected = projectSessionTree([node("root", [node("a", [node("b", [node("leaf")])])])]);
  assert.equal(projected[0].entry.id, "root");
  assert.equal(projected[0].children[0].entry.id, "leaf");
  assert.deepEqual(projected[0].children[0].compressedEntryIds, ["a", "b"]);
});

test("分叉点及每个叶子都保留", () => {
  const projected = projectSessionTree([node("root", [node("branch", [node("left"), node("right")])])]);
  assert.deepEqual(new Set(collectIds(projected)), new Set(["root", "branch", "left", "right"]));
});

test("超过 200 层时展平但不漏掉末端分叉与叶子", () => {
  let tail = node("split", [node("left"), node("right")]);
  for (let i = 219; i >= 0; i--) tail = node(`chain-${i}`, [tail]);
  const projected = projectSessionTree([node("root", [tail])]);
  const ids = new Set(collectIds(projected));
  assert.equal(ids.has("root"), true);
  assert.equal(ids.has("split"), true);
  assert.equal(ids.has("left"), true);
  assert.equal(ids.has("right"), true);
});
