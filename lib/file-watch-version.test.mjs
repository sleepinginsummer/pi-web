import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getFileWatchVersion } = await jiti.import("./file-watch-version.ts");

test("读取未修改的文件不改变监听版本，同大小编辑和同路径替换会改变版本", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-file-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "preview.html");
  writeFileSync(file, "old!");
  const original = statSync(file);
  const initialVersion = getFileWatchVersion(original);
  readFileSync(file);
  assert.equal(getFileWatchVersion(statSync(file)), initialVersion);

  writeFileSync(file, "new!");
  utimesSync(file, original.atime, new Date(original.mtimeMs + 2000));
  const edited = statSync(file);
  assert.equal(edited.size, original.size);
  assert.notEqual(getFileWatchVersion(edited), initialVersion);

  const replacement = path.join(directory, "replacement.html");
  writeFileSync(replacement, "next");
  utimesSync(replacement, edited.atime, edited.mtime);
  renameSync(replacement, file);
  assert.notEqual(getFileWatchVersion(statSync(file)), getFileWatchVersion(edited));
});
