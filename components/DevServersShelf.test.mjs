import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

// 入口显示条件只取决于 useDevServers 返回的快照，用固定快照替换轮询 hook，
// 两个纯函数替身与 hooks/useDevServers.ts 的判定保持一致。
const fixtures = await mkdtemp(join(tmpdir(), "dev-servers-shelf-"));
await writeFile(
  join(fixtures, "useDevServers.mjs"),
  [
    `export function isDevServerActive(server) { return server.status === "starting" || server.status === "running" || server.status === "stopping"; }`,
    `export function browserServerUrl(url) { return url; }`,
    `export function useDevServers() { const data = globalThis.__devServersShelfData; return { data, error: null, pending: new Set(), start() {}, stop() {}, dismiss() {} }; }`,
  ].join("\n"),
);
await writeFile(join(fixtures, "useI18n.mjs"), `export function useI18n() { return { t: (key) => key }; }`);

const source = (await readFile(new URL("./DevServersShelf.tsx", import.meta.url), "utf8"))
  .replace('from "@/hooks/useDevServers"', `from ${JSON.stringify(join(fixtures, "useDevServers.mjs"))}`)
  .replace('from "@/hooks/useI18n"', `from ${JSON.stringify(join(fixtures, "useI18n.mjs"))}`);
const { DevServersShelf } = jiti.evalModule(source, { filename: new URL("./DevServersShelf.probe.tsx", import.meta.url).pathname });

const declared = { name: "web", source: ".pi/launch.json", managed: true };
const running = { id: "1", name: "web", status: "running", managed: true, url: "http://localhost:3000" };

function render(data) {
  globalThis.__devServersShelfData = data;
  return renderToStaticMarkup(React.createElement(DevServersShelf, { cwd: "/project" }));
}

test("只有已启动的服务器或启动配置错误才显示入口", () => {
  assert.equal(render({ enabled: true, servers: [], configs: [], errors: [] }), "");
  assert.equal(render({ enabled: true, servers: [], configs: [declared], errors: [] }), "", "仅声明过 launch 配置不显示入口");

  const withErrors = render({ enabled: true, servers: [], configs: [], errors: [".pi/launch.json: invalid JSON"] });
  assert.match(withErrors, /class="dev-servers-shelf"/, "启动配置错误必须留有入口");
  assert.match(withErrors, /aria-label="servers\.triggerErrors"/, "启动配置错误时读屏要说明问题");
  assert.match(withErrors, /class="dev-servers-error-dot"/, "启动配置错误时入口要带告警点");
  assert.doesNotMatch(withErrors, /dev-servers-count/, "没有运行中的服务器时不要显示 0 个运行中");
});

test("有服务器时显示入口与运行计数", () => {
  const html = render({ enabled: true, servers: [running], configs: [], errors: [] });
  assert.match(html, /aria-label="servers\.triggerLabel"/);
  assert.match(html, /class="dev-servers-count">1</);
  assert.doesNotMatch(html, /dev-servers-error-dot/, "配置没问题时不要带告警点");
});

test("运行中的服务器与配置错误同时存在时两个标记都保留", () => {
  const html = render({ enabled: true, servers: [running], configs: [], errors: [".pi/launch.json: invalid JSON"] });
  assert.match(html, /aria-label="servers\.triggerErrors"/);
  assert.match(html, /class="dev-servers-count">1</);
  assert.match(html, /class="dev-servers-error-dot"/);
});

test.after(async () => {
  delete globalThis.__devServersShelfData;
  await rm(fixtures, { recursive: true, force: true });
});
