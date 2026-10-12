import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const tarball = process.argv[2];
if (!tarball) throw new Error("用法：node scripts/verify-release.mjs <预构建 npm 包.tgz>");
const packageFile = path.resolve(tarball);
const directory = await mkdtemp(path.join(tmpdir(), "pi-web-release-"));
let server;
let serverLog = "";

/** 独立目录只安装生产依赖，防止开发目录里的模块掩盖发布包缺失。 */
async function install() {
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true }), "utf8");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline", packageFile], { cwd: directory, stdio: "inherit" });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `发布包安装失败：${signal ?? code}`);
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function checkPty(requirePackage) {
  const { spawn: spawnPty } = requirePackage("node-pty");
  const terminal = spawnPty(process.execPath, ["-e", 'process.stdout.write("pi-web-pty-ready")'], { cwd: directory, env: process.env });
  let output = "";
  let timer;
  try {
    await new Promise((resolve, reject) => {
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => exitCode === 0 ? resolve() : reject(new Error(`PTY 退出码 ${exitCode}`)));
      timer = setTimeout(() => { terminal.kill(); reject(new Error("PTY 验证超时")); }, 10_000);
    });
    assert.match(output, /pi-web-pty-ready/);
  } finally {
    clearTimeout(timer);
  }
}

async function checkServer(packageRoot) {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const agentDirectory = path.join(directory, "agent");
  await mkdir(agentDirectory);
  const password = "release-smoke-test";
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_WEB_SESSION_CONFIG_PATH: path.join(directory, "session.json"),
    PI_WEB_PASSWORD: password,
    PI_WEB_ALLOWED_HOSTS: "localhost",
    PI_WEB_SKIP_VERSION_CHECK: "1",
  };
  server = spawn(process.execPath, [path.join(packageRoot, "bin", "pi-web.js"), "-H", "127.0.0.1", "-p", String(port), "--no-open"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { serverLog += chunk; });
  server.stderr.on("data", chunk => { serverLog += chunk; });
  let spawnError;
  server.on("error", error => { spawnError = error; });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`服务提前退出：${serverLog}`);
    try {
      const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { ready = true; break; }
    } catch (error) {
      // 只允许启动期间的连接失败或探测超时，其它错误立即报告。
      if (error.cause?.code !== "ECONNREFUSED" && error.name !== "TimeoutError") throw error;
    }
    await delay(250);
  }
  assert.ok(ready, `服务启动超时：${serverLog}`);
  assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);
  const login = await fetch(`${origin}/api/web-auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "pi", password }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  for (const pathname of ["/", "/api/sessions", "/api/models"]) {
    const response = await fetch(`${origin}${pathname}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    assert.equal(response.status, 200, `${pathname}：${body.slice(0, 500)}\n${serverLog}`);
    if (pathname === "/") assert.match(body, /_next\/static/);
    else JSON.parse(body);
  }
}

try {
  await install();
  const packageRoot = path.join(directory, "node_modules", "@agegr", "pi-web");
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.ok((await readFile(path.join(packageRoot, ".next", "BUILD_ID"), "utf8")).trim());
  await checkPty(createRequire(path.join(packageRoot, "package.json")));
  await checkServer(packageRoot);
  console.log(`发布包 ${metadata.version} 验证通过：独立安装、原生 PTY、登录、页面与 SDK API`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  await rm(directory, { recursive: true, force: true });
}
