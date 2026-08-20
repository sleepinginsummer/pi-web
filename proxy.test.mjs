import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { getSafeInternalPath } = await jiti.import("./lib/web-auth-redirect.ts");

test("保留登录前的站内目标路径", () => {
  assert.equal(getSafeInternalPath("/settings?tab=models#provider"), "/settings?tab=models#provider");
});

test("拒绝外部、协议相对和循环登录目标", () => {
  assert.equal(getSafeInternalPath(null), "/");
  assert.equal(getSafeInternalPath("https://example.com"), "/");
  assert.equal(getSafeInternalPath("//example.com"), "/");
  assert.equal(getSafeInternalPath("/login"), "/");
  assert.equal(getSafeInternalPath("/login?next=/login"), "/");
});
