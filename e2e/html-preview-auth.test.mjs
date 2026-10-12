import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { createJiti } from "jiti";
import { chromium } from "playwright";

// 用真实浏览器核对 SameSite 与不透明沙盒，不用 Mock 模拟 Cookie 行为。
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-preview-auth-")));
const previous = Object.fromEntries(["PI_WEB_PASSWORD", "PI_WEB_SESSION_CONFIG_PATH", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
process.env.PI_WEB_PASSWORD = "preview-test-password";
process.env.PI_WEB_SESSION_CONFIG_PATH = path.join(base, "session.json");
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { proxy } = await jiti.import("../proxy.ts");
const { GET } = await jiti.import("../app/api/files/[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../lib/file-access.ts");
const { createWebSessionToken, getOrCreateWebSessionSecret } = await jiti.import("../lib/web-session.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const { NextRequest } = await jiti.import("next/server");

test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("登录开启时沙盒预览加载相邻样式和脚本，同时拒绝读取业务 API", async () => {
  const site = path.join(base, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "index.html"), '<link rel="stylesheet" href="preview.css"><script src="preview.js" defer></script><p id="result">pending</p>');
  fs.writeFileSync(path.join(site, "preview.css"), "body { background-color: rgb(12, 34, 56); }");
  fs.writeFileSync(path.join(site, "preview.js"), 'document.querySelector("#result").textContent = "ready"; fetch("/api/sessions").catch(() => document.body.dataset.apiBlocked = "true");');
  allowFileRoot(site);
  const rawUrl = `/api/files/raw/${encodeFilePathForApi(path.join(site, "index.html"))}`;
  const serverRequests = [];
  const server = http.createServer(async (req, res) => {
    try {
      // 模拟 Next.js 内部地址与浏览器访问的 Host 不同。
      const url = `http://127.0.0.1:${server.address().port}${req.url}`;
      const request = new NextRequest(url, { method: req.method, headers: req.headers });
      const checked = proxy(request);
      let response;
      if (checked.headers.get("x-middleware-next") !== "1") response = checked;
      else if (new URL(url).pathname === "/") response = new Response(`<iframe sandbox="allow-scripts" src="${rawUrl}"></iframe>`, { headers: { "content-type": "text/html" } });
      else if (new URL(url).pathname.startsWith("/api/files/")) {
        const segments = new URL(url).pathname.slice("/api/files/".length).split("/").map(decodeURIComponent);
        response = await GET(request, { params: Promise.resolve({ path: segments }) });
      } else response = new Response("protected");
      serverRequests.push({ pathname: new URL(url).pathname, status: response.status, cookie: Boolean(req.headers.cookie), location: response.headers.get("location") });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://localhost:${server.address().port}`;
    const context = await browser.newContext();
    await context.addCookies([{ name: "pi-web-session", value: createWebSessionToken(process.env.PI_WEB_PASSWORD, getOrCreateWebSessionSecret()), url: origin, sameSite: "Lax", httpOnly: true }]);
    const page = await context.newPage();
    const statuses = [];
    page.on("response", r => { statuses.push([r.url().split("/").at(-1), r.status()]); });

    await page.goto(origin);
    const frame = page.frames().find(f => f !== page.mainFrame());
    await frame.waitForURL(/index\.html/);
    await frame.waitForLoadState("load");
    assert.equal(new URL(frame.url()).origin, origin);
    const redirectResponse = serverRequests.find(r => r.status === 307);
    assert.ok(redirectResponse.location.startsWith("/api/files/raw/"));
    assert.ok(!redirectResponse.location.startsWith("//"));

    assert.deepEqual(statuses.filter(([name]) => /preview\.(css|js)/.test(name)).sort(), [["preview.css", 200], ["preview.js", 200]], JSON.stringify(statuses));
    assert.equal(await frame.locator("#result").textContent(), "ready");
    assert.equal(await frame.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(12, 34, 56)");
    await frame.waitForFunction(() => document.body.dataset.apiBlocked === "true");
    assert.equal(serverRequests.find(r => r.pathname === "/api/sessions").status, 403);
    assert.ok(serverRequests.filter(r => /preview\.(css|js)$/.test(r.pathname)).every(r => !r.cookie));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
