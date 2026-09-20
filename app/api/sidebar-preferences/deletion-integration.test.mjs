import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoute = await readFile(new URL("../project-directories/route.ts", import.meta.url), "utf8");
const sessionRoute = await readFile(new URL("../sessions/[id]/route.ts", import.meta.url), "utf8");

test("权威项目删除完成后 best-effort 清理侧边栏偏好", () => {
  const deleteIndex = projectRoute.indexOf("const projects = await removeProjectDirectory(cwd)");
  const cleanupIndex = projectRoute.indexOf("await removeSidebarPreferenceIds({ projectPaths: [cwd] })");
  assert.ok(deleteIndex >= 0 && cleanupIndex > deleteIndex);
  assert.match(projectRoute.slice(deleteIndex), /catch \(error\)[\s\S]*?清理已删除项目的侧边栏偏好失败/);
});

test("权威会话删除完成后 best-effort 清理侧边栏偏好", () => {
  const deleteIndex = sessionRoute.indexOf("const trashedName = trashSessionFile(filePath)");
  const cleanupIndex = sessionRoute.indexOf("await removeSidebarPreferenceIds({ sessionIds: [id] })");
  assert.ok(deleteIndex >= 0 && cleanupIndex > deleteIndex);
  assert.match(sessionRoute.slice(deleteIndex), /catch \(error\)[\s\S]*?清理已删除会话的侧边栏偏好失败/);
});
