import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Allowed roots come from the session catalogue, so keep the user's real agent
// directory out of this: the upload route only needs the roots it is given.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHome = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);

test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { encodeFilePathForApi } = await jiti.import("../../../lib/file-paths.ts");
const { NextRequest } = await jiti.import("next/server");

function upload(directory, files, conflict) {
  const encoded = encodeFilePathForApi(directory);
  const body = new FormData();
  for (const [name, content] of Object.entries(files)) {
    body.append("files", new File([content], name, { type: "text/plain" }));
  }
  const request = new NextRequest(`http://localhost/api/files/${encoded}?type=upload&conflict=${conflict}`, {
    method: "POST",
    headers: { host: "localhost" },
    body,
  });
  return POST(request, { params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }) });
}

function listDirectory(directory) {
  const encoded = encodeFilePathForApi(directory);
  return GET(
    new NextRequest(`http://localhost/api/files/${encoded}?type=list`, { headers: { host: "localhost" } }),
    { params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }) },
  );
}

test("rename never overwrites and reports the absolute path", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "rename-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFileRoot(root);
  fs.writeFileSync(path.join(root, "report.pdf"), "original");

  const response = await upload(root, { "report.pdf": "new", "notes.txt": "notes" }, "rename");
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.deepEqual(data.uploaded, ["report (1).pdf", "notes.txt"]);
  assert.deepEqual(data.paths, [path.join(root, "report (1).pdf"), path.join(root, "notes.txt")]);
  assert.equal(fs.readFileSync(path.join(root, "report.pdf"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(root, "report (1).pdf"), "utf8"), "new");

  const again = await upload(root, { "report.pdf": "third" }, "rename");
  assert.deepEqual((await again.json()).uploaded, ["report (2).pdf"]);
});

test("skip still reports the untouched file and writes nothing", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "skip-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFileRoot(root);
  fs.writeFileSync(path.join(root, "keep.txt"), "keep");

  const response = await upload(root, { "keep.txt": "replaced" }, "skip");
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.skipped, ["keep.txt"]);
  assert.deepEqual(data.paths, []);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("the downloads folder becomes uploadable and readable without an explicit root", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-")));
  const downloads = path.join(home, "Downloads");
  fs.mkdirSync(downloads);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;

  // 没有任何会话 cwd 指向这里，上传前它不在允许根里。
  const denied = await listDirectory(downloads);
  assert.equal(denied.status, 403);

  const response = await upload(downloads, { "chat.txt": "hello" }, "rename");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.paths, [path.join(downloads, "chat.txt")]);
  assert.equal(fs.readFileSync(path.join(downloads, "chat.txt"), "utf8"), "hello");

  // 允许根补上之后，聊天里的路径能列出来（预览依赖这一步）。
  const listed = await listDirectory(downloads);
  assert.equal(listed.status, 200);
  const entries = (await listed.json()).entries ?? [];
  assert.ok(entries.some((entry) => (entry.name ?? entry.path) === "chat.txt"), "chat.txt should be listed");
});

test("a missing downloads folder is created by the first upload", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-missing-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const downloads = path.join(home, "Downloads");
  assert.equal(fs.existsSync(downloads), false, "the fixture must start without Downloads");

  const response = await upload(downloads, { "first.txt": "hello" }, "rename");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.paths, [path.join(downloads, "first.txt")]);
  assert.equal(fs.readFileSync(path.join(downloads, "first.txt"), "utf8"), "hello");
});

test("only a successful rename upload opens the downloads folder", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-gate-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const downloads = path.join(home, "Downloads");
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, "keep.txt"), "keep");

  // 方向一：别的策略不给写，也不放开读取。
  assert.equal((await upload(downloads, { "keep.txt": "x" }, "skip")).status, 403);
  assert.equal((await upload(downloads, { "keep.txt": "x" }, "overwrite")).status, 403);
  assert.equal((await upload(downloads, { "keep.txt": "x" }, "error")).status, 403);
  assert.equal((await listDirectory(downloads)).status, 403);

  // 方向二：upload-check 也不能先把目录放开。
  const checked = await POST(
    new NextRequest(`http://localhost/api/files/${encodeFilePathForApi(downloads)}?type=upload-check`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ fileNames: ["keep.txt"] }),
    }),
    { params: Promise.resolve({ path: encodeFilePathForApi(downloads).split("/").map(decodeURIComponent) }) },
  );
  assert.equal(checked.status, 403);
  assert.equal((await listDirectory(downloads)).status, 403);

  // 方向三：rename 上传本身失败（文件名非法）也不算写成功。
  const rejected = await upload(downloads, { "../escape.txt": "x" }, "rename");
  assert.equal(rejected.status, 400);
  assert.equal((await listDirectory(downloads)).status, 403);

  // 真的写进去之后才放开读取。
  const written = await upload(downloads, { "chat.txt": "hello" }, "rename");
  assert.equal(written.status, 200);
  assert.equal((await listDirectory(downloads)).status, 200);
});

test("rename writes beside a same-named directory instead of failing", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "dir-conflict-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFileRoot(root);
  fs.mkdirSync(path.join(root, "notes"));
  fs.symlinkSync(path.join(root, "notes"), path.join(root, "link"));

  const response = await upload(root, { notes: "dir name" }, "rename");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.errors, []);
  assert.deepEqual(data.uploaded, ["notes (1)"]);
  assert.equal(fs.readFileSync(path.join(root, "notes (1)"), "utf8"), "dir name");
  assert.equal(fs.statSync(path.join(root, "notes")).isDirectory(), true);

  const link = await upload(root, { link: "symlink name" }, "rename");
  assert.deepEqual((await link.json()).uploaded, ["link (1)"]);

  // 覆盖策略仍然拒绝替换目录与符号链接。
  const refused = await upload(root, { notes: "nope" }, "overwrite");
  assert.equal(refused.status, 207);
  assert.match((await refused.json()).errors[0].error, /directory or symbolic link/);
});

test("a granted downloads root still refuses every strategy but rename", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-overwrite-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const downloads = path.join(home, "Downloads");
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, "original.txt"), "keep me");

  // 先正常传一个文件，读权限随之授予。
  assert.equal((await upload(downloads, { "chat.txt": "hello" }, "rename")).status, 200);
  assert.equal((await listDirectory(downloads)).status, 200);

  // 授权是为了预览，不是让人用别的策略替换目录里原有的文件。
  for (const strategy of ["overwrite", "skip", "error"]) {
    const response = await upload(downloads, { "original.txt": "replaced" }, strategy);
    assert.equal(response.status, 403, `${strategy} should stay refused`);
  }
  assert.equal(fs.readFileSync(path.join(downloads, "original.txt"), "utf8"), "keep me");
});
