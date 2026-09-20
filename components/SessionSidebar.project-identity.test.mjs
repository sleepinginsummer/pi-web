import assert from "node:assert/strict";
import test from "node:test";
import { commitCustomProjectSelection } from "../lib/custom-project-selection.ts";

test("目录校验失败时不安装身份、不写入项目且不切换 cwd", async () => {
  const calls = [];

  await assert.rejects(
    commitCustomProjectSelection("/missing", {
      validateProject: async () => {
        calls.push("validate");
        throw new Error("directory not found");
      },
      installValidatedProject: () => calls.push("identity"),
      addProject: async () => {
        calls.push("add");
        return { cwd: "/missing" };
      },
      selectCwd: () => calls.push("select"),
      commitSelection: () => calls.push("commit"),
    }),
    /directory not found/,
  );

  assert.deepEqual(calls, ["validate"]);
});
