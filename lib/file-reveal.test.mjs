import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getRevealCommand } = await jiti.import("./file-reveal.ts");

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
