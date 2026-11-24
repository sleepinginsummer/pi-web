import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const { reducePendingNewSession, DEFAULT_PENDING_NEW_SESSION_CONTROL } = await createJiti(import.meta.url).import("../lib/pending-new-session.ts");
const { beginDraftModelSwitch, getDraftModelSwitch, isLatestDraftModelSwitch, registerDraftModelSwitch, waitForDraftModelSwitchTask } = await createJiti(import.meta.url).import("../lib/draft-model-switch.ts");

function deferred() {
  let resolve;
  const task = new Promise((done) => { resolve = done; });
  return { task, resolve };
}

for (const settleOld of [true, false]) test(`创建等待连续 25 次被取代，旧任务${settleOld ? "结算" : "永久挂起"}时仍采用最新选择`, async () => {
  const start = source.indexOf("const awaitDraftModelSwitch = useCallback");
  const end = source.indexOf("const currentNewSessionSettings = useCallback", start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cwd = `/draft-25-${settleOld}`;
  let version = beginDraftModelSwitch(cwd);
  let pending = deferred();
  registerDraftModelSwitch(cwd, version, pending.task);
  const local = { current: getDraftModelSwitch(cwd) };
  const adopted = [];
  const wait = new Function("useCallback", "draftModelSwitchRef", "newSessionCwd", "getDraftModelSwitch", "isLatestDraftModelSwitch", "applyDraftSelection", "waitForDraftModelSwitchTask", `${compiled}\nreturn awaitDraftModelSwitch;`)(
    (callback) => callback, local, cwd, getDraftModelSwitch, isLatestDraftModelSwitch,
    (selection) => adopted.push(selection), waitForDraftModelSwitchTask,
  );
  let finished = false;
  const waiting = wait().then(() => { finished = true; });
  for (let index = 0; index < 25; index += 1) {
    const old = pending;
    pending = deferred();
    version = beginDraftModelSwitch(cwd);
    registerDraftModelSwitch(cwd, version, pending.task);
    if (settleOld) old.resolve(null);
    // 让等待方走过 catch/await 续点，开始等新任务。
    await new Promise((done) => setImmediate(done));
    assert.equal(finished, false, `第 ${index + 1} 次替换不得提前结束创建等待`);
  }
  const selected = { model: { provider: "test", modelId: "latest" }, thinkingLevel: "high", thinkingLevelSource: "auto" };
  pending.resolve(selected);
  await waiting;
  assert.deepEqual(adopted, [selected]);
});

test("限幅后的手选值按读取时的修订号提交给草稿", () => {
  const manual = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, { type: "SET_THINKING_LEVEL", level: "max", source: "manual" });
  const model = { provider: "test", modelId: "high-only" };
  const committed = reducePendingNewSession(manual, {
    type: "SET_MODEL", model, thinkingLevel: "high", thinkingLevelSource: "manual",
    levelRevisionAtStart: manual.levelRevision,
  });
  assert.equal(committed.thinkingLevel, "high");
  assert.equal(committed.thinkingLevelSource, "manual");
  const changedAgain = reducePendingNewSession(manual, { type: "SET_THINKING_LEVEL", level: "low", source: "manual" });
  const late = reducePendingNewSession(changedAgain, {
    type: "SET_MODEL", model, thinkingLevel: "high", thinkingLevelSource: "manual",
    levelRevisionAtStart: manual.levelRevision,
  });
  assert.equal(late.thinkingLevel, "low");
});

test("默认推荐记录所属模型，手动选 auto 清除推荐归属", () => {
  const owner = { provider: "test", modelId: "default-a" };
  const recommended = reducePendingNewSession(DEFAULT_PENDING_NEW_SESSION_CONTROL, {
    type: "SET_THINKING_LEVEL", level: "high", source: "auto", recommendationModel: owner,
  });
  assert.deepEqual(recommended.recommendationModel, owner);
  const manual = reducePendingNewSession(recommended, { type: "SET_THINKING_LEVEL", level: "auto", source: "manual" });
  assert.equal(manual.thinkingLevel, "auto");
  assert.equal(manual.thinkingLevelSource, "manual");
  assert.equal(manual.recommendationModel, null);
});

