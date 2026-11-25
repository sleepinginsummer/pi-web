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
await writeFile(join(fixtures, "useScheduledTasks.mjs"), `export function useScheduledTasks() { return { data: globalThis.__shelfTasks ?? null, error: null, actionError: globalThis.__shelfActionError ?? null, pending: new Set(), act() {} }; } export function isScheduledTaskPending(task) { return task.enabled && task.nextRunAt !== null; }`);
await writeFile(join(fixtures, "useBackgroundCommands.mjs"), `export function useBackgroundCommands() { return { data: globalThis.__shelfCommands ?? null, error: null, actionError: globalThis.__shelfActionError ?? null, pending: new Set(), act() {} }; } export function useBackgroundCommandOutput() { return null; }`);

const source = (await readFile(new URL("./DevServersShelf.tsx", import.meta.url), "utf8"))
  .replace('from "@/hooks/useDevServers"', `from ${JSON.stringify(join(fixtures, "useDevServers.mjs"))}`)
  .replace('from "@/hooks/useI18n"', `from ${JSON.stringify(join(fixtures, "useI18n.mjs"))}`)
  .replace('from "@/hooks/useScheduledTasks"', `from ${JSON.stringify(join(fixtures, "useScheduledTasks.mjs"))}`)
  .replace('from "@/hooks/useBackgroundCommands"', `from ${JSON.stringify(join(fixtures, "useBackgroundCommands.mjs"))}`)
  .replace("const [open, setOpen] = useState<ShelfSection | null>(null)", "const [open, setOpen] = useState(globalThis.__shelfOpen ?? null)");
const { DevServersShelf, closeStaleShelfSection } = jiti.evalModule(source, { filename: new URL("./DevServersShelf.probe.tsx", import.meta.url).pathname });

const declared = { name: "web", source: ".pi/launch.json", managed: true };
const running = { id: "1", name: "web", status: "running", managed: true, url: "http://localhost:3000" };
const stopped = { id: "2", name: "stopped-server", status: "stopped", managed: true, startedAt: 0, endedAt: 1000 };
const failed = { id: "3", name: "failed-server", status: "failed", managed: true, startedAt: 0, endedAt: 1000, error: "spawn ENOENT" };

function render(data, { tasks = [], commands = [], sessionId = "current", open = null, actionError = null } = {}) {
  globalThis.__devServersShelfData = data;
  globalThis.__shelfTasks = { enabled: true, tasks };
  globalThis.__shelfCommands = { enabled: true, commands };
  globalThis.__shelfActionError = actionError;
  globalThis.__shelfOpen = open;
  return renderToStaticMarkup(React.createElement(DevServersShelf, { cwd: "/project", sessionId }));
}

// 入口上的「图标 + 数量」徽标，按出现顺序返回数字：服务器和任务共用同一套结构。
function countBadges(html) {
  return [...html.matchAll(/<span class="dev-servers-count"[^>]*><svg[\s\S]*?<\/svg>(\d+)<\/span>/g)].map((match) => Number(match[1]));
}

test("只有已启动的服务器或启动配置错误才显示服务器入口", () => {
  assert.equal(render({ enabled: true, servers: [], configs: [], errors: [] }), "");
  assert.equal(render({ enabled: true, servers: [], configs: [declared], errors: [] }), "", "仅声明过 launch 配置不显示入口");

  const withErrors = render({ enabled: true, servers: [], configs: [], errors: [".pi/launch.json: invalid JSON"] });
  assert.match(withErrors, /class="dev-servers-shelf"/, "启动配置错误必须留有入口");
  assert.match(withErrors, /aria-label="servers\.triggerErrors"/, "启动配置错误时读屏要说明问题");
  assert.match(withErrors, /class="dev-servers-error-dot"/, "启动配置错误时入口要带告警点");
  assert.deepEqual(countBadges(withErrors), [], "没有运行中的服务器时不要显示 0 个运行中");
});

