import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-icon-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false, tryNative: false });
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>';

function createProject(name, allowed = true) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  if (allowed) allowFileRoot(directory);
  return directory;
}

function requestIcon(project, handle = GET) {
  const query = new URLSearchParams({ project });
  return handle(new NextRequest(`http://localhost/api/project-icon?${query}`));
}

test("按候选顺序返回项目图标，SVG 响应受沙盒限制", async () => {
  const project = createProject("repo with spaces");
  fs.mkdirSync(path.join(project, "app"));
  fs.writeFileSync(path.join(project, "app", "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  const appIcon = await requestIcon(project);
  assert.equal(appIcon.status, 200);
  assert.equal(appIcon.headers.get("content-type"), "image/x-icon");

  fs.writeFileSync(path.join(project, "favicon.svg"), svg);
  const rootIcon = await requestIcon(project);
  assert.equal(rootIcon.headers.get("content-type"), "image/svg+xml");
  assert.match(rootIcon.headers.get("content-security-policy"), /^sandbox;/);
  assert.equal(await rootIcon.text(), svg);
});

test("目录未授权、目录没有图标或候选文件指向项目外时不返回图片", async () => {
  const denied = createProject("denied", false);
  fs.writeFileSync(path.join(denied, "favicon.svg"), svg);
  assert.equal((await requestIcon(denied)).status, 204);

  const empty = createProject("empty");
  assert.equal((await requestIcon(empty)).status, 204);

  const target = createProject("other-allowed-project");
  fs.writeFileSync(path.join(target, "favicon.svg"), svg);
  fs.symlinkSync(target, path.join(empty, "public"), "junction");
  assert.equal((await requestIcon(empty)).status, 204);
});

test("项目内目录链接仍可以提供图标", async () => {
  const project = createProject("internal-link");
  const target = path.join(project, "icons");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "favicon.svg"), svg);
  fs.symlinkSync(target, path.join(project, "public"), "junction");
  const response = await requestIcon(project);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), svg);
});

test("打开的文件与已校验的图标身份不一致时拒绝读取", async (t) => {
  const project = createProject("descriptor-check");
  const icon = path.join(project, "favicon.svg");
  fs.writeFileSync(icon, svg);
  const expected = fs.lstatSync(icon, { bigint: true });
  const realFstat = fs.fstatSync;
  const readSync = fs.readSync;
  let rejectedFd;
  let readRejectedFd = false;
  t.mock.method(fs, "fstatSync", (fd, options) => {
    const stats = realFstat(fd, options);
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) return stats;
    rejectedFd = fd;
    return Object.assign(stats, { ino: stats.ino + 1n });
  });
  t.mock.method(fs, "readSync", (fd, ...args) => {
    if (fd === rejectedFd) readRejectedFd = true;
    return readSync(fd, ...args);
  });
  syncBuiltinESMExports();
  try {
    // 重新加载路由，让 Jiti 在替换 fs 绑定后重新读取它们。
    const { GET: getIconWithDescriptorCheck } = await jiti.import("./route.ts");
    assert.equal((await requestIcon(project, getIconWithDescriptorCheck)).status, 204);
    assert.notEqual(rejectedFd, undefined);
    assert.equal(readRejectedFd, false, "必须先校验描述符，才可读取图标的字节");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
