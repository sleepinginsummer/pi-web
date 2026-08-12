import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("tracks detached subagents by id across parent turns", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const agentStartSource = eventSource.slice(
    eventSource.indexOf('case "agent_start"'),
    eventSource.indexOf('case "agent_end"'),
  );

  assert.match(eventSource, /completed\.toolName === "subagent_spawn" && !completed\.isError/);
  assert.match(eventSource, /pendingDetachedSubagentIdsRef\.current\.add\(agentId\)/);
  assert.doesNotMatch(agentStartSource, /pendingDetachedSubagentIdsRef/);
});

test("removes only completed detached subagent ids", () => {
  const completionSource = source.slice(
    source.indexOf("function completedDetachedSubagentIds"),
    source.indexOf("function pendingDetachedSubagentIds"),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(completionSource, /message\.customType !== "pi-subagent-completion"/);
  assert.match(completionSource, /details\?\.completions/);
  assert.match(eventSource, /completedDetachedSubagentIds\(completed\)/);
  assert.match(eventSource, /pendingDetachedSubagentIdsRef\.current\.delete\(agentId\)/);
});

test("marks timed-out detached subagents terminal from inspect results", () => {
  const deriveSource = source.slice(
    source.indexOf("function deriveDetachedSubagentStatuses"),
    source.indexOf("export interface QueuedMessages"),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(deriveSource, /message\.toolName === "subagent_inspect"/);
  assert.match(deriveSource, /run\.state !== "completed" && run\.state !== "failed"/);
  assert.match(deriveSource, /status\.state = run\.state/);
  assert.match(eventSource, /completed\.toolName === "subagent_inspect"/);
  assert.match(eventSource, /inspectedTerminalIds/);
});

test("restores unfinished detached subagents from session history", () => {
  const rebuildSource = source.slice(
    source.indexOf("function pendingDetachedSubagentIds"),
    source.indexOf("export interface QueuedMessages"),
  );
  const loadSource = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const scheduleSessionListRefresh"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(rebuildSource, /pending\.add\(agentId\)/);
  assert.match(rebuildSource, /completedDetachedSubagentIds\(message\)/);
  assert.match(loadSource, /pendingDetachedSubagentIdsRef\.current = pendingDetachedSubagentIds\(loadedMessages\)/);
  assert.match(mountSource, /pendingDetachedSubagentIdsRef\.current\.size > 0/);
  assert.match(mountSource, /connectEvents\(session\.id\)/);
  assert.doesNotMatch(
    mountSource.slice(mountSource.indexOf("pendingDetachedSubagentIdsRef.current.size > 0")),
    /setAgentRunning\(true\)|dispatch\(\{ type: "start" \}\)/,
  );
});

test("finishes ordinary prompts immediately but keeps active detached subagents running", () => {
  const settleSource = source.slice(
    source.indexOf("const settleIdleSession"),
    source.indexOf("const waitForPromptSettlement = useCallback"),
  );
  const graceSource = source.slice(
    source.lastIndexOf("const scheduleEventStreamClose"),
    source.indexOf("const settleIdleSession", source.lastIndexOf("const scheduleEventStreamClose")),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(settleSource, /void finishPromptWithoutStream\(sid, runId\)/);
  assert.doesNotMatch(settleSource, /pendingDetachedSubagentIdsRef/);
  assert.match(graceSource, /pendingDetachedSubagentIdsRef\.current\.size > 0/);
  assert.match(source, /pendingDetachedSubagentIdsRef\.current\.size === 0\) closeEvents\(\)/);
  assert.match(eventSource, /case "agent_settled":\s*case "prompt_done":[\s\S]*?settleIdleSession\(sessionIdRef\.current, promptRunIdRef\.current\)/);
});

test("keeps reconciliation active until compaction settles", () => {
  const settlementSource = source.slice(
    source.indexOf("const waitForPromptSettlement = useCallback"),
    source.indexOf("waitForPromptSettlementRef.current = waitForPromptSettlement"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(settlementSource, /!state\.isStreaming && !state\.isPromptRunning && !state\.isCompacting/);
  assert.match(mountSource, /isStreaming \|\| agentState\.state\?\.isPromptRunning \|\| agentState\.state\?\.isCompacting/);
  assert.match(mountSource, /connectEvents\(session\.id\)/);
  assert.match(mountSource, /state\.isPromptRunning \|\| agentState\.state\.isCompacting/);
});

test("reloads compacted context without the longer live-message cache", () => {
  const compactLoadSource = source.slice(
    source.indexOf("const loadCompactedSession = useCallback"),
    source.indexOf("const loadContext = useCallback"),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const manualCompactSource = source.slice(
    source.indexOf("const handleCompact = useCallback"),
    source.indexOf("const loadModels = useCallback"),
  );
  const slashCompactSource = source.slice(
    source.indexOf('case "compact": {'),
    source.indexOf('case "reload": {'),
  );

  assert.match(compactLoadSource, /liveSessionMessages\.delete\(sid\);[\s\S]*?loadSession\(sid, showLoading\)/);
  assert.match(eventSource, /case "compaction_end":[\s\S]*?loadCompactedSession\(sessionIdRef\.current\)/);
  assert.match(manualCompactSource, /await loadCompactedSession\(sid, true\)/);
  assert.match(slashCompactSource, /await loadCompactedSession\(sid, true\)/);
});

test("refuses a normal send while the hook knows an asynchronous run is active", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(sendSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current\) return false;/);
  assert.match(sendSource, /return Boolean\(sentSessionId\);/);
});

test("发送消息时异步刷新当前工作目录的 Git 分支", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(sendSource, /void fetch\(`\/api\/git\/context\?cwd=\$\{encodeURIComponent\(activeCwd\)\}`/);
  assert.match(sendSource, /if \(response\.ok\) \{[\s\S]*?onSessionListRefresh\?\.\(\)/);
  assert.match(sendSource, /刷新当前 Git 分支失败/);
  assert.doesNotMatch(sendSource, /await fetch\(`\/api\/git\/context/);
});

test("首条消息落盘时在节流窗口结束后补刷会话列表", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const messageEndSource = eventSource.slice(
    eventSource.indexOf('case "message_end"'),
    eventSource.indexOf('case "tool_execution_start"'),
  );

  assert.match(messageEndSource, /onSessionListRefresh\?\.\(\);[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?onSessionListRefresh\?\.\(\)/);
});

test("临时会话升级前同步清空已提交输入，避免旧草稿在 key 切换时回写", () => {
  const promoteSource = source.slice(
    source.indexOf("const promoteNewSession = useCallback"),
    source.indexOf("const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /opts\.chatInputRef\?\.current\?\.clearAcceptedPrompt\(\)/);
  assert.ok(
    promoteSource.indexOf("clearAcceptedPrompt()") < promoteSource.indexOf("onSessionCreated?.({"),
    "输入必须在父级切换 draftKey 前清空",
  );
});

test("surfaces auto-continue events from the RPC wrapper as notices", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  assert.match(eventSource, /case "auto_continue":[\s\S]*?已自动继续/);
  assert.match(eventSource, /case "auto_continue_stopped":[\s\S]*?自动继续已停止/);
});
