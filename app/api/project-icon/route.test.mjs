import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-project-icon-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>';

function createProject(name, allowed = true) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  if (allowed) allowFileRoot(directory);
  return directory;
}

function requestIcon(project) {
  const query = new URLSearchParams({ project });
  return GET(new NextRequest(`http://localhost/api/project-icon?${query}`));
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
