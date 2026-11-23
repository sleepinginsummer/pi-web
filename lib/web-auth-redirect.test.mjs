import assert from "node:assert/strict";
import test from "node:test";

const { getSafeInternalPath } = await import("./web-auth-redirect.ts");

test("returns to the local page that sent the browser to the login page", () => {
  assert.equal(getSafeInternalPath("/?session=abc"), "/?session=abc");
  assert.equal(getSafeInternalPath("/?cwd=%2Fhome%2Fpi#top"), "/?cwd=%2Fhome%2Fpi#top");
});

test("falls back to the app root without a usable destination or for /login loop", () => {
  assert.equal(getSafeInternalPath(null), "/");
  assert.equal(getSafeInternalPath(""), "/");
  assert.equal(getSafeInternalPath("session"), "/");
  assert.equal(getSafeInternalPath("/login"), "/");
  assert.equal(getSafeInternalPath("/login?next=/"), "/");
  assert.equal(getSafeInternalPath("https://evil.example/"), "/");
  assert.equal(getSafeInternalPath("javascript:alert(1)"), "/");
});

test("rejects paths the URL parser resolves to another host", () => {
  for (const next of [
    "//evil.example",
    "/\\evil.example",
    "/\\evil.example/foo",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\\\tevil.example",
  ]) {
    assert.equal(getSafeInternalPath(next), "/", JSON.stringify(next));
  }
});