test("服务器入口与任务入口分开，服务器用图标+运行数量", () => {
  const html = render({ enabled: true, servers: [running], configs: [], errors: [] });
  assert.match(html, /aria-label="servers\.triggerLabel"/);
  assert.deepEqual(countBadges(html), [1], "运行中的服务器显示图标+数量");
  assert.match(html, /class="extension-widget-key">servers\.trigger</);
  assert.doesNotMatch(html, /tasks\.triggerShort/, "没有任务时不显示任务入口");
  assert.doesNotMatch(html, /dev-servers-error-dot/, "配置没问题时不要带告警点");

  const stoppedOnly = render({ enabled: true, servers: [stopped], configs: [], errors: [] });
  assert.match(stoppedOnly, /class="extension-widget-key">servers\.trigger</, "已停止的服务器仍保留入口");
  assert.deepEqual(countBadges(stoppedOnly), [], "已停止的服务器不计入运行数量");
});

test("两个入口的计数紧跟在文字后，折叠符在最右", () => {
  const html = render(
    { enabled: true, servers: [running], configs: [], errors: [] },
    { tasks: [{ id: "t1", project: "/project", sessionId: "current", prompt: "p", createdAt: 1, enabled: true, nextRunAt: Date.now() + 60_000, lastRunAt: null, lastError: null, delivery: "followUp", cron: null }] },
  );
  for (const label of ["servers.trigger", "tasks.triggerShort"]) {
    const start = html.indexOf(`class="extension-widget-key">${label}<`);
    assert.ok(start > 0, label);
    const end = html.indexOf("</button>", start);
    const trigger = html.slice(start, end);
    const badge = trigger.indexOf("dev-servers-count");
    const chevron = trigger.indexOf("extension-widget-placement");
    assert.ok(badge !== -1 && badge < chevron, `${label}：数量要在折叠符之前`);
    assert.ok(!/extension-widget-placement[\s\S]*extension-widget-key/.test(trigger), `${label}：折叠符不能回到最前`);
  }
});

test("运行中的服务器与配置错误同时存在时两个标记都保留", () => {
  const html = render({ enabled: true, servers: [running], configs: [], errors: [".pi/launch.json: invalid JSON"] });
  assert.match(html, /aria-label="servers\.triggerErrors"/);
  assert.deepEqual(countBadges(html), [1]);
  assert.match(html, /class="dev-servers-error-dot"/);
});

test("已停止的服务器收进折叠区，仍在正文保留重启入口", () => {
  const html = render({ enabled: true, servers: [running, stopped], configs: [{ name: "api", source: ".pi/launch.json", managed: true }], errors: [] }, { open: "servers" });
  assert.match(html, /<section id="[^"]*-servers"/, "只展开服务器面板");
  assert.doesNotMatch(html, /<section id="[^"]*-tasks"/);

  const details = html.indexOf('class="finished-tasks"');
  assert.ok(details > 0, "已停止的服务器放进折叠区");
  assert.ok(html.indexOf(">web</span>") < details, "运行中的服务器留在正文");
  assert.ok(html.indexOf(">stopped-server</span>") > details, "已停止的服务器折叠");
  assert.ok(html.indexOf("servers.declared") < details, "已声明未运行的启动按钮仍在正文，停止后能直接重启");
  assert.match(html, /aria-label="servers\.start api"/);
});

test("启动失败的服务器留在正文，不计入运行数量", () => {
  const data = { enabled: true, servers: [failed], configs: [], errors: [] };
  assert.match(render(data), /class="extension-widget-key">servers\.trigger</, "失败的服务器仍保留服务器入口");
  assert.deepEqual(countBadges(render(data)), [], "失败的服务器不计入运行数量");

  const html = render(data, { open: "servers" });
  assert.match(html, /failed-server/, "启动失败的服务器在面板正文可见");
  assert.doesNotMatch(html, /finished-tasks/, "启动失败的服务器不折叠");
  assert.match(html, /class="dev-server-row is-failed"/, "行上保留失败状态");
});

