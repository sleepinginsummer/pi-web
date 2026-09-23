import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");
const { recordAuthSuccess } = await jiti.import("../../../../lib/auth-throttle.ts");

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
    recordAuthSuccess();
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
    recordAuthSuccess();
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
    recordAuthSuccess();
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
    else process.env.PI_WEB_SESSION_CONFIG_PATH = previousConfigPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("连续失败时限制请求，等待期内即使凭据正确也不签发 Cookie", async () => {
  const previousPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "correct-password";
  try {
    const failed = await POST(loginRequest({ username: "pi", password: "wrong-password" }));
    assert.equal(failed.status, 401);
    const blocked = await POST(loginRequest({ username: "pi", password: "correct-password" }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.has("set-cookie"), false);
    assert.equal(Number(blocked.headers.get("Retry-After")) >= 1, true);
  } finally {
    recordAuthSuccess();
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
  }
});

test("设置面板读取登录状态并从同一路由退出", async () => {
  const { GET, DELETE } = await jiti.import("./route.ts");
  const previousPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "correct-password";
  try {
    const status = await GET();
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: true });
    assert.equal(status.headers.get("cache-control"), "no-store");
    const logout = await DELETE(new Request("http://127.0.0.1/api/web-auth/session", { method: "DELETE" }));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /pi-web-session=;.*Max-Age=0/i);
  } finally {
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
  }
});
