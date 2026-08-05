import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("Git 上下文接口只允许查询已授权的现有目录", () => {
  assert.match(source, /getAllowedFileRoots\(\)/);
  assert.match(source, /isFilePathAllowed\(cwd, allowedRoots\)/);
  assert.match(source, /isExistingFilePathAllowed\(cwd, allowedRoots\)/);
  assert.match(source, /status: 403/);
});

test("Git 上下文接口实时刷新项目并就地更新会话列表缓存", () => {
  assert.match(source, /invalidateProjectCache\(cwd\)/);
  assert.match(source, /updateCachedSessionProject\(cwd, project, currentBranch\)/);
  assert.doesNotMatch(source, /invalidateSessionListCache\(\)/);
  assert.match(source, /detached@\$\{project\.headCommit\}/);
});