test("只列当前会话自己的定时任务与后台命令", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "current-task", prompt: "check", schedule: { kind: "once" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const command = { id: "cmd", sessionId: "current", cwd: "/project", command: "test", label: "current-command", status: "exited", startedAt: createdAt, endedAt: createdAt + 1000 };
  const foreignTask = { ...task, id: "other", sessionId: "other", cwd: "/project", name: "other-task", sessionLabel: "其他会话名称" };
  const foreignCommand = { ...command, id: "other-cmd", sessionId: "other", label: "other-command" };
  const data = { enabled: true, servers: [], configs: [], errors: [] };
  const html = render(data, { tasks: [task, foreignTask], commands: [command, foreignCommand], open: "tasks" });
  assert.match(html, /<section id="[^"]*-tasks"/, "只展开任务面板");
  assert.doesNotMatch(html, /<section id="[^"]*-servers"/);

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
  // 只有其他会话的后台记录时，任务入口不出现。
  assert.equal(render(data, { tasks: [foreignTask], commands: [foreignCommand] }), "");
});

test("任务入口两类各一个图标计数，已结束的收进折叠区", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "open-task", prompt: "check", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const finishedTask = { ...task, id: "done", name: "finished-task", schedule: { kind: "once", at: createdAt }, nextRunAt: null };
  const running = { id: "run", sessionId: "current", cwd: "/project", command: "npm test", label: "running-command", status: "running", startedAt: createdAt };
  const exited = { ...running, id: "exited", label: "finished-command", status: "exited", endedAt: createdAt + 1000 };
  const data = { enabled: true, servers: [], configs: [], errors: [] };

  const collapsed = render(data, { tasks: [task, finishedTask], commands: [running, exited] });
  assert.match(collapsed, /class="extension-widget-key">tasks\.triggerShort<\/span>/, "定时任务和后台命令合并成一个词");
  assert.doesNotMatch(collapsed, /servers\.trigger/, "没有服务器时不出现服务器入口");
  assert.deepEqual(countBadges(collapsed), [1, 1], "只统计未结束的任务与后台命令，已结束的不计入数字");

  // 只有一类未结束时只出现那一类的图标计数；只有已结束时不显示数字徽标。
  assert.deepEqual(countBadges(render(data, { commands: [running] })), [1]);
  assert.deepEqual(countBadges(render(data, { tasks: [task] })), [1]);
  const finishedOnly = render(data, { tasks: [finishedTask], commands: [exited] });
  assert.match(finishedOnly, /class="extension-widget-key">tasks\.triggerShort<\/span>/, "仅有已结束记录时入口保留");
  assert.deepEqual(countBadges(finishedOnly), [], "已结束的记录不在任务后面显示数字");

  // 其他会话的运行中记录不计入当前会话的数字。
  const foreignRunning = { ...running, id: "foreign-run", sessionId: "other" };
  const foreignTask = { ...task, id: "foreign-task", sessionId: "other" };
  const withForeign = render(data, { tasks: [finishedTask, foreignTask], commands: [exited, foreignRunning] });
  assert.deepEqual(countBadges(withForeign), [], "非本会话的运行中记录不在任务后面显示数字");
  // 上次触发失败的未结束任务在任务入口带告警点，不影响服务器入口。
  const failed = render(data, { tasks: [{ ...task, id: "failed", name: "failed-task", lastStatus: "error", lastError: "boom" }] });
  assert.match(failed, /class="dev-servers-error-dot"/, "任务失败时任务入口带告警点");
  assert.doesNotMatch(failed, /servers\.trigger/, "没有服务器时不出现服务器入口");
  assert.equal(render(data, { tasks: [foreignTask], commands: [foreignRunning], sessionId: undefined }), "");
  const panel = render(data, { tasks: [task, finishedTask], commands: [running, exited], open: "tasks" });
  const details = panel.indexOf('class="finished-tasks"');
  assert.ok(details > 0, "已结束的记录放进折叠区");
  assert.ok(panel.indexOf("open-task") < details, "没结束的留在正文");
  assert.ok(panel.indexOf("running-command") < details);
  assert.ok(panel.indexOf("finished-task") > details, "已结束的任务折叠");
  assert.ok(panel.indexOf("finished-command") > details, "已结束的命令折叠");
});

