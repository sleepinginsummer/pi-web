import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";

const { writePrivateFileAtomicSync, writePrivateFileCreateAtomicSync } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});

test("atomically creates a private file without replacing an existing target", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "session.jsonl");

  writePrivateFileCreateAtomicSync(destination, "first");
  assert.equal(fs.readFileSync(destination, "utf8"), "first");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }

  assert.throws(
    () => writePrivateFileCreateAtomicSync(destination, "second"),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "first");
  assert.deepEqual(fs.readdirSync(root), ["session.jsonl"]);
});

test("create-only 发布后临时链接清理失败仍返回成功", { concurrency: false }, (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "session.jsonl");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function failTemporaryCleanup(target) {
    if (String(target).endsWith(".tmp")) {
      const error = new Error("temporary cleanup failed");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlinkSync(target);
  };
  syncBuiltinESMExports();

  try {
    assert.doesNotThrow(() => writePrivateFileCreateAtomicSync(destination, "session"));
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(destination, "utf8"), "session");
});
