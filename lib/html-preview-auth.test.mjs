import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-preview-grant-")));
const previousPassword = process.env.PI_WEB_PASSWORD;
const previousConfig = process.env.PI_WEB_SESSION_CONFIG_PATH;
process.env.PI_WEB_PASSWORD = "test-password";
process.env.PI_WEB_SESSION_CONFIG_PATH = path.join(base, "session.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getPreviewDocumentRedirect, isPreviewAssetAuthenticated, isRawPreviewCredentialAllowed, PREVIEW_CREDENTIAL_MAX_AGE_SECONDS, rawPreviewFileSegments } = await jiti.import("./html-preview-auth.ts");
const { getOrCreateWebSessionSecret, createWebSessionToken, verifyPersistedWebSessionToken } = await jiti.import("./web-session.ts");
const { proxy } = await jiti.import("../proxy.ts");
const { NextRequest } = await jiti.import("next/server");
const site = path.join(base, "site");
fs.mkdirSync(path.join(site, "media"), { recursive: true });
fs.writeFileSync(path.join(site, "index.html"), "preview");
fs.writeFileSync(path.join(site, "preview.css"), "body{}");
fs.writeFileSync(path.join(site, "media", "video.mp4"), "video");
fs.writeFileSync(path.join(base, "secret.css"), "secret");
fs.symlinkSync(path.join(base, "secret.css"), path.join(site, "linked.css"));
const now = Date.now();
const cookie = `pi-web-session=${createWebSessionToken("test-password", getOrCreateWebSessionSecret(), now)}`;
const original = new Request(`http://localhost/api/files/raw${site}/index.html?sessionId=abc&v=3`, { headers: { cookie } });
const redirectPath = getPreviewDocumentRedirect(original, path.join(site, "index.html"), now);
const redirect = new URL(redirectPath, original.url);
function asset(relative = "preview.css", headers = {}, method = "GET") {
  return new NextRequest(new URL(relative, redirect), { method, headers: { host: "localhost", "sec-fetch-site": "cross-site", "sec-fetch-dest": "style", ...headers } });
}
test.after(() => {
  if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = previousPassword;
  if (previousConfig === undefined) delete process.env.PI_WEB_SESSION_CONFIG_PATH;
  else process.env.PI_WEB_SESSION_CONFIG_PATH = previousConfig;
  fs.rmSync(base, { recursive: true, force: true });
});

test("只有已登录 HTML 入口签发凭据，相对资源路径保留它且不循环重定向", () => {
  assert.ok(redirect);
  assert.equal(redirect.search, original.url.slice(original.url.indexOf("?")));
  assert.equal(getPreviewDocumentRedirect(new Request(original.url), path.join(site, "index.html"), now), null);
  assert.equal(getPreviewDocumentRedirect(original, path.join(site, "preview.css"), now), null);
  assert.equal(getPreviewDocumentRedirect(new Request(redirect, { headers: { cookie } }), path.join(site, "index.html"), now), null);
  const segments = redirect.pathname.slice("/api/files/".length).split("/").map(decodeURIComponent);
  assert.equal(rawPreviewFileSegments(segments).join("/"), site.slice(1) + "/index.html");
  assert.equal(isPreviewAssetAuthenticated(asset(), "test-password", now), true);
  assert.equal(proxy(asset()).headers.get("x-middleware-next"), "1");
  assert.equal(isPreviewAssetAuthenticated(asset("media/video.mp4", { "sec-fetch-dest": "video", range: "bytes=0-1" }), "test-password", now), true);
});

test("内部 URL 与局域网或代理 Host 不同时，重定向保留外部访问源", () => {
  for (const [internal, external] of [
    ["http://localhost:30141", "http://192.168.1.50:8081"],
    ["http://0.0.0.0:30141", "https://pi.example.com"],
  ]) {
    const request = new Request(`${internal}/api/files/raw${site}/index.html?sessionId=abc&v=3`, {
      headers: { cookie, host: new URL(external).host, "x-forwarded-proto": new URL(external).protocol.slice(0, -1) },
    });
    const location = getPreviewDocumentRedirect(request, path.join(site, "index.html"), now);
    assert.ok(location.startsWith("/api/files/raw/~preview-"));
    assert.ok(!location.startsWith("//"));
    const browserUrl = new URL(location, external);
    assert.equal(browserUrl.origin, external);
    assert.equal(browserUrl.search, "?sessionId=abc&v=3");
  }
});

test("拒绝过期、密码变更、篡改的凭据，预览凭据不能充当登录令牌", () => {
  assert.equal(isPreviewAssetAuthenticated(asset(), "test-password", now + PREVIEW_CREDENTIAL_MAX_AGE_SECONDS * 1000), false);
  assert.equal(isPreviewAssetAuthenticated(asset(), "changed-password", now), false);
  const altered = new URL(asset().url);
  altered.pathname = altered.pathname.replace("~preview-", "~preview-x");
  assert.equal(isPreviewAssetAuthenticated(new Request(altered, { headers: { "sec-fetch-dest": "style" } }), "test-password", now), false);
  const token = redirect.pathname.split("/")[4].slice("~preview-".length);
  assert.equal(verifyPersistedWebSessionToken(token, "test-password", now), false);
});

test("目录凭据不能越目录、穿过外部符号链接或携带编码的父路径", () => {
  assert.equal(isPreviewAssetAuthenticated(asset("../secret.css"), "test-password", now), false);
  assert.equal(isPreviewAssetAuthenticated(asset("linked.css"), "test-password", now), false);
  assert.equal(isPreviewAssetAuthenticated(asset("media%2F..%2Fpreview.css"), "test-password", now), false);
  assert.equal(isRawPreviewCredentialAllowed(asset("../secret.css"), "test-password", now), false);
});

test("预览凭据不能授权 fetch、页面导航、写请求或其它业务 API", () => {
  for (const dest of ["empty", "document", "iframe"]) {
    assert.equal(isPreviewAssetAuthenticated(asset("preview.css", { "sec-fetch-dest": dest }), "test-password", now), false);
    assert.equal(proxy(asset("preview.css", { "sec-fetch-dest": dest })).status, 403);
  }
  assert.equal(isPreviewAssetAuthenticated(asset("preview.css", {}, "POST"), "test-password", now), false);
  assert.equal(proxy(asset("preview.css", {}, "POST")).status, 403);
  assert.equal(proxy(new NextRequest("http://localhost/api/sessions", { headers: { host: "localhost", "sec-fetch-dest": "style" } })).status, 401);
  assert.equal(proxy(new NextRequest(original.url.replace("index.html?sessionId=abc&v=3", "preview.css"), { headers: { host: "localhost", "sec-fetch-dest": "style", "sec-fetch-site": "cross-site" } })).status, 401);
});
