import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { commandNameOf, extensionPhaseLabel, phaseHint, phaseLabel, runStatePhase, truncateCommand } = await jiti.import("./chat-phase-label.ts");

/** Translate that echoes the key plus params, so assertions read as intent. */
const t = (key, params = {}) => (Object.keys(params).length ? `${key}:${JSON.stringify(params)}` : key);

test("reports the phase the stream is actually in", () => {
  assert.equal(phaseLabel({ kind: "waiting_model" }, t), "chat.waitingModel");
  assert.equal(phaseLabel({ kind: "running_command" }, t), "chat.runningCommand");
  assert.equal(phaseLabel(null, t), null);
  assert.equal(phaseLabel(undefined, t), null);
});

test("describes the tools currently running", () => {
  const one = phaseLabel({ kind: "running_tools", tools: [{ name: "Read" }] }, t);
  assert.equal(one, 'chat.runningNamedTool:{"name":"Read"}');

  assert.equal(
    phaseLabel({ kind: "running_tools", tools: [{ name: "Read" }, { name: "Grep" }] }, t),
    'chat.runningTools:{"names":"Read, Grep"}',
  );
  assert.equal(phaseLabel({ kind: "running_tools", tools: [] }, t), "chat.runningTool");

  // 最新一次更新的工具带进度时只显示它的实时输出末行：工具名和输出就在上方的工具卡片里。
  assert.equal(
    phaseLabel({ kind: "running_tools", tools: [{ name: "Read" }, { name: "Bash", progress: "3/5" }] }, t),
    "3/5",
  );
  // 只有更早的工具带进度时退回工具名，不把旧输出留在这一行。
  assert.equal(
    phaseLabel({ kind: "running_tools", tools: [{ name: "Bash", progress: "3/5" }, { name: "Read" }] }, t),
    'chat.runningTools:{"names":"Bash, Read"}',
  );
});

test("compaction overrides the model phase so a long compaction does not read as a hang", () => {
  // The reported bug: a turn enters auto-compaction, the stream has not produced a token
  // yet, and the status still says "waiting for model".
  assert.equal(phaseLabel({ kind: "waiting_model" }, t, true), "chat.compacting");
  assert.equal(phaseLabel({ kind: "running_tools", tools: [{ name: "Read" }] }, t, true), "chat.compacting");
  assert.equal(phaseLabel(null, t, true), "chat.compacting");
});

test("a coarse run state does not downgrade a running tool", () => {
  const running = { kind: "running_tools", tools: [{ name: "Bash" }] };
  // A refresh mid-tool: the state read only reports isStreaming, and the tool it
  // is waiting on already reached the client from the stream replay.
  assert.equal(runStatePhase(running, true), running);
  assert.equal(runStatePhase(running, false), running);

  assert.deepEqual(runStatePhase(null, true), { kind: "waiting_model" });
  assert.deepEqual(runStatePhase({ kind: "waiting_model" }, true), { kind: "waiting_model" });
  assert.deepEqual(runStatePhase({ kind: "waiting_model" }, false), { kind: "running_command" });
  // No tools left to report: the phase falls back to the state.
  assert.deepEqual(runStatePhase({ kind: "running_tools", tools: [] }, true), { kind: "waiting_model" });
});

test("compaction flag off keeps the phase label", () => {
  assert.equal(phaseLabel({ kind: "waiting_model" }, t, false), "chat.waitingModel");
  assert.equal(phaseLabel({ kind: "running_command" }, t, false), "chat.runningCommand");
});

test("queued messages count beside the compaction label, and nowhere else", () => {
  assert.equal(phaseLabel(null, t, true, 2), 'chat.compactingQueued:{"count":2}');
  assert.equal(phaseLabel(null, t, true, 0), "chat.compacting");
  // A queued message does not change a running phase's label.
  assert.equal(phaseLabel({ kind: "waiting_model" }, t, false, 2), "chat.waitingModel");
});

test("names the extension command that is running, and points at its own cancel", () => {
  const phase = { kind: "running_command" };
  // pi 跑扩展命令时没有模型回合，只有这条命令行能说明是哪条命令占着会话。
  assert.equal(phaseLabel(phase, t, false, 0, "/review 最近的改动"), 'chat.runningExtensionCommand:{"command":"/review 最近的改动"}');
  assert.equal(phaseLabel(phase, t, false, 0), "chat.runningCommand");
  assert.equal(phaseHint(phase, t, "/review 最近的改动"), 'chat.runningExtensionCommandHint:{"command":"review"}');
  // 模型回合进行中没有取消提示：那是另一条路径。
  assert.equal(phaseHint({ kind: "waiting_model" }, t, "/review"), null);
  assert.equal(phaseHint(phase, t), null);
});

test("a long command line is shortened for the status row", () => {
  const long = `/review ${"x".repeat(200)}`;
  assert.equal(truncateCommand("  /review  ") , "/review");
  assert.equal(truncateCommand(long).length, 121);
  assert.ok(truncateCommand(long).endsWith("…"));
  assert.equal(commandNameOf("/review a b"), "review");
  assert.equal(commandNameOf("  /skill:foo  "), "skill:foo");
  assert.equal(commandNameOf("not a command"), null);
  assert.equal(commandNameOf("/"), null);
});

test("the rendered status line is this implementation, not a copy in the component", () => {
  // ChatWindow 曾自带一份同名副本，改 lib 这里等于没改：两份行为已经漂移（进度取哪个工具、
  // 兜底文案）。这条用例把「只有一份」钉住，副本再出现就红。
  const source = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  // 用 assert.ok 而不是 assert.match：文件一百多 KB，失败时生成 diff 可能把 CPU 拖死。
  assert.ok(
    /import \{[^}]*\bphaseLabel\b[^}]*\} from "@\/lib\/chat-phase-label"/.test(source),
    "ChatWindow 应从 lib/chat-phase-label 引入 phaseLabel",
  );
  assert.ok(!/function phaseLabel\s*\(/.test(source), "ChatWindow 不应再自带 phaseLabel 副本");
});
