import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalConfig = process.env.PI_WEB_SESSION_CONFIG_PATH;
const tempDir = mkdtempSync(join(tmpdir(), "pi-web-proxy-test-"));
process.env.PI_WEB_SESSION_CONFIG_PATH = join(tempDir, "session.json");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken, getOrCreateWebSessionSecret } = await jiti.import("./web-session.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalConfig === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
  else process.env.PI_WEB_SESSION_CONFIG_PATH = originalConfig;
  rmSync(tempDir, { recursive: true, force: true });
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret", getOrCreateWebSessionSecret());
  const response = proxy(request("/", { Cookie: `pi-web-session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("不允许 Basic Auth 绕过本地登录会话", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 401);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth/session")).status, 200);
});
