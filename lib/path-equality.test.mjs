import assert from "node:assert/strict";
import test from "node:test";
import { portablePathIdentity, samePortablePath } from "./path-equality.ts";

test("Windows drive paths ignore case, separators, dot segments and trailing separators", () => {
  assert.equal(samePortablePath("D:\\Repo\\.\\src\\", "d:/repo/src"), true);
  assert.equal(samePortablePath("D:/repo/tmp/../src", "d:\\REPO\\src"), true);
  assert.equal(portablePathIdentity("D:\\Repo\\src"), portablePathIdentity("d:/repo/src"));
});

test("Windows drive and UNC roots cannot be traversed above their root", () => {
  assert.equal(samePortablePath("D:/..", "d:/"), true);
  assert.equal(samePortablePath("\\\\Server\\Share\\..", "//server/share"), true);
  assert.equal(samePortablePath("//Server/Share/Folder", "\\\\server\\share\\folder"), true);
});

test("POSIX paths remain case-sensitive and preserve backslashes", () => {
  assert.equal(samePortablePath("/Repo", "/repo"), false);
  assert.equal(samePortablePath("/a\\b", "/a/b"), false);
  assert.equal(samePortablePath("/a/./tmp/../b/", "/a/b"), true);
});

test("relative path normalization preserves unresolved parent segments", () => {
  assert.equal(samePortablePath("a/../../b", "../b", false), true);
  assert.equal(samePortablePath("../../a", "../a", false), false);
});
