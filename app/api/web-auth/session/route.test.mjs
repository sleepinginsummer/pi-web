import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");

function loginRequest(body) {
  return new Request("http://127.0.0.1/api/web-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("凭据错误时不签发会话 Cookie", async () => {
  const previousPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "correct-password";
  try {
    const response = await POST(loginRequest({
      username: "pi",
      password: "wrong-password",
      remember: true,
    }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.deepEqual(await response.json(), { error: "用户名或密码错误" });
  } finally {
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
  }
});

test("正确凭据签发 HttpOnly 持久会话 Cookie", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-login-route-"));
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousConfigPath = process.env.PI_WEB_SESSION_CONFIG_PATH;
  process.env.PI_WEB_PASSWORD = "correct-password";
  process.env.PI_WEB_SESSION_CONFIG_PATH = path.join(directory, "session.json");

  try {
    const response = await POST(loginRequest({
      username: "pi",
      password: "correct-password",
      remember: true,
    }));
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.equal(response.status, 200);
    assert.match(cookie, /^pi-web-session=v1\./);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Max-Age=2592000/i);
    assert.doesNotMatch(cookie, /correct-password/);
  } finally {
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
    else process.env.PI_WEB_SESSION_CONFIG_PATH = previousConfigPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("未勾选保持登录时签发浏览器会话 Cookie", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-login-route-"));
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousConfigPath = process.env.PI_WEB_SESSION_CONFIG_PATH;
  process.env.PI_WEB_PASSWORD = "correct-password";
  process.env.PI_WEB_SESSION_CONFIG_PATH = path.join(directory, "session.json");

  try {
    const response = await POST(loginRequest({
      username: "pi",
      password: "correct-password",
      remember: false,
    }));
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.equal(response.status, 200);
    assert.doesNotMatch(cookie, /Max-Age=/i);
    assert.doesNotMatch(cookie, /Expires=/i);
  } finally {
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
    else process.env.PI_WEB_SESSION_CONFIG_PATH = previousConfigPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
