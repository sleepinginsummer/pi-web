import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./web-auth.ts");
}

test("仅在配置非空访问密码时启用站点认证", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(null), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), true);
});

test("仅接受固定用户名 pi 和配置的密码", async () => {
  const { isValidWebCredentials } = await loadSubject();
  assert.equal(isValidWebCredentials("pi", "secret", "secret"), true);
  assert.equal(isValidWebCredentials("admin", "secret", "secret"), false);
  assert.equal(isValidWebCredentials("pi", "wrong", "secret"), false);
  assert.equal(isValidWebCredentials("PI", "secret", "secret"), false);
});

test("支持 UTF-8 密码和包含冒号的密码", async () => {
  const { isValidWebCredentials } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(isValidWebCredentials("pi", password, password), true);
});

test("密码保护关闭时不接受任何凭据", async () => {
  const { isValidWebCredentials } = await loadSubject();
  assert.equal(isValidWebCredentials("pi", "", ""), false);
  assert.equal(isValidWebCredentials("pi", "secret", undefined), false);
});