test("服务器和任务同时存在时是两个独立入口，各自一个面板", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "open-task", prompt: "check", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const command = { id: "cmd", sessionId: "current", cwd: "/project", command: "npm test", label: "bg-command", status: "running", startedAt: createdAt };
  const data = { enabled: true, servers: [running], configs: [], errors: [] };

  const triggers = render(data, { tasks: [task], commands: [command] });
  const serverKey = triggers.indexOf('class="extension-widget-key">servers.trigger<');
  const taskKey = triggers.indexOf('class="extension-widget-key">tasks.triggerShort<');
  assert.ok(serverKey > 0 && taskKey > serverKey, "服务器入口在前，任务入口独立排在后面");
  assert.deepEqual(countBadges(triggers), [1, 1, 1], "服务器、定时任务、后台命令各一个图标计数");
  assert.match(triggers, /aria-label="servers\.triggerLabel"/);
  assert.match(triggers, /aria-label="tasks\.triggerShort · tasks\.triggerLabel · bg\.triggerLabel"/, "任务入口读屏以可见的「任务」开头并带两类数量");

  const serverPanel = render(data, { tasks: [task], commands: [command], open: "servers" });
  assert.match(serverPanel, /<section id="[^"]*-servers"/);
  assert.doesNotMatch(serverPanel, /<section id="[^"]*-tasks"/, "服务器面板不混入任务列表");
  const taskPanel = render(data, { tasks: [task], commands: [command], open: "tasks" });
  assert.match(taskPanel, /<section id="[^"]*-tasks"/);
  assert.doesNotMatch(taskPanel, /<section id="[^"]*-servers"/, "任务面板不混入服务器列表");
});

test("暂停的任务不进徽标计数，和读屏数字一致", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const pending = { id: "p1", sessionId: "current", cwd: "/project", name: "pending", prompt: "a", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const paused = { ...pending, id: "p2", name: "paused", enabled: false };
  const data = { enabled: true, servers: [], configs: [], errors: [] };

  assert.deepEqual(countBadges(render(data, { tasks: [pending] })), [1]);
  assert.deepEqual(countBadges(render(data, { tasks: [paused] })), [], "暂停的任务不计入“待触发”");
  assert.deepEqual(countBadges(render(data, { tasks: [paused, pending] })), [1]);
  const panel = render(data, { tasks: [paused, pending], open: "tasks" });
  const folded = panel.indexOf('<details class="finished-tasks">');
  assert.ok(folded > 0, "暂停任务归入默认关闭的分组");
  assert.ok(panel.indexOf('aria-label="tasks.runNow pending"') < folded, "待触发任务仍在正文");
  assert.ok(panel.indexOf('aria-label="tasks.runNow paused"') > folded, "暂停任务不与待触发任务混排");
  assert.match(panel, /tasks\.inactiveSection/);
  // 徽标数和读屏用的都是 pendingTaskCount，源码里不再用 openTasks 计数。
  assert.match(source, /\{pendingTaskCount > 0 && \(\n\s*<CountBadge count=\{pendingTaskCount\}/);
});

test("删除失败时面板不提前收起，错误提示留在面板里", () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4);
  const task = { id: "task", sessionId: "current", cwd: "/project", name: "open-task", prompt: "check", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, nextRunAt: createdAt + 60000, createdAt };
  const data = { enabled: true, servers: [], configs: [], errors: [] };

  const html = render(data, { tasks: [task], open: "tasks", actionError: "删除失败：任务正在运行" });
  assert.match(html, /<section id="[^"]*-tasks"/);
  assert.match(html, /role="alert" class="dev-server-error">删除失败：任务正在运行</);
});

test("面板内容清空后才收起，失败时保持展开", () => {
  // 记录还在（删除失败或被轮询补回）时不收起。
  assert.equal(closeStaleShelfSection("tasks", false, true), "tasks");
  assert.equal(closeStaleShelfSection("servers", true, false), "servers");
  // 最后一条真的没了才收起。
  assert.equal(closeStaleShelfSection("tasks", false, false), null);
  assert.equal(closeStaleShelfSection("servers", false, false), null);
  assert.equal(closeStaleShelfSection(null, true, true), null);
});

test.after(async () => {
  delete globalThis.__devServersShelfData;
  delete globalThis.__shelfTasks;
  delete globalThis.__shelfCommands;
  delete globalThis.__shelfActionError;
  delete globalThis.__shelfOpen;
  await rm(fixtures, { recursive: true, force: true });
});
