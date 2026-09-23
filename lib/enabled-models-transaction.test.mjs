import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { withEnabledModelsSettings } = await jiti.import("./enabled-models-transaction.ts");
const { writeEnabledModels, readEnabledModelsSettings } = await jiti.import("./enabled-models-runtime.ts");

test("两个标签同时修改不同模型时，在锁内重新读取而不丢失先提交的更改", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-model-transaction-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["base/model"] }));

  let unlockFirst;
  let firstEntered;
  const firstInside = new Promise((resolve) => { firstEntered = resolve; });
  const holdFirst = new Promise((resolve) => { unlockFirst = resolve; });
  const edit = (ref, hold = false) => withEnabledModelsSettings(cwd, agentDir, async (settings) => {
    const { patterns } = readEnabledModelsSettings(settings, { cwd, agentDir });
    if (hold) { firstEntered(); await holdFirst; }
    await writeEnabledModels(settings, [...(patterns ?? []), ref]);
  });
  const first = edit("provider/one", true);
  await firstInside;
  const second = edit("provider/two");
  unlockFirst();
  await Promise.all([first, second]);
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.enabledModels, ["base/model", "provider/one", "provider/two"]);
});
