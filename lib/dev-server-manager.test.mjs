import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { parseLaunchConfig, readLaunchConfigs, configUrl } = await jiti.import("./dev-server-config.ts");
const {
  dismissDevServer,
  isPortOpen,
  listDevServers,
  readDevServerLogs,
  startDevServer,
  stopAllDevServersForTests,
  stopDevServer,
} = await jiti.import("./dev-server-manager.ts");

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A server that prints, binds PORT, and keeps a child process in its group.
const SERVER_SCRIPT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("booting");
console.error("warn: example error line");
require("node:http").createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
`;

test.after(() => stopAllDevServersForTests());

test("launch configs validate entries and keep the first file's names", () => {
  const { configs, errors } = parseLaunchConfig(JSON.stringify({
    configurations: [
      { name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3000 },
      { name: "attach", url: "http://localhost:4000/app" },
      { name: "no-port", runtimeExecutable: "npm" },
      { name: "bad port", runtimeExecutable: "npm", port: 70000 },
      { name: "web", runtimeExecutable: "npm", port: 3001 },
    ],
  }), ".pi/launch.json");
  assert.deepEqual(configs.map((config) => config.name), ["web", "attach"]);
  assert.equal(configUrl(configs[0]), "http://localhost:3000");
  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /needs "port"/);
  assert.match(errors.join("\n"), /duplicate name "web"/);
  assert.deepEqual(parseLaunchConfig("{", "x").configs, []);
});

test("readLaunchConfigs reads .pi before .claude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-launch-"));
  mkdirSync(join(dir, ".pi"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".pi/launch.json"), JSON.stringify({ configurations: [{ name: "web", runtimeExecutable: "pi", port: 1 }] }));
  writeFileSync(join(dir, ".claude/launch.json"), JSON.stringify({ configurations: [
    { name: "web", runtimeExecutable: "claude", port: 2 },
    { name: "api", runtimeExecutable: "claude", port: 3 },
  ] }));
  const { configs, errors } = await readLaunchConfigs(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(configs.map((config) => [config.name, config.runtimeExecutable]), [["web", "pi"], ["api", "claude"]]);
});

test("starts once, reuses, captures logs, and stops the whole process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-server-"));
  const port = await freePort();
  const config = { name: "web", runtimeExecutable: process.execPath, runtimeArgs: ["-e", SERVER_SCRIPT], port, env: {}, source: ".pi/launch.json" };

  const first = await startDevServer(dir, config, { readyTimeoutMs: 10_000 });
  assert.equal(first.reused, false);
  assert.equal(first.server.status, "running");
  assert.equal(first.server.url, `http://localhost:${port}`);

  const second = await startDevServer(dir, config);
  assert.equal(second.reused, true);
  assert.equal(second.server.id, first.server.id);
  assert.equal(listDevServers(dir).length, 1);
  assert.equal(listDevServers(join(dir, "elsewhere")).length, 0);

  const logs = readDevServerLogs(first.server.id).map((line) => line.text);
  assert.ok(logs.includes("booting"));
  assert.deepEqual(readDevServerLogs(first.server.id, { errorsOnly: true }).map((line) => line.text), ["warn: example error line"]);
  assert.deepEqual(readDevServerLogs(first.server.id, { search: "READY" }).filter((line) => line.stream === "stdout").map((line) => line.text), ["ready"]);

  assert.equal(dismissDevServer(first.server.id), false, "a running server cannot be dismissed");
  const stopped = await stopDevServer(first.server.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(await isPortOpen(port), false);
  assert.equal(dismissDevServer(first.server.id), true);
  assert.equal(listDevServers(dir).length, 0);
});

test("refuses a port another process holds and reports a crashing server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-server-"));
  const blocker = createServer();
  const port = await new Promise((resolve) => blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)));
  try {
    await assert.rejects(
      startDevServer(dir, { name: "web", runtimeExecutable: process.execPath, runtimeArgs: [], port, env: {}, source: "x" }),
      /already in use by another process/,
    );
    const attached = await startDevServer(dir, { name: "ext", url: `http://localhost:${port}`, runtimeArgs: [], env: {}, source: "x" });
    assert.equal(attached.server.managed, false);
    assert.equal(attached.server.status, "running");
  } finally {
    blocker.close();
  }

  const crashPort = await freePort();
  const crashed = await startDevServer(dir, {
    name: "crash",
    runtimeExecutable: process.execPath,
    runtimeArgs: ["-e", "console.error('boom'); process.exit(3)"],
    port: crashPort,
    env: {},
    source: "x",
  }, { readyTimeoutMs: 10_000 });
  assert.equal(crashed.server.status, "failed");
  assert.equal(crashed.server.exitCode, 3);
  assert.ok(readDevServerLogs(crashed.server.id).some((line) => line.text === "boom"));
});
