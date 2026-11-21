import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), "rename");
  assert.equal(parseUploadConflictStrategy("merge"), null);
});

test("renames a clashing upload instead of overwriting it", async (t) => {
  const { uniqueUploadName } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-rename-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 空目录里保留原名。
  assert.equal(uniqueUploadName(root, "report.pdf"), "report.pdf");

  fs.writeFileSync(path.join(root, "report.pdf"), "one");
  assert.equal(uniqueUploadName(root, "report.pdf"), "report (1).pdf");

  fs.writeFileSync(path.join(root, "report (1).pdf"), "two");
  assert.equal(uniqueUploadName(root, "report.pdf"), "report (2).pdf");

  // 没有扩展名、以及 `.` 开头的名字（整串当基名，不会被拆成 "." + "gitignore"）。
  assert.equal(uniqueUploadName(root, "README"), "README");
  fs.writeFileSync(path.join(root, "README"), "readme");
  assert.equal(uniqueUploadName(root, "README"), "README (1)");
  assert.equal(uniqueUploadName(root, ".gitignore"), ".gitignore");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored");
  assert.equal(uniqueUploadName(root, ".gitignore"), ".gitignore (1)");

  // 目标位置上即使是目录也算被占用（上传不会写进目录里）。
  fs.mkdirSync(path.join(root, "notes"));
  assert.equal(uniqueUploadName(root, "notes"), "notes (1)");
  assert.equal(uniqueUploadName(root, "notes.txt"), "notes.txt");
});
