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
await writeFile(join(fixtures, "useScheduledTasks.mjs"), `export function useScheduledTasks() { return { data: globalThis.__shelfTasks ?? null, error: null, pending: new Set(), act() {} }; } export function isScheduledTaskPending(task) { return task.enabled && task.nextRunAt !== null; }`);
await writeFile(join(fixtures, "useBackgroundCommands.mjs"), `export function useBackgroundCommands() { return { data: globalThis.__shelfCommands ?? null, error: null, pending: new Set(), act() {} }; } export function useBackgroundCommandOutput() { return null; }`);

const source = (await readFile(new URL("./DevServersShelf.tsx", import.meta.url), "utf8"))
  .replace('from "@/hooks/useDevServers"', `from ${JSON.stringify(join(fixtures, "useDevServers.mjs"))}`)
  .replace('from "@/hooks/useI18n"', `from ${JSON.stringify(join(fixtures, "useI18n.mjs"))}`)
  .replace('from "@/hooks/useScheduledTasks"', `from ${JSON.stringify(join(fixtures, "useScheduledTasks.mjs"))}`)
  .replace('from "@/hooks/useBackgroundCommands"', `from ${JSON.stringify(join(fixtures, "useBackgroundCommands.mjs"))}`)
  .replace("const [open, setOpen] = useState(false)", "const [open, setOpen] = useState(globalThis.__shelfOpen ?? false)");
const { DevServersShelf } = jiti.evalModule(source, { filename: new URL("./DevServersShelf.probe.tsx", import.meta.url).pathname });

const declared = { name: "web", source: ".pi/launch.json", managed: true };
const running = { id: "1", name: "web", status: "running", managed: true, url: "http://localhost:3000" };

function render(data, { tasks = [], commands = [], sessionId = "current", open = false } = {}) {
  globalThis.__devServersShelfData = data;
  globalThis.__shelfTasks = { enabled: true, tasks };
  globalThis.__shelfCommands = { enabled: true, commands };
  globalThis.__shelfOpen = open;
  return renderToStaticMarkup(React.createElement(DevServersShelf, { cwd: "/project", sessionId }));
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

test("其他会话按目录折叠展示，链接指向归属会话，两类记录均显示时间", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "other", cwd: "/project/", name: "other-task", sessionLabel: "其他会话名称", prompt: "check", schedule: { kind: "once" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const command = { id: "cmd", sessionId: "other", cwd: "/project", command: "test", label: "other-command", status: "exited", startedAt: createdAt, endedAt: createdAt + 1000 };
  const data = { enabled: true, servers: [], configs: [], errors: [] };
  const options = { tasks: [task, { ...task, id: "hidden", cwd: "/other", name: "hidden-task" }], commands: [command], open: true };
  const html = render(data, options);
  assert.match(html, /<details[^>]*class="other-session-tasks"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /other-task/);
  assert.match(html, /other-command/);
  assert.doesNotMatch(html, /hidden-task/);
  assert.equal((html.match(/href="\?session=other"/g) ?? []).length, 2);
  assert.equal((html.match(/dateTime="2026-01-02T03:04:00.000Z"/g) ?? []).length, 2);
  assert.match(html, /tasks.createdAt/);
  assert.match(html, /tasks.startedAt/);
  assert.doesNotMatch(html, /dev-servers-count/);
  const switched = render(data, { ...options, sessionId: "other" });
  assert.doesNotMatch(switched, /other-session-tasks/);
  assert.match(switched, /other-task/);
  assert.match(switched, /other-command/);
  assert.equal(render(data, { tasks: [{ ...task, cwd: "/elsewhere" }] }), "");
});
test.after(async () => {
  delete globalThis.__devServersShelfData;
  delete globalThis.__shelfTasks;
  delete globalThis.__shelfCommands;
  delete globalThis.__shelfOpen;
  await rm(fixtures, { recursive: true, force: true });
});
