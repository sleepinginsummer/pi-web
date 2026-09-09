import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("保存模型配置后强制刷新涉及的远程 provider 目录", () => {
  const commitIndex = source.indexOf("await commitModelsConfigWithCapabilities(body)");
  const refreshIndex = source.indexOf("await forceRefreshModelCatalog(providers)");

  assert.ok(commitIndex >= 0);
  assert.ok(refreshIndex > commitIndex);
  assert.match(source, /Object\.keys\(body\.providers\)/);
  assert.match(source, /catalogRefreshed: true/);
});

test("远程目录刷新失败不会把已落盘配置误报成保存失败", () => {
  assert.match(source, /console\.error\("模型配置已保存，但远程模型目录强制刷新失败"/);
  assert.match(source, /success: true, catalogRefreshed: false/);
});
