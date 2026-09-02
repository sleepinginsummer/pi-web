import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PATCH_MARKER, patchPiSdkMidRunCompaction } from "./pi-sdk-mid-run-compaction-patch.mjs";

const ORIGINAL_METHOD = `    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const previousContext = previousSnapshot?.context ?? turn.context;
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }`;

const FIXTURE = `
const calculateContextTokens = (usage) => usage.totalTokens;
const estimateContextTokens = (messages) => ({ tokens: messages.estimatedTokens ?? 0 });
const shouldCompact = (tokens, window, settings) => settings.enabled && tokens > window - settings.reserveTokens;
const getLatestCompactionEntry = (entries) => entries.findLast((entry) => entry.type === "compaction") ?? null;
export class FixtureSession {
    constructor() {
        this.entries = [];
        this.model = { provider: "provider", id: "model", contextWindow: 1000 };
        this.settingsManager = { getCompactionSettings: () => ({ enabled: true, reserveTokens: 100 }) };
        this.sessionManager = { getBranch: () => this.entries };
        this.agent = {
            state: { messages: ["original"], tools: ["tool"], model: this.model, thinkingLevel: "high" },
        };
        this._baseSystemPrompt = "system";
        this.compactionRuns = 0;
    }
    async _runAutoCompaction() {
        this.compactionRuns++;
        this.entries.push({ type: "compaction", id: String(this.compactionRuns) });
        this.agent.state.messages = ["summary", "recent"];
        return false;
    }
${ORIGINAL_METHOD}
}
`;

function importPatchedFixture(source) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-mid-run-compaction-"));
  const file = join(directory, "fixture.mjs");
  writeFileSync(file, source, "utf8");
  return import(`${pathToFileURL(file).href}?test=${Date.now()}`).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function turn(totalTokens, toolResults = [{}]) {
  const messages = ["original"];
  Object.defineProperty(messages, "estimatedTokens", { value: 0, writable: true });
  return {
    message: {
      provider: "provider",
      model: "model",
      stopReason: "toolUse",
      usage: { totalTokens },
    },
    toolResults,
    context: { messages, systemPrompt: "old", tools: [] },
  };
}

test("在工具批次结束且超过阈值时压缩，并把压缩后的上下文交给下一轮", async () => {
  const result = patchPiSdkMidRunCompaction(FIXTURE);
  const { FixtureSession } = await importPatchedFixture(result.source);
  const session = new FixtureSession();
  session._installAgentNextTurnRefresh();

  const snapshot = await session.agent.prepareNextTurnWithContext(turn(901));

  assert.equal(session.compactionRuns, 1);
  assert.deepEqual(snapshot.context.messages, ["summary", "recent"]);
  assert.deepEqual(snapshot.context.tools, ["tool"]);
  assert.equal(snapshot.context.systemPrompt, "system");
});

test("未超过阈值或没有工具结果时保持原有上下文", async () => {
  const { FixtureSession } = await importPatchedFixture(patchPiSdkMidRunCompaction(FIXTURE).source);
  const session = new FixtureSession();
  session._installAgentNextTurnRefresh();

  const belowThreshold = await session.agent.prepareNextTurnWithContext(turn(900));
  const finalTurn = await session.agent.prepareNextTurnWithContext(turn(950, []));

  assert.equal(session.compactionRuns, 0);
  assert.deepEqual(belowThreshold.context.messages, ["original"]);
  assert.deepEqual(finalTurn.context.messages, ["original"]);
});

test("工具结果把完整上下文推过阈值时仍会压缩", async () => {
  const { FixtureSession } = await importPatchedFixture(patchPiSdkMidRunCompaction(FIXTURE).source);
  const session = new FixtureSession();
  session._installAgentNextTurnRefresh();
  const oversizedTurn = turn(800);
  oversizedTurn.context.messages.estimatedTokens = 901;

  await session.agent.prepareNextTurnWithContext(oversizedTurn);

  assert.equal(session.compactionRuns, 1);
});

test("补丁幂等、语法有效，并在 SDK 布局变化时关闭失败", () => {
  const first = patchPiSdkMidRunCompaction(FIXTURE);
  assert.equal(first.status, "patched");
  assert.match(first.source, new RegExp(PATCH_MARKER));

  const directory = mkdtempSync(join(tmpdir(), "pi-web-mid-run-compaction-syntax-"));
  const file = join(directory, "fixture.mjs");
  try {
    writeFileSync(file, first.source, "utf8");
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const second = patchPiSdkMidRunCompaction(first.source);
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
  const migrated = patchPiSdkMidRunCompaction(first.source.replaceAll(PATCH_MARKER, "pi-web-mid-run-auto-compaction-v1").replace(
    /        \/\/ Provider usage was measured[\s\S]*?        const contextTokens = Math\.max\(directContextTokens, estimatedContextTokens\);/,
    `        const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
        const contextTokens = directContextTokens > 0
            ? directContextTokens
            : estimateContextTokens(turn.context.messages).tokens;`,
  ));
  assert.equal(migrated.status, "patched");
  assert.match(migrated.source, new RegExp(PATCH_MARKER));
  assert.match(migrated.source, /Math\.max\(directContextTokens, estimatedContextTokens\)/);
  assert.throws(
    () => patchPiSdkMidRunCompaction("export const changedUpstream = true;"),
    /does not match the reviewed 0\.84\.3 layout/,
  );
});

test("已安装 SDK 带有中途压缩补丁标记", () => {
  const agentSessionPath = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
    import.meta.url,
  );
  const packagePath = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
  assert.match(readFileSync(agentSessionPath, "utf8"), new RegExp(PATCH_MARKER));
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "0.84.3");
});
