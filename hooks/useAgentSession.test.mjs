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
    source.indexOf("const commitContextSnapshot = useCallback"),
    source.indexOf("const scheduleSessionListRefresh"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(rebuildSource, /pending\.add\(agentId\)/);
  assert.match(rebuildSource, /completedDetachedSubagentIds\(message\)/);
  assert.match(loadSource, /pendingDetachedSubagentIdsRef\.current = pendingDetachedSubagentIds\(snapshot\.messages\)/);
  assert.match(mountSource, /pendingDetachedSubagentIdsRef\.current\.size > 0/);
  assert.match(mountSource, /connectEvents\(session\.id\)/);
  assert.doesNotMatch(
    mountSource.slice(mountSource.indexOf("pendingDetachedSubagentIdsRef.current.size > 0")),
    /setAgentRunning\(true\)|dispatch\(\{ type: "start" \}\)/,
  );
});
test("本地发送、外部启动和挂载恢复统一采用主运行入口", () => {
  const enterSource = source.slice(
    source.indexOf("const enterMainRun"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const sendSource = source.slice(
    source.indexOf("const handleSend = useCallback"),
    source.indexOf("const executeBash = useCallback"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(enterSource, /beginRun\(runId\)/);
  assert.match(eventSource, /case "agent_start":[\s\S]*?enterMainRun\(\{ kind: "waiting_model" \}\)/);
  assert.match(sendSource, /const promptRunId = enterMainRun\(/);
  assert.match(mountSource, /agentState\.busy[\s\S]*?enterMainRun\(/);
  assert.doesNotMatch(mountSource, /agentState\.busy[\s\S]*?agentRunningRef\.current = true/);
});

test("settles main-agent UI only from the authoritative busy snapshot", () => {
  const applySource = source.slice(
    source.indexOf("const applyAgentSnapshot"),
    source.indexOf("const reconcileAgentState", source.indexOf("const applyAgentSnapshot")),
  );
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(applySource, /if \(snapshot\.busy\)/);
  assert.match(applySource, /extensionDialogRef\.current \|\| askQuestionnaireRef\.current/);
  assert.match(applySource, /await finishPromptWithoutStream\(sid, runId\)/);
  assert.doesNotMatch(applySource, /pendingDetachedSubagentIdsRef/);
  assert.match(source, /pendingDetachedSubagentIdsRef\.current\.size === 0[\s\S]*?!shadowLifecycleRef\.current\.hasActiveRuns/);
  assert.match(eventSource, /case "agent_settled":\s*case "prompt_done":[\s\S]*?reconcileAgentState\(sessionIdRef\.current, promptRunIdRef\.current\)/);
});

test("uses one snapshot reconciliation path for SSE, polling, and mount recovery", () => {
  const reconcileSource = source.slice(
    source.indexOf("const readAgentSnapshot"),
    source.indexOf("const waitForBashSettlement"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );

  assert.match(reconcileSource, /readAgentSnapshot\(sid\)/);
  assert.match(reconcileSource, /reconcileRequestGenerationRef\.current = generation/);
  assert.match(reconcileSource, /generation !== reconcileRequestGenerationRef\.current/);
  assert.equal((source.match(/const reconcileAgentState = useCallback/g) ?? []).length, 1);
  assert.match(mountSource, /agentState\.busy && runtimeState/);
  assert.match(reconcileSource, /applyRuntimeState\(snapshot\.state\)/);
  assert.equal((source.match(/setExtensionStatuses\(state\.extensionStatuses\)/g) ?? []).length, 1);
  assert.match(mountSource, /connectEvents\(session\.id\)/);
});

test("reloads compacted context directly from the authoritative server snapshot", () => {
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

  assert.match(compactLoadSource, /return loadSession\(sid, showLoading\)/);
  assert.doesNotMatch(source, /liveSessionMessages|live-session-cache/);
  assert.match(eventSource, /case "compaction_end":[\s\S]*?loadCompactedSession\(sessionIdRef\.current\)/);
  assert.match(manualCompactSource, /await loadCompactedSession\(sid, true\)/);
  assert.match(slashCompactSource, /await loadCompactedSession\(sid, true\)/);
});

test("context loads atomically through the shared latest loader", () => {
  const loadSource = source.slice(
    source.indexOf("const loadSession"),
    source.indexOf("const loadTools = useCallback"),
  );
  const navigationSource = source.slice(
    source.indexOf("const navigateToLeaf"),
    source.indexOf("const handleModelChange"),
  );

  assert.equal((loadSource.match(/contextLoaderRef\.current\.run\(/g) ?? []).length, 3);
  assert.equal((loadSource.match(/commitContextSnapshot\(sid, loaded\.snapshot, loaded\.leafId/g) ?? []).length, 3);
  assert.match(loadSource, /skipCache: true[\s\S]*?preserveScroll: true/);
  assert.match(navigationSource, /navigationChainRef\.current\.get\(sid\)/);
  assert.match(navigationSource, /navigationChainRef\.current\.delete\(sid\)/);
  assert.match(navigationSource, /navigationGenerationRef\.current\.delete\(sid\)/);
  assert.match(navigationSource, /await sendAgentCommand\(sid, \{ type: "navigate_tree"/);
  assert.match(navigationSource, /await loadContext\(sid, leafId\)/);
  assert.equal((navigationSource.match(/sendAgentCommand\(sid, \{ type: "navigate_tree"/g) ?? []).length, 1);
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

test("待创建 Shadow 预设在首轮前应用并持久化 materialized session", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession = useCallback"),
    source.indexOf("const loadSlashCommands = useCallback"),
  );
  assert.match(ensureSource, /materializeNewSession\(\{/);
  assert.match(ensureSource, /shadowMindEnabled: requestedShadowMindEnabled/);
  assert.match(ensureSource, /applyShadowRuntimeState\(result\)/);
  assert.match(ensureSource, /type: "READY"/);
  assert.match(ensureSource, /type: "INIT_FAIL"[\s\S]*?throw new Error\(result\.error\)/);
  assert.doesNotMatch(ensureSource, /if \(sessionIdRef\.current\) return/);
});

test("surfaces auto-continue events from the RPC wrapper as notices", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  assert.match(eventSource, /case "auto_continue":[\s\S]*?已自动继续/);
  assert.match(eventSource, /case "auto_continue_stopped":[\s\S]*?自动继续已停止/);
});

test("tips remain visible for five seconds before exiting", () => {
  assert.match(source, /const NOTICE_VISIBLE_MS = 5_000;/);
  assert.match(source, /\(notice\.shownAt \?\? now\) \+ NOTICE_VISIBLE_MS/);
  assert.match(source, /type: "mark_expired", now: Date\.now\(\)/);
});

test("buffers multi-question ask answers until final submission", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const questionnaireSource = source.slice(
    source.indexOf("const queueAskQuestionnaireRequest"),
    source.indexOf("const handleExtensionUiRequest"),
  );

  assert.match(eventSource, /name === "ask_user_question"[\s\S]*?parseAskQuestionnaire\(event\.args\)/);
  assert.match(questionnaireSource, /for \(let index = 0; index < answers\.length; index\+\+\)/);
  assert.match(questionnaireSource, /await takeAskQuestionnaireRequest\(\)/);
  assert.match(questionnaireSource, /answer\.optionIndexes\.map\(\(value\) => value \+ 1\)\.join\(","\)/);
  assert.match(questionnaireSource, /const sentinel = request\.options\[request\.options\.length - 1\]/);
  assert.match(questionnaireSource, /clearAskQuestionnaire\(\)/);
});

test("server-side UI cancellation closes both ordinary dialogs and buffered ask questionnaires", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(eventSource, /case "extension_ui_closed"/);
  assert.match(eventSource, /setExtensionDialog\(\(current\) => current\?\.id === id \? null : current\)/);
  assert.match(eventSource, /askQuestionnaireRequestIdsRef\.current\.has\(id\)[\s\S]*?clearAskQuestionnaire\(\)/);
});

test("new-session model side effects run only for the latest committed selection", () => {
  const handler = source.slice(
    source.indexOf("const handleModelChange"),
    source.indexOf("const handleCompact"),
  );
  assert.match(handler, /if \(!selection\.committed \|\| newSessionModelOverrideRef\.current !== selectedModel\) return/);
  assert.match(handler, /recommendedThinkingLevelRef\.current = selection\.preferredThinking/);
});

test("records the effective model and thinking level after the first prompt succeeds", () => {
  const sender = source.slice(source.indexOf("const handleSend"), source.indexOf("const handleModelChange"));
  assert.match(sender, /await sendAgentCommand<AgentRuntimeState>\(sid, \{ type: "get_state" \}\)/);
  assert.match(sender, /recordThinkingLevelPreference\(runtimeState\.model\.id, runtimeState\.thinkingLevel\)/);
});

test("wires persisted Shadow lifecycle entries to the context refresh path", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(eventSource, /case "entry_appended"[\s\S]*?consumeShadowEntry\(entry\)[\s\S]*?shadowLifecycleRef\.current\.consume\(entry\)[\s\S]*?scheduleContextRefresh\(sid\)/);
  assert.doesNotMatch(eventSource, /setTimeout\([\s\S]{0,300}loadSession/);
});

test("delegates Shadow runtime, slash, and toggle behavior to the focused hook", () => {
  const builtins = source.slice(source.indexOf("const handleBuiltinSlashCommand"), source.indexOf("const handleQueuedSubmit"));
  const queued = source.slice(source.indexOf("const handleQueuedSubmit"), source.indexOf("const handleAbortCompaction"));

  assert.match(source, /useShadowSessionSetting\(\{[\s\S]*?sessionIdRef/);
  assert.match(builtins, /runShadowSlashCommand\(text, sid\)/);
  assert.match(queued, /runShadowSlashCommand\(message, sid\)/);
  assert.match(source, /toggle: handleShadowMindToggle/);
  assert.doesNotMatch(source, /setShadowMindEnabled|setShadowMindAvailable|setShadowMindTogglePending/);
});
