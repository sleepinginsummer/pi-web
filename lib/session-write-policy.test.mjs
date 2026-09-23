import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { canRunWithExternalSessionChange } = await createJiti(import.meta.url).import("./session-write-policy.ts");

test("运行中外部写入后仍能停止并查询状态", () => {
  for (const type of ["abort", "abort_bash", "abort_compaction", "get_state", "get_tools"]) {
    assert.equal(canRunWithExternalSessionChange(type), true, type);
  }
});

test("会延续旧 leaf 的命令与交互回答必须拒绝", () => {
  for (const type of ["prompt", "steer", "follow_up", "navigate_tree", "extension_ui_response", "set_tools", "reload"]) {
    assert.equal(canRunWithExternalSessionChange(type), false, type);
  }
});
