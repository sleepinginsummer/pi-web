import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = path.join(import.meta.dirname, "project-directories.ts");
const atomicFileUrl = pathToFileURL(path.join(import.meta.dirname, "atomic-file.ts")).href;
const codingAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const lockfileUrl = import.meta.resolve("proper-lockfile");
const source = fs.readFileSync(sourcePath, "utf8")
  .replace('"./atomic-file"', JSON.stringify(atomicFileUrl))
  .replace('"@earendil-works/pi-coding-agent"', JSON.stringify(codingAgentUrl))
  .replace('"proper-lockfile"', JSON.stringify(lockfileUrl));
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  addProjectDirectory,
  readProjectDirectories,
  removeProjectDirectory,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

test("跨请求持久化、去重并移除项目目录", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-projects-"));
  const file = path.join(root, "pi-web-projects.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await addProjectDirectory("/workspace/b", file);
  await addProjectDirectory("/workspace/a", file);
  await addProjectDirectory("/workspace/b", file);
  assert.deepEqual(readProjectDirectories(file), ["/workspace/b", "/workspace/a"]);

  await removeProjectDirectory("/workspace/b", file);
  assert.deepEqual(readProjectDirectories(file), ["/workspace/a"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("并发目录更新在文件锁内基于最新快照计算", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-projects-concurrent-"));
  const file = path.join(root, "pi-web-projects.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await Promise.all([
    addProjectDirectory("/workspace/a", file),
    addProjectDirectory("/workspace/b", file),
    addProjectDirectory("/workspace/c", file),
  ]);
  assert.deepEqual(new Set(readProjectDirectories(file)), new Set(["/workspace/a", "/workspace/b", "/workspace/c"]));

  await Promise.all([
    removeProjectDirectory("/workspace/a", file),
    addProjectDirectory("/workspace/d", file),
  ]);
  assert.deepEqual(new Set(readProjectDirectories(file)), new Set(["/workspace/b", "/workspace/c", "/workspace/d"]));
});

test("配置文件损坏时返回空目录列表", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-projects-invalid-"));
  const file = path.join(root, "pi-web-projects.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "not json");
  assert.deepEqual(readProjectDirectories(file), []);
});
