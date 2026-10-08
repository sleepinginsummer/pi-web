import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const modelsPath = join(testAgentDir, "models.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body) {
  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

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

test("配置语法损坏时读取报错，保存不得覆盖原始文件", async () => {
  const original = '{ "providers": { "acme": { "models": [ } } }';
  await writeFile(modelsPath, original);
  let response = await GET();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /models\.json/);
  response = await PUT(put({ providers: {} }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("带注释和尾随逗号的模型配置保留 provider", async () => {
  await writeFile(modelsPath, '{\n  // local models\n  "providers": { "acme": { "models": [{ "id": "a" },] } },\n}\n');
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { providers: { acme: { models: [{ id: "a" }] } } });
});