test("worktree 只切 cwd 不重挂载时，工具展示和目标草稿一起恢复", () => {
  const start = source.indexOf("  useEffect(() => {", source.indexOf("const setToolPresetState ="));
  const end = source.indexOf("// 工具档位也可能是在另一个实例里改的", start);
  const effect = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const drafts = new Map();
  let cwd = "/main";
  let preferred = "read-only";
  let shown;
  let custom;
  const run = new Function("useEffect", "isNew", "sessionIdRef", "currentDraftControl", "getPreferredToolPreset", "getPreferredCustomTools", "setToolPresetState", "setCustomToolNames", "newSessionCwd", "onPendingNewSessionEvent", "setToolSelectionKnown", effect);
  const render = () => run(
    (setup, deps) => { assert.ok(deps.includes(cwd), "cwd 变化必须重跑初始化"); setup(); },
    true, { current: null }, () => drafts.get(cwd) ?? DEFAULT_PENDING_NEW_SESSION_CONTROL,
    () => preferred, () => null, (value) => { shown = value; }, (value) => { custom = value; }, cwd,
    (key, event) => drafts.set(key, reducePendingNewSession(drafts.get(key) ?? DEFAULT_PENDING_NEW_SESSION_CONTROL, event)), () => {},
  );
  render();
  assert.deepEqual(drafts.get(cwd).tools, { preset: shown, custom });
  preferred = "full"; // 模拟另一标签页改偏好。
  cwd = "/worktree";
  render();
  assert.equal(shown, "full");
  assert.deepEqual(drafts.get(cwd).tools, { preset: shown, custom });
  cwd = "/main";
  render();
  assert.equal(shown, "read-only");
  assert.deepEqual(drafts.get(cwd).tools, { preset: shown, custom });
});

test("worktree 切换推进导航代次，按新 key 重建运行时引用", async () => {
  const navigation = await readFile(new URL("./useSessionNavigation.ts", import.meta.url), "utf8");
  const start = navigation.indexOf("const updateDraftCwd = useCallback");
  const end = navigation.indexOf("const restoreWorkspaceContext", start);
  const compiled = ts.transpileModule(navigation.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cwdRef = { current: "/a" };
  let generation = 0;
  let selected;
  const update = new Function("useCallback", "newSessionCwdRef", "invalidateWorkspaceRestore", "invalidateNotificationNavigation", "bumpSessionKey", "setNewSessionCwd", "setTabOpenNewSession", `${compiled}\nreturn updateDraftCwd;`)(
    (callback) => callback, cwdRef, () => {}, () => {}, () => { generation += 1; }, (cwd) => { selected = cwd; }, () => {},
  );
  update("/b");
  assert.equal(generation, 1);
  assert.equal(selected, "/b");
  assert.equal(cwdRef.current, "/b");
  update("/b");
  assert.equal(generation, 1, "重复选择相同 worktree 不应重建");
  const app = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(app, /<ChatWindow\s+key=\{sessionKey\}/);
});

test("B 不等待同版本但属于 A 的挂起本地切模任务", { timeout: 1000 }, async () => {
  const start = source.indexOf("const awaitDraftModelSwitch = useCallback");
  const end = source.indexOf("const currentNewSessionSettings = useCallback", start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cwd = "/isolated-b";
  const version = beginDraftModelSwitch(cwd);
  const selected = { model: { provider: "test", modelId: "b" }, thinkingLevel: "high", thinkingLevelSource: "auto" };
  registerDraftModelSwitch(cwd, version, Promise.resolve(selected));
  const adopted = [];
  const wait = new Function("useCallback", "draftModelSwitchRef", "newSessionCwd", "getDraftModelSwitch", "isLatestDraftModelSwitch", "applyDraftSelection", "waitForDraftModelSwitchTask", `${compiled}\nreturn awaitDraftModelSwitch;`)(
    (callback) => callback, { current: { version, task: new Promise(() => {}) } }, cwd,
    getDraftModelSwitch, isLatestDraftModelSwitch, (value) => adopted.push(value), waitForDraftModelSwitchTask,
  );
  await wait();
  assert.deepEqual(adopted, [selected]);
});
