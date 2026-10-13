import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getRevealCommand, runRevealCommand } = await jiti.import("./file-reveal.ts");

const cases = [
  ["darwin", true, ["/tmp/project"]],
  ["darwin", false, ["-R", "/tmp/project/file.txt"]],
  ["win32", true, ["C:\\project"]],
  ["win32", false, ["/select,C:\\project\\file.txt"]],
  ["linux", true, ["/tmp/project"]],
  ["linux", false, ["/tmp/project"]],
];

test("按平台和文件类型生成正确的系统定位命令", () => {
  assert.deepEqual(getRevealCommand("/tmp/project", true, "darwin"), {
    command: "open",
    args: cases[0][2],
  });
  assert.deepEqual(getRevealCommand("/tmp/project/file.txt", false, "darwin"), {
    command: "open",
    args: cases[1][2],
  });
  assert.deepEqual(getRevealCommand("C:\\project", true, "win32"), {
    command: "explorer.exe",
    args: cases[2][2],
  });
  assert.deepEqual(getRevealCommand("C:\\project\\file.txt", false, "win32"), {
    command: "explorer.exe",
    args: cases[3][2],
  });
  assert.deepEqual(getRevealCommand("/tmp/project", true, "linux"), {
    command: "xdg-open",
    args: cases[4][2],
  });
  assert.deepEqual(getRevealCommand("/tmp/project/file.txt", false, "linux"), {
    command: "xdg-open",
    args: cases[5][2],
  });
});

test("Windows 定位将浏览器路径转换为原生路径，保留空格和 UNC 路径", () => {
  assert.deepEqual(getRevealCommand("D:/share/my project/docs", true, "win32").args, ["D:\\share\\my project\\docs"]);
  assert.deepEqual(getRevealCommand("D:/share/my project/AGENTS.md", false, "win32").args, ["/select,D:\\share\\my project\\AGENTS.md"]);
  assert.deepEqual(getRevealCommand("//nas/share/file.txt", false, "win32").args, ["/select,\\\\nas\\share\\file.txt"]);
});

test("Windows 定位启动成功后不以桌面程序的非零退出码判定失败", async () => {
  await runRevealCommand({ command: process.execPath, args: ["-e", "process.exit(1)"] }, "win32");
});

test("Windows 定位程序不存在时向调用方报告启动失败", async () => {
  await assert.rejects(
    runRevealCommand({ command: "pi-web-missing-file-manager", args: [] }, "win32"),
    { code: "ENOENT" },
  );
});

test("其它平台仍报告定位程序的非零退出码", async () => {
  await assert.rejects(
    runRevealCommand({ command: process.execPath, args: ["-e", "process.exit(1)"] }, "linux"),
    { code: 1 },
  );
});
