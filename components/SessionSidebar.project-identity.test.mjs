import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { commitCustomProjectSelection } from "../lib/custom-project-selection.ts";

const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

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

test("目录选择通过统一入口校验后再提交身份", () => {
  assert.match(source, /onSelect=\{\(path\) => void commitCustomPath\(path\)\}/);
  assert.match(source, /await commitCustomProjectSelection\(path, \{/);
  assert.match(source, /validateProject: async \(candidate\) => \{[\s\S]*?fetch\("\/api\/cwd\/validate"/);
  assert.match(source, /commitSelection: \(cwd\) => \{\s*saveLastCustomCwd\(cwd\)/);
});
