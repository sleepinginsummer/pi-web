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

test("只列当前会话自己的定时任务与后台命令", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "current-task", prompt: "check", schedule: { kind: "once" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const command = { id: "cmd", sessionId: "current", cwd: "/project", command: "test", label: "current-command", status: "exited", startedAt: createdAt, endedAt: createdAt + 1000 };
  const foreignTask = { ...task, id: "other", sessionId: "other", cwd: "/project", name: "other-task", sessionLabel: "其他会话名称" };
  const foreignCommand = { ...command, id: "other-cmd", sessionId: "other", label: "other-command" };
  const data = { enabled: true, servers: [], configs: [], errors: [] };
  const html = render(data, { tasks: [task, foreignTask], commands: [command, foreignCommand], open: true });

  assert.match(html, /current-task/);
  assert.match(html, /current-command/);
  // 其他会话的记录既不渲染，也不再留折叠区或入口计数。
  assert.doesNotMatch(html, /other-task/);
  assert.doesNotMatch(html, /other-command/);
  assert.doesNotMatch(html, /其他会话名称/);
  assert.doesNotMatch(html, /other-session-tasks/);
  assert.doesNotMatch(html, /tasks\.otherSessions/);
  assert.doesNotMatch(html, /tasks\.thisSession/, "全是当前会话，不再逐条标注归属");
  // 面板结构不变：两类记录仍带完整时间。
  assert.equal((html.match(/dateTime="2026-01-02T03:04:00.000Z"/g) ?? []).length, 2);
  assert.match(html, /tasks\.createdAt/);
  assert.match(html, /tasks\.startedAt/);
  // 只有其他会话的后台记录时，入口不出现。
  assert.equal(render(data, { tasks: [foreignTask], commands: [foreignCommand] }), "");
});
test("入口只说「任务」，两类各一个图标计数，已结束的收进折叠区", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "open-task", prompt: "check", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const finishedTask = { ...task, id: "done", name: "finished-task", schedule: { kind: "once", at: createdAt }, nextRunAt: null };
  const running = { id: "run", sessionId: "current", cwd: "/project", command: "npm test", label: "running-command", status: "running", startedAt: createdAt };
  const exited = { ...running, id: "exited", label: "finished-command", status: "exited", endedAt: createdAt + 1000 };
  const data = { enabled: true, servers: [], configs: [], errors: [] };

  const collapsed = render(data, { tasks: [task, finishedTask], commands: [running, exited] });
  assert.match(collapsed, /class="extension-widget-key">tasks\.triggerShort<\/span>/, "定时任务和后台命令合并成一个词");
  assert.equal((collapsed.match(/scheduled-tasks-count/g) ?? []).length, 2, "两类各一个图标计数");
  assert.deepEqual(
    [...collapsed.matchAll(/scheduled-tasks-count"[^>]*>.*?<\/svg>(\d+)<\/span>/g)].map((m) => m[1]),
    ["1", "1"],
    "只统计未结束的任务与后台命令，已结束的不计入数字",
  );

  // 只有一类未结束时只出现那一类的图标计数；只有已结束时不显示数字徽标。
  assert.equal((render(data, { commands: [running] }).match(/scheduled-tasks-count/g) ?? []).length, 1);
  assert.equal((render(data, { tasks: [task] }).match(/scheduled-tasks-count/g) ?? []).length, 1);
  const finishedOnly = render(data, { tasks: [finishedTask], commands: [exited] });
  assert.match(finishedOnly, /class="extension-widget-key">tasks\.triggerShort<\/span>/, "仅有已结束记录时入口保留");
  assert.doesNotMatch(finishedOnly, /scheduled-tasks-count/, "已结束的记录不在任务后面显示数字");

  // 其他会话的运行中记录不计入当前会话的数字。
  const foreignRunning = { ...running, id: "foreign-run", sessionId: "other" };
  const foreignTask = { ...task, id: "foreign-task", sessionId: "other" };
  const withForeign = render(data, { tasks: [finishedTask, foreignTask], commands: [exited, foreignRunning] });
  assert.doesNotMatch(withForeign, /scheduled-tasks-count/, "非本会话的运行中记录不在任务后面显示数字");
  assert.equal(render(data, { tasks: [foreignTask], commands: [foreignRunning], sessionId: undefined }), "");
  const panel = render(data, { tasks: [task, finishedTask], commands: [running, exited], open: true });
  const details = panel.indexOf('class="finished-tasks"');
  assert.ok(details > 0, "已结束的记录放进折叠区");
  assert.ok(panel.indexOf("open-task") < details, "没结束的留在正文");
  assert.ok(panel.indexOf("running-command") < details);
  assert.ok(panel.indexOf("finished-task") > details, "已结束的任务折叠");
  assert.ok(panel.indexOf("finished-command") > details, "已结束的命令折叠");
});

test.after(async () => {
  delete globalThis.__devServersShelfData;
  delete globalThis.__shelfTasks;
  delete globalThis.__shelfCommands;
  delete globalThis.__shelfOpen;
  await rm(fixtures, { recursive: true, force: true });
});
