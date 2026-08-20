import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./web-session.ts");
}

test("创建的会话令牌可校验且不包含明文密码", async () => {
  const { createWebSessionToken, verifyWebSessionToken } = await loadSubject();
  const secret = Buffer.alloc(32, 7);
  const now = Date.UTC(2026, 0, 1);
  const token = createWebSessionToken("口令-secret", secret, now);

  assert.equal(token.includes("口令-secret"), false);
  assert.equal(verifyWebSessionToken(token, "口令-secret", secret, now), true);
  assert.equal(verifyWebSessionToken(token, "wrong", secret, now), false);
  assert.equal(verifyWebSessionToken(`${token}x`, "口令-secret", secret, now), false);
});

test("拒绝过期、截断和密钥不匹配的会话令牌", async () => {
  const {
    createWebSessionToken,
    verifyWebSessionToken,
    WEB_SESSION_MAX_AGE_SECONDS,
  } = await loadSubject();
  const secret = Buffer.alloc(32, 9);
  const now = Date.UTC(2026, 0, 1);
  const token = createWebSessionToken("secret", secret, now);

  assert.equal(
    verifyWebSessionToken(token, "secret", secret, now + WEB_SESSION_MAX_AGE_SECONDS * 1000),
    false,
  );
  assert.equal(verifyWebSessionToken(token.slice(0, -1), "secret", secret, now), false);
  assert.equal(verifyWebSessionToken(token, "secret", Buffer.alloc(32, 8), now), false);
  assert.equal(verifyWebSessionToken(undefined, "secret", secret, now), false);
});

test("会话密钥持久化到仅当前用户可读的独立文件", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-session-"));
  const configPath = path.join(directory, "session.json");
  const previousPath = process.env.PI_WEB_SESSION_CONFIG_PATH;
  process.env.PI_WEB_SESSION_CONFIG_PATH = configPath;

  try {
    const { getOrCreateWebSessionSecret } = await loadSubject();
    const first = getOrCreateWebSessionSecret();
    const second = getOrCreateWebSessionSecret();
    const config = JSON.parse(readFileSync(configPath, "utf8"));

    assert.deepEqual(first, second);
    assert.equal(first.length, 32);
    assert.equal(config.version, 1);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    if (previousPath === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
    else process.env.PI_WEB_SESSION_CONFIG_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
