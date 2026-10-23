import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { commitCustomProjectSelection } = await createJiti(import.meta.url).import("./custom-project-selection.ts");

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

for (const [existing, normalized] of [
  ["/workspace/pi-web", "/workspace/pi-web/"],
  ["D:\\share\\PI-WEB", "d:/share/pi-web"],
]) {
  test(`重复目录 ${normalized} 提示已存在且不写入、不切换工作区`, async () => {
    const calls = [];
    await assert.rejects(commitCustomProjectSelection(normalized, {
      existingProjects: [existing],
      validateProject: async () => ({ cwd: normalized }),
      addProject: async () => { calls.push("add"); return { cwd: normalized }; },
      installValidatedProject: () => calls.push("identity"),
      selectCwd: () => calls.push("select"),
      commitSelection: () => calls.push("commit"),
    }), { message: "已存在相同目录" });
    assert.deepEqual(calls, []);
  });
}
