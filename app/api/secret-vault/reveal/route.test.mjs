import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-reveal-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true });
const { POST } = await jiti.import("./route.ts");
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function request(body, headers = {}) {
  return new Request("http://localhost/api/secret-vault/reveal", {
    method: "POST",
    headers: { Host: "localhost", "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("拒绝跨站、错误类型和无效参数，所有响应禁止缓存", async () => {
  for (const [req, status] of [
    [request({ name: "example" }, { "sec-fetch-site": "cross-site" }), 403],
    [request({ name: "example" }, { "Content-Type": "text/plain" }), 415],
    [request("{"), 400],
    [request(null), 400],
    [request({ name: "Bad Name" }), 400],
    [request({ name: "missing" }), 404],
  ]) {
    const response = await POST(req);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal("value" in await response.json(), false);
  }
});
