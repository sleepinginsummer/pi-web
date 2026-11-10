import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { filterToProject } = await jiti.import("./project-scope.ts");

const roots = {
  "/repo": "/repo",
  "/repo-worktrees/feature": "/repo",
  "/repo/packages/app": "/repo",
  "/other": "/other",
};
const resolve = async (dir) => {
  if (dir === "/broken") throw new Error("git failed");
  return { projectRoot: roots[dir] ?? dir };
};

test("items from the same repository's worktrees belong to the project", async () => {
  const items = ["/repo", "/repo-worktrees/feature", "/repo/packages/app", "/other", "/broken"].map((cwd) => ({ cwd }));
  assert.deepEqual((await filterToProject(items, "/repo-worktrees/feature", resolve)).map((item) => item.cwd), [
    "/repo", "/repo-worktrees/feature", "/repo/packages/app",
  ]);
  assert.deepEqual((await filterToProject(items, "/other", resolve)).map((item) => item.cwd), ["/other"]);
  assert.deepEqual((await filterToProject(items, "/broken", resolve)).map((item) => item.cwd), ["/broken"]);
});
