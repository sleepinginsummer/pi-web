import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { POST } = await jiti.import("./[id]/route.ts");
const { AgentSessionWrapper } = await jiti.import("@/lib/rpc-manager.ts");
const id = "11111111-1111-4111-8111-111111111111";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-agent-external-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" };
  const message = (entryId, content) => ({ type: "message", id: entryId, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content } });
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message("first", "old"))}\n`);
  return { file, message };
}

async function command(type, extra = {}) {
  return POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  }), { params: Promise.resolve({ id }) });
}

test("外部写入后仍允许 Stop，但拒绝旧 leaf 的命令并返回 409", async (t) => {
  const { file, message } = fixture(t);
  const manager = SessionManager.open(file);
  let aborts = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: id, sessionFile: file, isStreaming: true, isBashRunning: false, isCompacting: false,
    sessionManager: manager, agent: { state: {} },
    abort: async () => { aborts += 1; }, dispose() {},
  });
  globalThis.__piSessions ??= new Map();
  globalThis.__piSessions.set(id, wrapper);
  t.after(() => { wrapper.destroy(); globalThis.__piSessions.delete(id); });
  appendFileSync(file, `${JSON.stringify(message("external", "new"))}\n`);

  const stopped = await command("abort");
  assert.equal(stopped.status, 200);
  assert.equal(aborts, 1);
  const denied = await command("set_thinking_level", { level: "high" });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "session_external_write");
});
