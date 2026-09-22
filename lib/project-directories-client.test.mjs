import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyProjectDirectories } from "./project-directories-client.ts";

test("旧目录迁移仅保留失败条目供后续重试", async (t) => {
  t.mock.method(console, "error", () => {});
  const result = await migrateLegacyProjectDirectories(
    ["/ok", "/retry"],
    ["/existing"],
    async (cwd) => {
      if (cwd === "/retry") throw new Error("HTTP 500");
      return { projects: [cwd, "/existing"] };
    },
  );

  assert.deepEqual(result.projects, ["/ok", "/existing"]);
  assert.deepEqual(result.failed, ["/retry"]);
});

test("旧目录全部迁移成功后不保留重试项", async () => {
  const result = await migrateLegacyProjectDirectories(
    ["/a", "/b"],
    [],
    async (cwd) => ({ projects: [cwd] }),
  );

  assert.deepEqual(result.projects, ["/b"]);
  assert.deepEqual(result.failed, []);
});
