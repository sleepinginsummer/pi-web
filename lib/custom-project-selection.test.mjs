import assert from "node:assert/strict";
import test from "node:test";
import { commitCustomProjectSelection } from "./custom-project-selection.ts";

test("自定义目录按顺序安装项目身份并切换到服务端规范化 cwd", async () => {
  const calls = [];
  let selectedCwd = null;

  const cwd = await commitCustomProjectSelection("D:/share/project/pi-web", {
    validateProject: async (candidate) => {
      calls.push(["validate", candidate]);
      return {
        cwd: "D:\\share\\project\\pi-web",
        projectRoot: "D:\\share\\project\\pi-web",
        projectKey: "project-key",
      };
    },
    installValidatedProject: (project) => {
      calls.push(["identity", project.cwd]);
    },
    addProject: async (validatedCwd) => {
      calls.push(["add", validatedCwd]);
      return { cwd: "D:\\share\\project\\PI-WEB" };
    },
    selectCwd: (normalizedCwd) => {
      calls.push(["select", normalizedCwd]);
      selectedCwd = normalizedCwd;
    },
    commitSelection: (normalizedCwd) => {
      calls.push(["commit", normalizedCwd]);
    },
  });

  assert.equal(cwd, "D:\\share\\project\\PI-WEB");
  assert.equal(selectedCwd, cwd);
  assert.deepEqual(calls, [
    ["validate", "D:/share/project/pi-web"],
    ["add", "D:\\share\\project\\pi-web"],
    ["identity", "D:\\share\\project\\PI-WEB"],
    ["select", "D:\\share\\project\\PI-WEB"],
    ["commit", "D:\\share\\project\\PI-WEB"],
  ]);
});

test("项目目录写入失败时不切换 cwd", async () => {
  let selected = false;
  let identityInstalled = false;

  await assert.rejects(
    commitCustomProjectSelection("/workspace/pi-web", {
      validateProject: async () => ({ cwd: "/workspace/pi-web" }),
      installValidatedProject: () => {
        identityInstalled = true;
      },
      addProject: async () => {
        throw new Error("save failed");
      },
      selectCwd: () => {
        selected = true;
      },
      commitSelection: () => {
        selected = true;
      },
    }),
    /save failed/,
  );

  assert.equal(identityInstalled, false);
  assert.equal(selected, false);
});
