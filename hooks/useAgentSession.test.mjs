import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const inputControlsSource = await readFile(new URL("../components/InputControls.tsx", import.meta.url), "utf8");
const sessionNavigationSource = await readFile(new URL("./useSessionNavigation.ts", import.meta.url), "utf8");

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
    source.indexOf("function normalizeQueuedMessages"),
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
    source.indexOf("function normalizeQueuedMessages"),
  );
  const loadSource = source.slice(
    source.indexOf("const commitContextSnapshot = useCallback"),
    source.indexOf("const scheduleSessionListRefresh"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("onSystemPromptChange?."),
  );
  const restoreSource = source.slice(
    source.indexOf("const restoreRuntimeFromLoad = useCallback"),
    source.indexOf("const handleRetryBlockedLoad = useCallback"),
  );

  assert.match(rebuildSource, /pending\.add\(agentId\)/);
  assert.match(rebuildSource, /completedDetachedSubagentIds\(message\)/);
  assert.match(loadSource, /pendingDetachedSubagentIdsRef\.current = pendingDetachedSubagentIds\(snapshot\.messages\)/);
  assert.match(restoreSource, /pendingDetachedSubagentIdsRef\.current\.size > 0/);
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
  const restoreSource = source.slice(
    source.indexOf("const restoreRuntimeFromLoad = useCallback"),
    source.indexOf("const handleRetryBlockedLoad = useCallback"),
  );

  assert.match(enterSource, /beginRun\(runId\)/);
  assert.match(eventSource, /case "agent_start":[\s\S]*?enterMainRun\(\{ kind: "waiting_model" \}\)/);
  assert.match(sendSource, /const promptRunId = enterMainRun\(/);
  assert.match(restoreSource, /agentState\.busy[\s\S]*?enterMainRun\(/);
  assert.doesNotMatch(restoreSource, /agentState\.busy[\s\S]*?agentRunningRef\.current = true/);
});

test("明确拒绝 prompt 时恢复输入并显示错误", () => {
  const sendSource = source.slice(
    source.indexOf("const handleSend = useCallback"),
    source.indexOf("const executeBash = useCallback"),
  );

  assert.match(sendSource, /promptRequestStarted && sentSessionId && !isPromptRejectedError\(e\)/);
  assert.match(sendSource, /setMessages\(\(prev\) => \{/);
  assert.match(sendSource, /消息发送失败，输入已保留/);
  assert.match(sendSource, /return false;/);
});

test("运行中排队消息把图片转换为 Pi 图片协议", () => {
  const queuedSource = source.slice(
    source.indexOf("const handleQueuedSubmit"),
    source.indexOf("const handleAbortCompaction"),
  );

  assert.match(queuedSource, /images\?: AttachedImage\[\]/);
  assert.match(queuedSource, /const piImages = images\?\.map/);
  assert.match(queuedSource, /type: "image" as const/);
  assert.match(queuedSource, /piImages\?\.length \? \{ images: piImages \} : \{\}/);
});

test("会话切换后旧组件不能提交普通消息或排队消息", () => {
  const sendSource = source.slice(
    source.indexOf("const handleSend = useCallback"),
    source.indexOf("const executeBash = useCallback"),
  );
  const queuedSource = source.slice(
    source.indexOf("const handleQueuedSubmit"),
    source.indexOf("const handleAbortCompaction"),
  );

  assert.match(sendSource, /if \(!isNavigationActive\(navigationKey\)\) return false/);
  assert.ok((sendSource.match(/isNavigationActive\(navigationKey\)/g) ?? []).length >= 4);
  assert.match(queuedSource, /if \(!isNavigationActive\(navigationKey\)\) return false/);
  assert.ok((queuedSource.match(/isNavigationActive\(navigationKey\)/g) ?? []).length >= 2);
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
  const restoreSource = source.slice(
    source.indexOf("const restoreRuntimeFromLoad = useCallback"),
    source.indexOf("const handleRetryBlockedLoad = useCallback"),
  );

  assert.match(reconcileSource, /readAgentSnapshot\(sid\)/);
  assert.match(reconcileSource, /reconcileRequestGenerationRef\.current = generation/);
  assert.match(reconcileSource, /generation !== reconcileRequestGenerationRef\.current/);
  assert.equal((source.match(/const reconcileAgentState = useCallback/g) ?? []).length, 1);
  assert.match(restoreSource, /agentState\.busy && runtimeState/);
  assert.match(reconcileSource, /applyRuntimeSnapshot\(read, snapshot\.state, \{ sid, runId, requestId: usageRequestId \}\)/);
  assert.equal(source.split("mergeExtensionUiSnapshot(prev, state.extensionStatuses,").length - 1, 1);
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

  assert.match(compactLoadSource, /invalidateSessionContext\(sid\)/);
  assert.match(compactLoadSource, /deleteSessionViewSnapshot\(sid\)/);
  assert.match(compactLoadSource, /return loadSession\(sid, false, false, \{ validateView: true, focusCompaction, preserveScroll: !focusCompaction \}\)/);
  assert.doesNotMatch(source, /liveSessionMessages|live-session-cache/);
  assert.match(eventSource, /case "compaction_end":[\s\S]*?loadCompactedSession\(sessionIdRef\.current, event\.reason === "manual"\)/);
  assert.match(manualCompactSource, /await loadCompactedSession\(sid, true\)/);
  assert.match(slashCompactSource, /handleCompact\(args \|\| undefined\)/);
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

  // 4 条固定路径（首屏、缓存复验、清空后的重读、最近一次提交）加上首屏空页的有界补页，
  // 全部经由同一个 loader 串行。
  assert.equal((loadSource.match(/contextLoaderRef\.current\.run\(/g) ?? []).length, 5);
  assert.equal((loadSource.match(/commitContextSnapshot\(sid, loaded\.snapshot, loaded\.leafId/g) ?? []).length, 4);
  // 补页的游标与「是否已有消息」必须读同步值：viewSnapshotRef.current.page 要等下一次
  // 渲染才同步，在那里判 page.sid === sid 会让补页一次都不发生。
  const backfillSource = loadSource.slice(
    loadSource.indexOf("await backfillFirstPage("),
    loadSource.indexOf("if (showLoading) {", loadSource.indexOf("await backfillFirstPage(")),
  );
  // 补页只看服务端响应：首屏那一页是刚提交的那一份，客户端状态（ref / state / 上一帧
  // 的分页快照）一律不参与判断——它们在同一个异步续体里可能还是上一个会话的值，
  // 读它们会让补页一次都不发生，或者误以为「已经有消息了」。
  assert.match(loadSource, /let committedSnapshot: SessionContextSnapshot \| null = null;/);
  assert.match(backfillSource, /first: firstSnapshot/);
  assert.match(loadSource, /const firstSnapshot = committedSnapshot \?\? contextResult\.value\.snapshot;/);
  assert.doesNotMatch(backfillSource, /loadedCount|loadedEntryIds|viewSnapshotRef\.current\.page|messagesRef\.current\.length/);
  // 元数据沿用首屏那页，滚动行为沿用本次加载的 options：补页不该把模型/思考强度改回旧值，
  // 也不该因为 preserveScroll 让首屏停在顶部。
  // 补页中途文件被重写（版本或分支末端变了）时不能合并：两页接不上，会得到一张既没有
  // 消息、又标着「没有更早消息」的空白页。丢弃后重读一次首屏，且只重试一次。
  assert.match(backfillSource, /if \(!sameSessionView\(/);
  assert.match(backfillSource, /viewChanged = true;/);
  assert.match(loadSource, /invalidateSessionContext\(sid\);\s*\n\s*return loadSession\(sid, showLoading, includeState, \{ \.\.\.options, reloadedAfterRewrite: true \}\);/);
  // 重写重试的首屏要绕过本地缓存让服务端复验版本，否则拿到旧首屏+旧游标，补页会再次撞上视图变化。
  assert.match(loadSource, /skipCache: options\.validateView \|\| options\.reloadedAfterRewrite === true/);
  // 在已合并的那一份上累加（连补多页时不丢中间页），而不是每次从首屏重拼。
  assert.match(loadSource, /let latestSnapshot = firstSnapshot;/);
  assert.match(backfillSource, /const merged = mergeOlderPage\(latestSnapshot, page\.snapshot\);/);
  assert.match(backfillSource, /latestSnapshot = merged;/);
  assert.match(backfillSource, /firstLeafId,[\s\S]*?options,/);
  assert.doesNotMatch(backfillSource, /preserveScroll: true/);
  assert.match(loadSource, /contextResult\.value\.cached[\s\S]*?skipCache: true/);
  assert.match(loadSource, /skipCache: true[\s\S]*?preserveScroll: true/);
  assert.match(navigationSource, /navigationChainRef\.current\.get\(sid\)/);
  assert.match(navigationSource, /navigationChainRef\.current\.delete\(sid\)/);
  assert.match(navigationSource, /navigationGenerationRef\.current\.delete\(sid\)/);
  assert.match(navigationSource, /await sendAgentCommand(?:<[^\n]+>)?\(sid, \{ type: "navigate_tree"/);
  assert.match(navigationSource, /await loadContext\(sid, leafId\)/);
  assert.equal((navigationSource.match(/sendAgentCommand(?:<[^\n]+>)?\(sid, \{ type: "navigate_tree"/g) ?? []).length, 1);
});

test("历史分页按游标串行前插并拒绝重复 entryId", () => {
  const paginationSource = source.slice(
    source.indexOf("const loadEarlierMessages = useCallback"),
    source.indexOf("const loadSession = useCallback"),
  );

  assert.match(paginationSource, /const before = page\.oldestEntryId/);
  // 单页请求带期限：服务端卡住时顶部不能一直停在「加载中」。
  assert.match(paginationSource, /withPageDeadline\(controller\.signal, EARLIER_PAGE_TIMEOUT_MS/);
  assert.match(paginationSource, /\{ before, tail: SESSION_CONTEXT_PAGE_SIZE, skipCache: true \}/);
  // Safari 16.2 没有 AbortSignal.any()/timeout()：用 AbortController + 计时器。
  assert.doesNotMatch(paginationSource, /AbortSignal\.(any|timeout)/);
  // 超时/出错后标记失败，顶部哨兵不再自动重发同一个游标。
  assert.match(paginationSource, /loading: false, failed: pageFailed/);
  assert.match(paginationSource, /const retryEarlierMessages = useCallback/);
  // 404（会话文件已被删除）先校验归属，再关掉分页并说清楚，不留重试入口。
  assert.match(paginationSource, /if \(result\.kind === "missing"\) \{/);
  assert.match(paginationSource, /setHistoryPage\(\(current\) => terminatePagination\(current, sid\)\)/);
  assert.match(paginationSource, /translateRef\.current\("chat\.sessionFileMissing"\)/);
  assert.ok(
    paginationSource.indexOf('result.kind === "missing"') < paginationSource.indexOf('result.kind !== "loaded"'),
    "missing 要在通用失败分支之前处理",
  );
  assert.match(paginationSource, /page\.loading/);
  assert.match(paginationSource, /result\.snapshot\.entryIds\.some\(\(id\) => existingIds\.has\(id\)\)/);
  assert.match(paginationSource, /setMessages\(\(current\) => \{[\s\S]*?\.\.\.result\.snapshot\.messages, \.\.\.current/);
  assert.match(paginationSource, /setEntryIds\(\(current\) => \{[\s\S]*?\.\.\.result\.snapshot\.entryIds, \.\.\.current/);
});

test("refuses a normal send while the hook knows an asynchronous run is active", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(sendSource, /if \(\(agentRunningRef\.current && !isBashCommand\) \|\| bashRunningRef\.current\) return false;/);
  assert.match(sendSource, /return Boolean\(sentSessionId\);/);
});

test("Stop 被扩展命令挡住时仍把已撤回的排队消息放回输入框", () => {
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );

  // 只有当命令真的跑着时才提示；提示之后必须继续走撤回消息的恢复路径，
  // 否则 Stop 之后那条消息还会在命令结束时发出去。
  assert.match(abortSource, /const blocked = recall\?\.blockedByCommands;/);
  assert.match(
    abortSource,
    /blocked\?\.length[\s\S]*?stopBlockedByCommand[\s\S]*?restoreRecalledPrompts\(sid, recall as QueuedMessages \| null\)[\s\S]*?return;/,
  );
});

test("旧 SSE 连接和旧会话事件不能写入当前会话", () => {
  const connectionSource = source.slice(
    source.indexOf("const connectEvents = useCallback"),
    source.indexOf("const ensureEventsConnected = useCallback"),
  );

  assert.match(connectionSource, /eventSourceRef\.current !== es \|\| sessionIdRef\.current !== sid/);
  assert.ok(
    connectionSource.indexOf("eventSourceRef.current !== es") < connectionSource.indexOf("JSON.parse(e.data)"),
    "必须在解析和分发事件前拒绝旧连接",
  );
});

test("发送期间会话变化时拒绝提交并保留原输入", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(sendSource, /const requestSessionId = sessionIdRef\.current \?\? session\?\.id \?\? null/);
  assert.match(sendSource, /if \(!sid \|\| sid !== session\.id\) throw new Error\("会话已切换，消息未发送"\)/);
  assert.match(sendSource, /await ensureEventsConnected\(sid\);[\s\S]*?sessionIdRef\.current !== sid/);
  assert.match(sendSource, /await sendAgentCommand\(sid, \{[\s\S]*?type: "prompt"/);
});

test("发送消息时异步刷新当前工作目录的 Git 分支", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(sendSource, /void fetch\(`\/api\/git\/context\?cwd=\$\{encodeURIComponent\(activeCwd\)\}`/);
  assert.match(sendSource, /if \(response\.ok\) return/);
  assert.doesNotMatch(sendSource, /onSessionListRefresh/);
  assert.match(sendSource, /刷新当前 Git 分支失败/);
  assert.doesNotMatch(sendSource, /await fetch\(`\/api\/git\/context/);
});

test("运行中只在新会话首次落盘与权威 idle 边界刷新完整会话列表", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );
  const messageEndSource = eventSource.slice(
    eventSource.indexOf('case "message_end"'),
    eventSource.indexOf('case "tool_execution_start"'),
  );
  const agentEndSource = eventSource.slice(
    eventSource.indexOf('case "agent_end"'),
    eventSource.indexOf('case "agent_settled"'),
  );
  const settledSource = source.slice(
    source.indexOf("const finishPromptWithoutStream = useCallback"),
    source.indexOf("const readAgentSnapshot = useCallback"),
  );

  assert.match(messageEndSource, /reason: "new-session-persisted"/);
  assert.doesNotMatch(messageEndSource, /setTimeout|SESSION_LIST_REFRESH_THROTTLE_MS/);
  assert.doesNotMatch(agentEndSource, /onSessionListRefresh/);
  assert.match(agentEndSource, /loadSession\(sessionIdRef\.current, false, false, \{ preserveScroll: true \}\)/);
  assert.ok(settledSource.indexOf("settleRun(runId, sid)") < settledSource.indexOf('reason: "run-settled"'));
  assert.ok(settledSource.indexOf("invalidateSessionContext(sid)") < settledSource.indexOf("loadSession(sid, false, false"));
  assert.match(settledSource, /loadSession\(sid, false, false, \{ preserveScroll: true \}\)\.then\([\s\S]*?requestScrollPosition\("running-end"\)/);
  assert.match(eventSource, /reason: "title-generated"/);
});

test("临时会话升级前同步清空已提交输入，避免旧草稿在 key 切换时回写", () => {
  const promoteSource = source.slice(
    source.indexOf("const promoteNewSession = useCallback"),
    source.indexOf("const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /opts\.chatInputRef\?\.current\?\.clearAcceptedPrompt\(\)/);
  assert.ok(
    promoteSource.indexOf("clearAcceptedPrompt()") < promoteSource.indexOf("onSessionCreated?.(createdSession,"),
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

test("Slash 命令加载拒绝过期响应，并在失败后允许输入框重试", () => {
  const loadSource = source.slice(source.indexOf("const requestSlashCommands = useCallback"), source.indexOf("const slashCommandsForMcp = useCallback"));
  assert.match(loadSource, /const generation = \+\+slashCommandsGenerationRef\.current/);
  assert.match(loadSource, /current\(\) && sessionIdRef\.current === sid/);
  assert.match(loadSource, /slashCommandsLoadRef\.current === load/);
  assert.match(loadSource, /commands === null\) throw new Error/);
  assert.match(loadSource, /setSlashCommandsLoading\(false\)/);
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
  assert.match(eventSource, /!submittedAskToolCallIdsRef\.current\.has\(id\)/);
  assert.match(questionnaireSource, /submittedAskToolCallIdsRef\.current\.add\(questionnaire\.toolCallId\)/);
  assert.match(questionnaireSource, /for \(let index = 0; index < answers\.length; index\+\+\)/);
  assert.match(questionnaireSource, /await takeAskQuestionnaireRequest\(\)/);
  assert.match(questionnaireSource, /answer\.optionIndexes\.map\(\(value\) => value \+ 1\)\.join\(","\)/);
  assert.match(questionnaireSource, /const sentinel = request\.options\[request\.options\.length - 1\]/);
  assert.match(questionnaireSource, /clearAskQuestionnaire\(\)/);
});

test("completed ask requests do not close a questionnaire while it is submitting", () => {
  const eventSource = source.slice(
    source.lastIndexOf("const handleAgentEvent = useCallback"),
    source.indexOf("handleAgentEventRef.current = handleAgentEvent"),
  );

  assert.match(eventSource, /case "extension_ui_closed"/);
  assert.match(eventSource, /setExtensionDialog\(\(current\) => current\?\.id === id \? null : current\)/);
  assert.match(eventSource, /askQuestionnaireRequestIdsRef\.current\.delete\(id\)/);
  assert.match(eventSource, /wasAskRequest && !askQuestionnaireRef\.current\?\.submitting[\s\S]*?clearAskQuestionnaire\(\)/);
});

test("new-session model side effects run only for the latest committed selection", () => {
  const handler = source.slice(
    source.indexOf("const handleModelChange"),
    source.indexOf("const handleCompact"),
  );
  // 被另一次切换取代时才整体放弃；推荐本身没落地（期间用户手动选了档）仍要提交模型。
  assert.match(handler, /if \(newSessionModelOverrideRef\.current !== selectedModel\) return null;/);
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

test("冷会话连接就绪后补读工具预设，不必等待刷新", () => {
  const connected = source.slice(source.indexOf('case "connected":'), source.indexOf('case "agent_start":'));
  assert.match(connected, /if \(!toolSelectionKnown && sessionIdRef\.current\) void loadTools\(sessionIdRef\.current\);/);
});

test("refreshes Shadow runtime state after a cold SSE connection becomes ready", () => {
  const connector = source.slice(
    source.indexOf("const connectEvents = useCallback"),
    source.indexOf("const ensureEventsConnected"),
  );

  assert.match(
    connector,
    /event\.type === "connected"[\s\S]*?const connectRead = beginRuntimeRead\(\);[\s\S]*?fetchRuntimeState\(sid, controller\.signal\)[\s\S]*?applyRuntimeSnapshot\(connectRead, snapshot\.state\)/,
  );
  assert.match(connector, /eventSourceRef\.current === es && sessionIdRef\.current === sid/);
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

test("历史页缓存仅在会话版本和 leaf 均与 context 响应一致时恢复", () => {
  assert.match(source, /saved\.revision === loaded\.snapshot\.version && saved\.leafId === loaded\.leafId/);
  assert.match(source, /if \(saved\) deleteSessionViewSnapshot\(sid\)/);
  // 只有确认视图一致的路径才允许读本地缓存（重写重试另加 reloadedAfterRewrite 条件）。
  assert.match(source, /skipCache: options\.validateView \|\| options\.reloadedAfterRewrite === true/);
  assert.match(source, /setSessionViewSnapshot\(\{ sessionId: sid, revision: contextVersionRef\.current/);
});

test("每一次运行态快照都按读取坐标投影，迟到的快照不覆盖实时队列", () => {
  // 统一的边界：坐标在发请求之前取，回来时用它判断哪些字段已被更新的实时事件取代。
  assert.match(source, /const beginRuntimeRead = useCallback\(\(\): RuntimeRead => \(\{/);
  // 每个字段各记一份已采纳序号：只更新档位的补读不能把队列/压缩也判成过期。
  assert.match(source, /const lastAppliedQueueSeqRef = useRef\(0\);/);
  assert.match(source, /const lastAppliedThinkingSeqRef = useRef\(0\);/);
  assert.match(source, /const queueAdopted = read\.seq > lastAppliedQueueSeqRef\.current\s*&& queueStateGenerationRef\.current === read\.queueGeneration;/);
  assert.match(source, /const thinkingAdopted = read\.seq > lastAppliedThinkingSeqRef\.current\s*&& read\.thinkingRevision === thinkingChoiceRevisionRef\.current;/);
  assert.match(source, /queue: queueAdopted,/);
  assert.match(source, /if \(queueAdopted\) lastAppliedQueueSeqRef\.current = read\.seq;/);
  assert.match(source, /compaction: compactionEpochRef\.current === read\.compactionEpoch && newest,/);
  assert.match(source, /thinking: thinkingAdopted,/);
  // 预读改用统一坐标（不再就地算判据），建连补读就地判据也要带上档位版本。
  assert.match(source, /applyRuntimeSnapshot\(runtimeRead, snapshot\.state\)/);
  assert.match(source, /const runtimeRead = beginRuntimeRead\(\);/);
  // 建连补读也走同一个入口：它说空闲同样算「最新结论」，加载结束时不会按旧预读再开回合。
  assert.match(source, /const connectRead = beginRuntimeRead\(\);/);
  assert.match(source, /applyRuntimeSnapshot\(connectRead, snapshot\.state\)/);
  assert.match(source, /const connectRead = beginRuntimeRead\(\);\s*void fetchRuntimeState\(sid, controller\.signal\)/);
  // 轮询对账（运行中每几秒一次）此前无条件写队列：一次取样于入队之前的 /state 回来就会把
  // 刚显示的队列行清掉，而服务端还留着它——用户看到的就是「消息没了」。
  assert.match(source, /const read = beginRuntimeRead\(\);\s*const snapshot = await readAgentSnapshot\(sid\);/);
  assert.match(source, /await applyAgentSnapshot\(sid, runId, snapshot, usageRequestId, read\)/);
  assert.match(source, /applyRuntimeSnapshot\(read, snapshot\.state, \{ sid, runId, requestId: usageRequestId \}\)/);
  // 其余读取入口同样带坐标。
  for (const pattern of [
    /const read = beginRuntimeRead\(\);\s*const snapshot = await readAgentSnapshot\(sid\);/,
    /const read = beginRuntimeRead\(\);\s*const snapshot = await fetchRuntimeState\(activeSessionId/,
    /const stagedRead = beginRuntimeRead\(\);/,
    /const attachRead = beginRuntimeRead\(\);/,
  ]) assert.match(source, pattern);
  // 绑定轮询在每次读取发起前记录坐标（轮询串行，一个 ref 就够）。
  assert.match(source, /beforeRead: \(\) => \{ bindingPollReadRef\.current = beginRuntimeRead\(\); \}/);
  // 只有「建连补读」就地算判据：它没有加载自己的队列表，但要带加载期间的队列代次。
  const raw = [...source.matchAll(/applyRuntimeState\(snapshot\.state, undefined, \{/g)];
  assert.equal(raw.length, 0, "运行态快照都必须走 applyRuntimeSnapshot");
});

test("迟到的 /state 不覆盖后来入队的队列行", async () => {
  const ts = (await import("typescript")).default;
  const { Script } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compile = (name) => new Script(ts.transpileModule(`(${findCallback(name).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const queueWrites = [];
  const levels = [];
  const sandbox = {
    sessionIdRef: { current: "s1" },
    setIsCompacting() {},
    setQueuedMessages: (value) => queueWrites.push(value),
    updateQueuedMessages: (value) => queueWrites.push(value),
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    runtimeReadSeqRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 },
    lastAppliedThinkingSeqRef: { current: 0 },
    thinkingChoiceRevisionRef: { current: 0 },
  };
  const { createContext } = await import("node:vm");
  const context = createContext(sandbox);
  context.applyRuntimeState = compile("applyRuntimeState").runInContext(context);
  context.applyRuntimeSnapshot = compile("applyRuntimeSnapshot").runInContext(context);
  context.beginRuntimeRead = compile("beginRuntimeRead").runInContext(context);

  // 轮询对账发起（队列还是空的），随后用户的消息在压缩期间入队。
  const read = context.beginRuntimeRead();
  sandbox.queueStateGenerationRef.current += 1;
  const parked = { steering: [], followUp: [{ text: "后续消息", images: [] }] };
  context.updateQueuedMessages(parked);
  // 那份旧的 /state 现在才回来：它看到的队列是空的，但不能把刚显示的队列行清掉。
  context.applyRuntimeSnapshot(read, { queuedMessages: { steering: [], followUp: [] }, thinkingLevel: "high" });
  assert.deepEqual(queueWrites, [parked], "迟到的快照不写队列");
  assert.deepEqual(levels, ["high"], "其它字段照常应用");

  // 没有实时事件时，快照仍然照旧生效（否则轮询就无法纠正错过的队列变化）。
  const fresh = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(fresh, { queuedMessages: { steering: [], followUp: [] }, thinkingLevel: "low" });
  assert.deepEqual(queueWrites.at(-1), { steering: [], followUp: [] }, "没有更新的实时状态时快照照常生效");

  // 断线期间错过的 `queue_update` 不会推进队列代次：只比代次的话，另一标签页提交的消息会被
  // 「取到空队列、回来得更晚」的对账响应清掉。读取序号必须一起校验。
  const reconcile = context.beginRuntimeRead();   // 先发出的对账请求
  const reconnect = context.beginRuntimeRead();   // 之后建连的补读
  assert.equal(reconnect.queueGeneration, reconcile.queueGeneration, "两份快照的队列代次相同");
  context.applyRuntimeSnapshot(reconnect, { queuedMessages: { steering: [{ text: "另一标签页的消息", images: [] }], followUp: [] } });
  const afterReconnect = queueWrites.at(-1);
  context.applyRuntimeSnapshot(reconcile, { queuedMessages: { steering: [], followUp: [] } });
  assert.equal(queueWrites.at(-1), afterReconnect, "旧的对账响应不能清掉重连补读显示的队列");
});

test("队列写入同时刷新错误页的「移回」入口", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compiled = new Script(ts.transpileModule(`(${findCallback("updateQueuedMessages").getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const shown = [];
  const blocked = [];
  const sandbox = {
    queuedMessagesRef: { current: { steering: [], followUp: [] } },
    setQueuedMessages: (value) => shown.push(value),
    setBlockedRecall: (value) => blocked.push(value),
  };
  const context = createContext(sandbox);
  const update = compiled.runInContext(context);

  // 普通写入（成功加载、实时 queue_update、被采纳的迟到快照都走这里）。
  const rows = { steering: [], followUp: [{ text: "待取回", images: [] }] };
  update(rows);
  assert.deepEqual(shown, [rows]);
  assert.deepEqual(sandbox.queuedMessagesRef.current, rows);
  assert.deepEqual(blocked, [rows], "错误页入口同步拿到这批消息");

  // 空队列清掉入口：另一个标签页已经取回了。
  update({ steering: [], followUp: [] });
  assert.deepEqual(blocked, [rows, null]);
});

test("最新一次改档失败时，按服务端实际档位回填（并受版本保护）", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compile = (name) => new Script(ts.transpileModule(`(${findCallback(name).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  const levels = [];
  const changes = [];
  const states = [];
  const queueWrites = [];
  const compactingWrites = [];
  const sandbox = {
    sessionIdRef: { current: "s1" },
    creationSettingsLocked: false,
    isNew: false,
    newSessionCwd: null,
    recommendedThinkingLevelRef: { current: null },
    thinkingLevelOverrideRef: { current: null },
    thinkingChoiceRevisionRef: { current: 0 },
    thinkingChangeRequestsRef: { current: new Set() },
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    onPendingNewSessionEvent() {},
    sendAgentCommand: (sid, command) => {
      const change = Promise.withResolvers();
      changes.push({ level: command.level, resolve: change.resolve, reject: change.reject });
      return change.promise;
    },
    // 补读走只读的 /state（不会把已关闭的会话从磁盘重新拉起），并且只在页面仍挂载时发。
    mountedRef: { current: true },
    AbortController,
    isThinkingLevel: (value) => typeof value === "string",
    fetchRuntimeState: (sid) => {
      const read = Promise.withResolvers();
      states.push({ resolve: read.resolve, reject: read.reject });
      return read.promise;
    },
    // applyRuntimeState 的依赖（真快照投影，版本校验就在里面）。
    setIsCompacting: (value) => compactingWrites.push(value), setQueuedMessages() {},
    updateQueuedMessages: (value) => queueWrites.push(value),
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    projectExtensionBinding: () => "bound",
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    runtimeReadSeqRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 },
    lastAppliedThinkingSeqRef: { current: 0 },
  };
  const context = createContext(sandbox);
  context.applyRuntimeState = compile("applyRuntimeState").runInContext(context);
  context.applyRuntimeSnapshot = compile("applyRuntimeSnapshot").runInContext(context);
  context.beginRuntimeRead = compile("beginRuntimeRead").runInContext(context);
  const change = compile("handleThinkingLevelChange").runInContext(context);

  // 选 A=high，再选 B=low；B 写入失败，A 的确认在这之后才到（它其实已经写进服务端）。
  const first = change("high");
  const second = change("low");
  changes[1].reject(new Error("写入失败"));
  await second;
  changes[0].resolve(null);
  await first;
  assert.deepEqual(levels, ["high", "low"], "失败时界面还停在一个没生效的档位");

  // 在途请求结算后补读服务端档位：它读到 high，选择器回到服务端实际用的那一档。
  for (let i = 0; i < 100 && states.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.length, 1, "最新一次失败后补读服务端档位");
  states[0].resolve({ state: { thinkingLevel: "high" } });
  for (let i = 0; i < 100 && levels.at(-1) !== "high"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(levels, ["high", "low", "high"], "选择器回到服务端实际档位");

  // 补读在途时用户又改档：这次补读不能覆盖新的选择。
  const third = change("medium");
  changes[2].reject(new Error("写入失败"));
  await third;
  for (let i = 0; i < 100 && states.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.length, 2, "第二次失败同样补读服务端档位");
  const fourth = change("low");
  changes[3].resolve(null);
  await fourth;
  const afterFourth = [...levels];
  // 那次补读的响应现在才回来：版本已经被第四次选择推进，不能覆盖它。
  states[1].resolve({ state: { thinkingLevel: "high" } });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(levels, afterFourth, "补读在版本变化后不再写入");

  // 乱序：失败补读先发出、采到 high；另一标签页随后把档位改成 low，本页的重连补读先回来显示了
  // low。失败补读最后返回时不能把它写回 high——所以补读也要和常规快照共用读取序号。
  const fifth = change("medium");
  changes[changes.length - 1].reject(new Error("写入失败"));
  await fifth;
  for (let i = 0; i < 100 && states.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.length, 3, "第三次失败同样补读服务端档位");
  assert.match(source, /if \(read\.seq <= lastAppliedThinkingSeqRef\.current\) return;/);
  // 重连补读（后发出、先回来）显示 low。
  context.applyRuntimeSnapshot(context.beginRuntimeRead(), { thinkingLevel: "low" });
  const beforeStale = [...levels];
  assert.equal(levels.at(-1), "low");
  // 旧补读现在才回来：它采到的是 high，但不能覆盖已经显示的 low。
  states[2].resolve({ state: { thinkingLevel: "high" } });
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(levels, beforeStale, "迟到的失败补读不覆盖更新的档位");

  // 反向的乱序：重连先发起读取，随后改档失败、补读先返回。补读只更新档位，就不能把整份
  // 快照的序号也推进——否则重连快照回来时，队列与压缩状态会被误判成过期。
  const connectRead = context.beginRuntimeRead();
  const sixth = change("high");
  changes[changes.length - 1].reject(new Error("写入失败"));
  await sixth;
  for (let i = 0; i < 100 && states.length < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.length, 4, "第四次失败同样补读");
  states[3].resolve({ state: { thinkingLevel: "medium" } });
  for (let i = 0; i < 100 && levels.at(-1) !== "medium"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(levels.at(-1), "medium", "补读先返回并回填档位");

  const queuedRows = { steering: [], followUp: [{ text: "断线期间入队的消息", images: [] }] };
  context.applyRuntimeSnapshot(connectRead, { queuedMessages: queuedRows, isCompacting: true, thinkingLevel: "high" });
  assert.deepEqual(queueWrites.at(-1), queuedRows, "重连快照仍能更新队列");
  assert.equal(compactingWrites.at(-1), true, "重连快照仍能更新压缩状态");
  assert.equal(levels.at(-1), "medium", "重连快照里更早的取样不覆盖档位");

  // 补读先发先回、重连后发后回：另一标签页把档位改成 low，本页的重连读到了它。补读回读的
  // 是旧值，但它只是服务端值的回读，不该推进用户选择的版本——否则这份更新的重连快照会被拒。
  const seventh = change("high");
  changes[changes.length - 1].reject(new Error("写入失败"));
  await seventh;
  for (let i = 0; i < 100 && states.length < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(states.length, 5, "第五次失败同样补读");
  // 重连在补读发出之后、返回之前取坐标：它的读取序号更大，档位版本是那一刻的值。
  const reconnectRead = context.beginRuntimeRead();
  states[4].resolve({ state: { thinkingLevel: "medium" } });
  for (let i = 0; i < 100 && levels.at(-1) !== "medium"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(levels.at(-1), "medium", "补读先回来并回填");
  // 重连快照后返回，读到别的标签页改成的新档位 low：它必须能更新选择器。
  context.applyRuntimeSnapshot(reconnectRead, { thinkingLevel: "low" });
  assert.equal(levels.at(-1), "low", "补读不挡住更新的重连快照");
});

test("连续改档时，迟到的确认不会把选择器退回旧档", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compile = (name) => new Script(ts.transpileModule(`(${findCallback(name).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const levels = [];
  const requests = [];
  const sandbox = {
    sessionIdRef: { current: "s1" },
    creationSettingsLocked: false,
    isNew: false,
    newSessionCwd: null,
    recommendedThinkingLevelRef: { current: null },
    thinkingLevelOverrideRef: { current: null },
    thinkingChoiceRevisionRef: { current: 0 },
    thinkingChangeRequestsRef: { current: new Set() },
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    onPendingNewSessionEvent() {},
    sendAgentCommand: (sid, command) => {
      if (command.type === "get_state") return Promise.resolve({ thinkingLevel: "high" });
      return new Promise((resolve, reject) => requests.push({ level: command.level, resolve, reject }));
    },
    // 失败后按服务端实际档位回填走的是统一的运行态快照入口。
    beginRuntimeRead: () => ({ seq: 1, queueGeneration: 0, compactionEpoch: 0, thinkingRevision: 999 }),
    applyRuntimeSnapshot: (read, state) => {
      if (state?.thinkingLevel) levels.push(state.thinkingLevel);
    },
  };
  const context = createContext(sandbox);
  const change = compile("handleThinkingLevelChange").runInContext(context);

  const first = change("high");
  const second = change("low");
  assert.deepEqual(levels, ["high", "low"], "两次选择都先乐观显示");
  // B 先确认：它仍是最新的一次选择，落地并推进版本。
  requests[1].resolve(null);
  await second;
  const revisionAfterB = sandbox.thinkingChoiceRevisionRef.current;
  assert.deepEqual(levels, ["high", "low", "low"]);
  // A 迟到：既不改界面，也不推进版本（否则 B 之后发出的读取会全部失效）。
  requests[0].resolve(null);
  await first;
  assert.deepEqual(levels, ["high", "low", "low"], "迟到的确认不改界面");
  assert.equal(sandbox.thinkingChoiceRevisionRef.current, revisionAfterB, "迟到的确认不推进版本");
});

test("用户改档之后，切换之前取的那份快照不再写回旧档位", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compile = (name) => new Script(ts.transpileModule(`(${findCallback(name).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const levels = [];
  const sandbox = {
    sessionIdRef: { current: "s1" },
    setIsCompacting() {}, setQueuedMessages() {}, updateQueuedMessages() {},
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    updateQueuedMessages() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    runtimeReadSeqRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 },
    lastAppliedThinkingSeqRef: { current: 0 },
    thinkingChoiceRevisionRef: { current: 0 },
  };
  const context = createContext(sandbox);
  context.applyRuntimeState = compile("applyRuntimeState").runInContext(context);
  context.applyRuntimeSnapshot = compile("applyRuntimeSnapshot").runInContext(context);
  context.beginRuntimeRead = compile("beginRuntimeRead").runInContext(context);

  // 输入栏已经可操作：建连补读取到 high，响应还没回来，用户先把档位切到 low 并收到确认。
  const read = context.beginRuntimeRead();
  sandbox.thinkingChoiceRevisionRef.current += 1;
  context.modelSelectionActions.setThinkingLevel("low");
  // 旧响应现在才回来：它是「最新的一份快照」，但档位在选择之前取样，已被用户的操作作废。
  context.applyRuntimeSnapshot(read, { thinkingLevel: "high" });
  assert.deepEqual(levels, ["low"], "选择器停在用户确认的值");

  // 请求期间发出的读取：它带着发送时的版本，但可能采到改档之前的值——确认时再推进一次版本。
  const duringRequest = context.beginRuntimeRead();
  sandbox.thinkingChoiceRevisionRef.current += 1;
  context.modelSelectionActions.setThinkingLevel("low");
  context.applyRuntimeSnapshot(duringRequest, { thinkingLevel: "high" });
  assert.deepEqual(levels, ["low", "low"], "确认前发出的读取也被作废");

  // 生产代码里两次推进：发送前一次（让在途快照失效），确认时再一次（让请求期间发出的读取失效）。
  const thinkingHandler = source.slice(
    source.indexOf("const handleThinkingLevelChange = useCallback"),
    source.indexOf("const handleFastEnabledChange = useCallback"),
  );
  // 只推进两次：用户发起改档、服务端确认。失败后的回填是服务端值的回读，不推进版本——
  // 推进的话，之后发出的读取（例如别的标签页改档后的重连补读）会被一并作废。
  assert.equal((thinkingHandler.match(/thinkingChoiceRevisionRef\.current \+= 1;/g) ?? []).length, 2);

  // 之后发的读取带着新版本，仍然可以纠正（例如别的标签页又改过档）。
  const later = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(later, { thinkingLevel: "medium" });
  assert.deepEqual(levels, ["low", "low", "medium"]);
});

test("建连补读说空闲后，加载完成时不会按旧预读恢复已结束的命令", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compile = (name) => new Script(ts.transpileModule(`(${findCallback(name).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const sandbox = {
    sessionIdRef: { current: "s1" },
    agentRunningRef: { current: false },
    lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 },
    lastAppliedThinkingSeqRef: { current: 0 },
    runtimeReadSeqRef: { current: 0 },
    extensionStatusesRevisionRef: { current: 0 }, extensionWidgetsRevisionRef: { current: 0 },
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    thinkingChoiceRevisionRef: { current: 0 },
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    pendingDetachedSubagentIdsRef: { current: new Set() },
    bashRunningRef: { current: false },
    setIsCompacting() {}, setQueuedMessages() {}, updateQueuedMessages() {},
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel() {} },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    loadTools() {}, setBashRunning() {}, waitForBashSettlement() {}, connectEvents() {}, requestScrollPosition() {},
    entered: [],
    enterMainRun: (phase) => sandbox.entered.push(phase),
  };
  const context = createContext(sandbox);
  context.applyRuntimeState = compile("applyRuntimeState").runInContext(context);
  context.applyRuntimeSnapshot = compile("applyRuntimeSnapshot").runInContext(context);
  context.beginRuntimeRead = compile("beginRuntimeRead").runInContext(context);
  const restore = compile("restoreRuntimeFromLoad").runInContext(context);

  // 预读采到命令在跑；命令随后结束，SSE 建连补读采到空闲并先返回。
  const preRead = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(preRead, { runningCommands: ["/review"], isStreaming: false });
  assert.equal(sandbox.runtimeBusySnapshotRef.current, true);
  const connectRead = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(connectRead, { runningCommands: [], isStreaming: false });
  assert.equal(sandbox.runtimeBusySnapshotRef.current, false, "补读也要记下「空闲」这个最新结论");

  // 连线本身也要断言：补读必须走同一个入口，否则它只推进序号、不记「空闲」结论。
  assert.match(source, /const connectRead = beginRuntimeRead\(\);\s*void fetchRuntimeState\(sid, controller\.signal\)[\s\S]*?applyRuntimeSnapshot\(connectRead, snapshot\.state\)/);
  // 上下文加载完成：旧预读说 busy，但最新的结论是空闲，不能再开一个回合。
  restore("s1", { alive: true, busy: true, state: { runningCommands: ["/review"] } }, preRead);
  assert.equal(sandbox.entered.length, 0, "命令已经结束，不该恢复成运行中");
});

test("重试完成时不会用旧快照清掉已经开始流式输出的回复", async () => {
  const ts = (await import("typescript")).default;
  const { Script, createContext } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findCallback(name) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer.arguments[0];
      return ts.forEachChild(node, visit);
    }
    return visit(ast);
  }
  const compiled = new Script(ts.transpileModule(`(${findCallback("restoreRuntimeFromLoad").getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const sandbox = {
    sessionIdRef: { current: "s1" },
    agentRunningRef: { current: false },
    lastAppliedRuntimeSeqRef: { current: 0 },
    lastAppliedQueueSeqRef: { current: 0 },
    lastAppliedThinkingSeqRef: { current: 0 },
    runtimeBusySnapshotRef: { current: null },
    pendingDetachedSubagentIdsRef: { current: new Set() },
    bashRunningRef: { current: false },
    loadTools() {}, setBashRunning() {}, waitForBashSettlement() {}, connectEvents() {},
    scroll: [],
    requestScrollPosition: (value) => sandbox.scroll.push(value),
    entered: [],
    enterMainRun: (phase) => sandbox.entered.push(phase),
  };
  const context = createContext(sandbox);
  const restore = compiled.runInContext(context);

  // 界面已经接管主回合（后续消息开始流式输出）：旧快照不许再重设阶段。
  sandbox.agentRunningRef.current = true;
  restore("s1", { alive: true, busy: true, state: { isStreaming: true } }, { seq: 4 });
  assert.equal(sandbox.entered.length, 0, "不覆盖正在流式输出的回合");

  // 更新的快照说了空闲（命令已经结束）：同样不再开回合。
  sandbox.agentRunningRef.current = false;
  sandbox.lastAppliedRuntimeSeqRef.current = 6;
  sandbox.runtimeBusySnapshotRef.current = false;
  restore("s1", { alive: true, busy: true, state: {} }, { seq: 4 });
  assert.equal(sandbox.entered.length, 0, "更新的快照说了空闲");

  // 常态：命令还在跑，界面还没有主回合——按快照恢复。
  sandbox.lastAppliedRuntimeSeqRef.current = 4;
  sandbox.runtimeBusySnapshotRef.current = true;
  restore("s1", { alive: true, busy: true, state: {} }, { seq: 4 });
  assert.equal(sandbox.entered.length, 1, "仍在执行的命令要恢复成运行中");
  assert.equal(sandbox.entered[0].kind, "running_command");
});

test("首屏加载与错误页重试共用同一份运行态恢复", () => {
  // 命令在跑时 SSE 建连不会把界面标记为运行中：只有加载返回的快照能说清是否 busy。
  assert.match(source, /const restoreRuntimeFromLoad = useCallback\(\(\s*sid: string,\s*agentState: AgentRuntimeSnapshot \| null \| undefined,\s*read\?: RuntimeRead \| null,\s*\) => \{/);
  assert.match(source, /if \(!takenOver && agentState\.busy && runtimeState && !runtimeState\.isBashRunning\) \{/);
  // 重试必须用它，不能丢弃 agentState。
  const retry = source.slice(
    source.indexOf("const handleRetryBlockedLoad = useCallback"),
    source.indexOf("const handleThinkingLevelChange = useCallback"),
  );
  assert.match(retry, /loadSession\(sid, true, true, \{ validateView: true \}\)\.then\(\(\{ agentState, runtimeRead \}\) => \{/);
  assert.match(retry, /restoreRuntimeFromLoad\(sid, agentState, runtimeRead\)/);
  // 首次加载同样只走这一份，不再就地重写一遍。
  assert.match(source, /loadSession\(session\.id, true, true, \{ validateView: true \}\)\.then\(\(\{ agentState, runtimeRead \}\) => \{\s*restoreRuntimeFromLoad\(session\.id, agentState, runtimeRead\);\s*\}\)/);
});

test("普通加载失败也按本次有效的运行态快照给出「移回」入口", () => {
  const catchSource = source.slice(
    source.indexOf("Failed to load early session runtime state"),
    source.indexOf("const loadContext = useCallback"),
  );
  // 只有外部写入才重新查询队列；普通 500 用这次加载的预读结果，仍然按队列代次校验。
  assert.match(catchSource, /if \(!isSessionExternalWriteError\(error\) && sessionIdRef\.current === sid\) \{/);
  assert.match(catchSource, /const queued = queuedMessagesRef\.current;/);
  // 队列显示只有一个写入口：界面状态和错误页读的镜像一起更新，漏一处错误页就会拿旧队列判断。
  assert.equal((source.match(/(?<!\.)\bsetQueuedMessages\(/g) ?? []).length, 1);
  assert.match(catchSource, /setBlockedRecall\(queued\.steering\.length > 0 \|\| queued\.followUp\.length > 0 \? queued : null\);/);
});

test("乱序的运行态响应：迟到的预读不会把思考强度写回旧档", async () => {
  const ts = (await import("typescript")).default;
  const { Script } = await import("node:vm");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findApply(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "applyRuntimeState") return node.initializer.arguments[0];
    return ts.forEachChild(node, findApply);
  }
  const body = findApply(ast);
  assert.ok(body, "missing applyRuntimeState");
  const script = new Script(ts.transpileModule(`(${body.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const levels = [];
  const compacting = [];
  let runtimeThinkingLevelSessionRef = { current: null };
  const runtimeReadSeqRef = { current: 0 };
  const lastAppliedRuntimeSeqRef = { current: 0 };
  const apply = script.runInNewContext({
    sessionIdRef: { current: "s1" },
    options_placeholder: undefined,
    extensionStatusKeyRevisionsRef: { current: new Map() }, extensionWidgetKeyRevisionsRef: { current: new Map() },
    setIsCompacting: (value) => compacting.push(value),
    setQueuedMessages() {}, updateQueuedMessages() {},
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {},
    setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    runtimeThinkingLevelSessionRef,
  });
  // 与调用点同一份判据：读取序号更新才允许写「此刻的运行状态」。
  const submit = (state, seq) => {
    const isNewest = seq > lastAppliedRuntimeSeqRef.current;
    apply(state, undefined, { queue: true, compaction: isNewest, thinking: isNewest });
    lastAppliedRuntimeSeqRef.current = Math.max(lastAppliedRuntimeSeqRef.current, seq);
  };
  // 预读取到 high 后响应延迟；建连补读取到 low 并先应用。
  const seqPreRead = ++runtimeReadSeqRef.current;
  const seqConnect = ++runtimeReadSeqRef.current;
  const high = { thinkingLevel: "high", isCompacting: false };
  const low = { thinkingLevel: "low", isCompacting: true };
  submit(low, seqConnect);
  submit(high, seqPreRead);
  // 最终显示 low：迟到的预读既不写档位，也不写压缩状态。
  assert.deepEqual(levels, ["low"]);
  assert.deepEqual(compacting, [true]);
  assert.equal(runtimeThinkingLevelSessionRef.current, "s1");
});

test("移回请求期间切换会话，图片恢复到原会话草稿而非新输入框", async () => {
  const ts = (await import("typescript")).default;
  const { Script } = await import("node:vm");
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { queuedMessagesToDraft, prependChatDraft } = await jiti.import("../lib/queued-messages.ts");
  const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
  function findRecall(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleRecallQueue") return node.initializer.arguments[0];
    return ts.forEachChild(node, findRecall);
  }
  const script = new Script(ts.transpileModule(`(${findRecall(ast).getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  let active = true;
  let resolve;
  const response = new Promise((r) => { resolve = r; });
  const sessionIdRef = { current: "original" };
  let restored;
  let inputCalls = 0;
  let cleared = false;
  const callback = script.runInNewContext({
    sessionIdRef, navigationKey: "original", isNavigationActive: () => active,
    opts: { chatInputRef: { current: { prependDraft() { inputCalls += 1; } } } },
    sendAgentCommand: () => response,
    queuedMessagesToDraft, prependChatDraft,
    getDraft: () => ({ value: "原草稿", images: [] }),
    setDraft: (id, draft) => { restored = { id, draft }; },
    setQueuedMessages: () => { cleared = true; },
    addNotice() { assert.fail("不应报错"); }, console,
  });
  const pending = callback();
  active = false;
  sessionIdRef.current = "next-session";
  resolve({ steering: [], followUp: [{ text: "排队", images: [{ data: "dGVzdA==", mimeType: "image/png" }] }] });
  await pending;
  assert.equal(inputCalls, 0);
  assert.equal(cleared, false);
  assert.equal(restored.id, "original");
  assert.equal(restored.draft.value, "排队\n\n原草稿");
  assert.equal(restored.draft.images[0].data, "dGVzdA==");
});

test("keeps the compaction control reachable while a turn is auto-compacting", () => {
  // Auto-compaction starts mid-turn, so `isStreaming` (sessionBusy) is already true. Hiding
  // the control behind `!isStreaming` left only the generic stop button, which aborts the
  // whole prompt instead of the compaction.
  const controlBlock = inputControlsSource.slice(
    inputControlsSource.indexOf("onClick={isCompacting ? onAbortCompaction : (event) => { if (!isStrayClick(event)) onCompact?.(); }}") - 200,
    inputControlsSource.indexOf('aria-label={isCompacting ? t("chat.stopCompaction")'),
  );

  assert.match(controlBlock, /\{\(!isStreaming \|\| isCompacting\) && onCompact && \(/);
  assert.doesNotMatch(controlBlock, /\{!isStreaming && onCompact && \(/);
  // The "streaming but not compacting" state is now unreachable, so its disabled styling
  // must be gone rather than left as dead branches.
  assert.doesNotMatch(controlBlock, /isStreaming && !isCompacting/);
  assert.match(controlBlock, /cursor: "pointer"/);
});

test("new session keeps configured default and known tool selection across mount effects", () => {
  assert.match(source, /const \[toolPreset, setToolPreset\] = useState<ToolPreset>\(CONFIGURED_TOOL_PRESET\);/);
  assert.match(source, /const \[toolSelectionKnown, setToolSelectionKnown\] = useState\(\(\) => isNew\);/);

  const mountEffect = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("// eslint-disable-next-line react-hooks/exhaustive-deps", source.indexOf("// Load session on mount")),
  );
  const beforeSessionBranch = mountEffect.slice(0, mountEffect.indexOf("if (session)"));
  const sessionBranch = mountEffect.slice(mountEffect.indexOf("if (session)"), mountEffect.indexOf("else if (pendingSessionView.resumingInitialization)"));

  assert.doesNotMatch(beforeSessionBranch, /setToolSelectionKnown\(false\)/, "挂载 effect 不能在新会话分支前把 toolSelectionKnown 覆盖回 false");
  assert.doesNotMatch(beforeSessionBranch, /setCustomToolNames\(null\)/, "挂载 effect 不能在新会话分支前清掉刚从偏好恢复的 customToolNames");
  assert.match(sessionBranch, /setToolSelectionKnown\(false\)/);
});

test("大纲跳转逐页请求同样带期限，失败走同一套清理", () => {
  const jumpSource = source.slice(
    source.indexOf("const loadUntilEntryId = useCallback"),
    source.indexOf("const loadSessionDetails = useCallback"),
  );

  assert.match(jumpSource, /const fetchJumpPage = async \(cursor: string, isFirstPage: boolean\) => \{/);
  assert.match(jumpSource, /withPageDeadline\(controller\.signal, EARLIER_PAGE_TIMEOUT_MS/);
  assert.doesNotMatch(jumpSource, /AbortSignal\.(any|timeout)/);
  // 一页不返回时，顶部和跳转按钮都要能退出加载状态。
  assert.match(jumpSource, /loading: false, failed: firstPageFailed/);
  // 只有顶部游标那一页失败才给顶部挂重试：后续页失败时顶部游标没变，重试那页回不到这次跳转。
  assert.match(jumpSource, /const markJumpFailure = \(isFirstPage: boolean\) => \{/);
  assert.match(jumpSource, /if \(isFirstPage\) firstPageFailed = true;/);
  assert.match(jumpSource, /fetchJumpPage\(before, step === 0\)/);
  // 404：先校验归属，再与普通翻页共用 terminatePagination（关掉分页 + 提示文件已不存在）。
  assert.match(source, /function terminatePagination\(current: HistoryPageState, sid: string\): HistoryPageState/);
  assert.match(jumpSource, /if \(result\.kind === "missing"\) \{/);
  assert.match(jumpSource, /setHistoryPage\(\(current\) => terminatePagination\(current, sid\)\)/);
  assert.ok(
    jumpSource.indexOf('currentRequest.generation !== generation') < jumpSource.indexOf('result.kind === "missing"'),
    "missing 要在会话/代次校验之后处理",
  );
  assert.equal((jumpSource.match(/fetchSessionContext\(/g) ?? []).length, 1);
});
test("a tool preset change is shown only after the server applies it", () => {
  const body = source.slice(
    source.indexOf("const handleToolPresetChange"),
    source.indexOf("// One lease request:"),
  );

  // 切换可能被拒绝（例如还有待移回的消息）：档位与勾选必须在服务端确认之后才改，
  // 否则用户以为换了档，模型还在用旧工具。
  const sendIndex = body.indexOf('type: "set_tools"');
  assert.ok(sendIndex > 0, "the request is there");
  assert.match(body.slice(sendIndex), /setToolPresetState\(preset\)/, "the chip follows the server");

  // 上一次切换没落地时忽略新的点击：它只能拿到同一份旧名单，晚到的请求会覆盖前一次。
  // 连浏览器偏好都不能写——那是新建会话的来源，写了就会采用这份旧名单。
  // 运行、手动压缩和 `!` 命令期间服务端会拒绝 set_tools，这时同样不能写偏好。
  const guardIndex = body.indexOf("if (toolSelectionPendingRef.current || agentRunningRef.current || bashRunningRef.current || isCompacting) return;");
  assert.ok(guardIndex > 0, "the re-entry and busy guard is there");
  assert.ok(guardIndex < body.indexOf("setPreferredToolPreset(preset)"), "it runs before the preference is written");
  assert.match(body, /finally \{\s*toolSelectionPendingRef\.current = false;\s*setToolSelectionPending\(false\);/);

  // 偏好要等服务端接受之后再写：被拒绝的切换不能变成之后新会话的默认工具。
  const accepted = body.slice(sendIndex);
  assert.match(accepted, /setPreferredToolPreset\(preset\);\s*\n\s*setPreferredCustomTools\(customNames\);/, "the preference follows the accepted request");

  // 派发之前只有一条提前设置：还没有会话时，这一档就是待创建会话要用的选择。
  const beforeSend = body.slice(0, sendIndex);
  assert.equal((beforeSend.match(/setToolPresetState\(preset\)/g) ?? []).length, 1);
  // 还没有会话时这一档直接生效，同时记进草稿状态（创建入口按草稿取名单，偏好只做新草稿的默认值）。
  assert.match(beforeSend, /if \(!sid\) \{[\s\S]*?setPreferredToolPreset\(preset\);[\s\S]*?setToolPresetState\(preset\);\s*if \(newSessionCwd\) onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_TOOLS", tools: \{ preset, custom: customNames \} \}\);\s*return;/);
});

test("the read-only tool list keeps the server's tool names", () => {
  const loader = source.slice(
    source.indexOf("const loadTools = useCallback"),
    source.indexOf("const promoteNewSession"),
  );

  // PowerShell 模式下 get_tools 激活的是 powershell：清单照实显示，只有推预设和标注差异时才归一成 bash。
  assert.match(loader, /const activeNames = \[\.\.\.new Set\(tools\.filter\(\(tool\) => tool\.active\)\.map\(\(tool\) => tool\.name\)\)\];/);
  assert.match(loader, /const names = activeNames\.map\(normalizeBuiltinToolName\)/);
  assert.match(loader, /setActiveToolNames\(activeNames\);/);
  // off 会话返回的就是空列表，不能因为「空」跳过写入：[] 与「拿不到名单」是两件事。
  assert.doesNotMatch(loader, /activeNames\.length/);
});

test("re-reads the tool list when the read-only menu opens", () => {
  // 运行中扩展、Shadow 开关会改服务端激活的工具：打开只读菜单前重读一次。
  assert.match(source, /const refreshTools = useCallback\(\(\) => \{\s*const sid = sessionIdRef\.current;\s*if \(sid\) void loadTools\(sid\);/);
  // 切换会话后返回的结果直接丢弃（loadTools 只在会话仍是这一个、且仍是最新一次读取时才写状态）。
  assert.match(source, /if \(sessionIdRef\.current === sid && toolListReadSeqRef\.current === readSeq\) \{/);
  assert.match(source, /loadTools, refreshTools, loadSlashCommands/);
});

test("only the latest tool read may commit its list", () => {
  const loader = source.slice(
    source.indexOf("const toolListReadSeqRef = useRef(0);"),
    source.indexOf("const promoteNewSession"),
  );

  // 打开只读菜单会新发一次读取：较早那条可能先拿到 get_tools、卡在 get_tool_selection 上，
  // 等新读取提交后才回来。只比会话 id 挡不住它，必须再比"自己是不是最新一次读取"。
  assert.match(loader, /const readSeq = toolListReadSeqRef\.current \+ 1;/);
  assert.match(loader, /toolListReadSeqRef\.current = readSeq;/);
  assert.match(loader, /const tools = await sendAgentCommand<ToolEntry\[\]>\(sid, \{ type: "get_tools" \}\);/);
  assert.match(loader, /const selection = await sendAgentCommand<\{ pinned: string\[\] \| null \}>\(sid, \{ type: "get_tool_selection" \}\)[\s\S]{0,80}\.catch\(\(\) => null\);/);
  assert.match(loader, /if \(sessionIdRef\.current === sid && toolListReadSeqRef\.current === readSeq\) \{/);
});

test("草稿切模型把档位一起写进草稿状态，创建入口先等它落地", () => {
  const handleModelChange = source.slice(
    source.indexOf("const handleModelChange = useCallback"),
    source.indexOf("const target = { provider, modelId };"),
  );

  // 档位要等推荐返回才定：整段切换是一个可等待的任务，创建入口按它串行。
  assert.match(handleModelChange, /const switching = \(async \(\): Promise<DraftModelSelection \| null> => \{/);
  // 档位解析本身出错不能把首条消息一起拒掉：创建入口等的是"已结算"的那个 promise。
  assert.match(handleModelChange, /const settled = switching\.catch\(\(error: unknown\): DraftModelSelection \| null => \{/);
  assert.match(handleModelChange, /await settled;/);
  // 同 cwd 也登记一份：切走再回来重建的实例看不到这个 ref，只能按 cwd 找到这次切换。
  // 同 cwd 也登记一份并带上版本：重建的实例看不到这个 ref，只能按 cwd 找到这次切换；
  // 版本则让先发起、晚结算的那次认得出自己已经作废。
  assert.match(handleModelChange, /const switchVersion = newSessionCwd \? beginDraftModelSwitch\(newSessionCwd\) : null;/);
  assert.match(handleModelChange, /registerDraftModelSwitch\(newSessionCwd, switchVersion, settled\);/);
  assert.match(handleModelChange, /settleDraftModelSwitch\(newSessionCwd, switchVersion\);/);
  assert.match(handleModelChange, /draftModelSwitchRef\.current = \{ version: switchVersion \?\? 0, task: settled \};/);
  // 提交前核对版本：同一草稿上已有更新的一轮时不再写回草稿。
  assert.match(handleModelChange, /if \(newSessionCwd && switchVersion !== null && !isLatestDraftModelSwitch\(newSessionCwd, switchVersion\)\) \{\s*return null;/);
  // 模型与档位在同一次草稿事件里提交：只写模型会留下「新模型 + 旧档位」的窗口，
  // 用户正好这时切走再回来，重建的组件就会把旧档位套到新模型上。
  assert.match(handleModelChange, /let committed: DraftModelSelection = \{ model: selectedModel, thinkingLevel: draftLevel, thinkingLevelSource \};/);
  assert.match(handleModelChange, /let levelRevisionAtStart = startLevelRevision;/);
  // 限幅后的值用读草稿那一刻的修订号提交：仍用发起时的旧值，reducer 会保留原始的越界手选值。
  assert.match(handleModelChange, /levelRevisionAtStart = latestControl\.levelRevision \?\? levelRevisionAtStart;/);
  assert.match(handleModelChange, /onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_MODEL", \.\.\.committed, levelRevisionAtStart \}\);/);
  assert.doesNotMatch(handleModelChange, /type: "SET_THINKING_LEVEL"/);
  // 兜底先取现有的手动覆盖/推荐档（重选同一个模型时档位不动），切到别的模型再按目标模型重算。
  assert.match(handleModelChange, /let draftLevel: ThinkingLevelOption = thinkingLevelOverrideRef\.current \?\? recommendedThinkingLevelRef\.current \?\? "auto";/);
  assert.match(handleModelChange, /draftLevel = parseThinkingLevelOption\(snapshot\.state\.thinkingLevel\);/);

  // 首条消息与 materialize 这两个创建入口都先等它，不会拿新模型配旧档位。
  const send = source.slice(
    source.indexOf("const handleSend = useCallback"),
    source.indexOf("const handleAbort = useCallback"),
  );
  assert.match(send, /if \(isNew\) await awaitDraftModelSwitch\(\);/);
  const materialize = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const selectedModel = latest.model;", source.indexOf("const ensureNewSession")),
  );
  assert.match(materialize, /await awaitDraftModelSwitch\(\);/);
  // 等待必须发生在 START 之前：状态机进入 materializing 后就不再接收档位事件。
  const materializeFull = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const selectedModel = latest.model;", source.indexOf("const ensureNewSession")),
  );
  assert.match(materializeFull, /await awaitDraftModelSwitch\(\);[\s\S]{0,1200}type: "START"/);

  // 发送时不能再用渲染闭包里的模型，也不能只用本实例的 ref：等待期间切走再回来，模型是在
  // 另一个实例里改的，本实例的 ref 还停在旧模型上。
  assert.match(send, /const latest = currentNewSessionSettings\(\);\s*const selectedModel = latest\.model;/);
});

test("切走再返回后，首个创建入口仍等同 cwd 登记的切模任务", () => {
  // 重建的实例没有旧实例的 ref：只查 ref 会让首条消息绕过还在解析的切换，拿旧模型开跑。
  assert.match(source, /const current = \(\) => newSessionCwd \? getDraftModelSwitch\(newSessionCwd\) : draftModelSwitchRef\.current;/);
  assert.match(source, /const pending = current\(\);/);
  assert.match(source, /await waitForDraftModelSwitchTask\(newSessionCwd, pending\)/);
  // 采用结果前核对该轮仍是同一草稿上最新的一次：后来的选择不能被先发起的那份覆盖。
  assert.match(source, /const latest = !newSessionCwd \|\| isLatestDraftModelSwitch\(newSessionCwd, pending\.version\);/);
  assert.match(source, /if \(selection && latest\) \{\s*applyDraftSelection\(selection\);\s*return;/);
  // 作废的那一份不能反复等：丢掉自己的 ref 再看下一轮（可能是别的实例登记的那次）。
  assert.match(source, /if \(draftModelSwitchRef\.current\?\.task === pending\.task\) draftModelSwitchRef\.current = null;/);
});

test("切模期间手动选档时仍然提交目标模型", () => {
  const handleModelChange = source.slice(
    source.indexOf("const handleModelChange = useCallback"),
    source.indexOf("const target = { provider, modelId };"),
  );
  // 选档会让推荐请求过期（committed=false），但用户已经选了模型：只提交档位不提交模型，
  // 切走再回来就会恢复成「旧模型 + 给新模型选的档位」。
  assert.match(handleModelChange, /if \(newSessionModelOverrideRef\.current !== selectedModel\) return null;/);
  // 被另一轮切换取代时才整段放弃；用户手动选档只是让推荐作废，模型仍要提交。
  assert.match(handleModelChange, /if \(selection\.status === "superseded"\) return null;/);
  assert.match(handleModelChange, /else if \(selection\.status === "applied"\) \{/);
  assert.match(handleModelChange, /status 为 "manual"（切模期间用户手动选了档）时保留用户刚选的那一档/);
});

test("创建参数按等完之后的草稿取，START 也排在等待之后", () => {
  const materializeSlice = (marker) => source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf(marker, source.indexOf("const ensureNewSession")),
  );
  const materialize = materializeSlice("const selectedModel = latest.model;");
  // 等待期间草稿仍可改模型、档位和 Shadow 开关：等完之后按最新草稿取参数，否则运行时按旧设置初始化。
  assert.match(materialize, /await awaitDraftModelSwitch\(\);[\s\S]{0,600}const latest = currentNewSessionSettings\(\);/);
  assert.match(materialize, /const latestView = latest\.view;/);
  assert.match(materialize, /const requestedShadowMindEnabled = latestView\.desiredShadowMindEnabled;/);
  // 等的时候另一个入口可能已经建好 runtime：直接接管，不再重复创建。
  assert.match(materialize, /if \(latestControl\.kind === "materialized" && latestView\.transportSessionId\)/);
  // 首条消息那条路径同样按最新草稿取模型、档位和 Shadow。
  assert.match(source, /const latest = currentNewSessionSettings\(\);\s*const selectedModel = latest\.model;\s*const selectedThinkingLevel = latest\.thinkingLevel;\s*const shadowMindEnabled = latest\.shadowMindEnabled;/);
});

test("创建参数读的是草稿的渲染无关镜像", () => {
  const settings = source.slice(
    source.indexOf("const currentNewSessionSettings = useCallback"),
    source.indexOf("const promptRunIdRef = useRef"),
  );
  // 切走再回来会重建实例：等待期间用户是在新实例里改的设置，本实例的 props/refs 都过期了。
  // 直接打开 `?cwd=` 时没有任何事件派发过，镜像还是空的：必须退回本实例 props，否则那次
  // 算出来的推荐写不进草稿。
  assert.match(source, /const currentDraftControl = useCallback\(\(\): PendingNewSessionControl => \(\s*\(newSessionCwd \? latestPendingNewSessionControl\(newSessionCwd\) : null\) \?\? pendingNewSessionControlRef\.current\s*\), \[newSessionCwd\]\);/);
  assert.match(settings, /const control = currentDraftControl\(\);/);
  assert.match(settings, /const model = settings\?\.model \?\? newSessionModelOverrideRef\.current \?\? null;/);
  // 创建用的档位按真正被创建的那个模型限幅：切模等待期间界面还按切之前的模型给选项。
  assert.match(settings, /thinkingLevel: recommendationMatches && level \? clampThinkingLevelToSupported\(level, supported\) : null,/);
  assert.match(settings, /shadowMindEnabled: view\.desiredShadowMindEnabled,/);
  // 归约的输入取镜像、结果同步写回：React state 的提交时机不确定，切模结算与它同在一个
  // 微任务链里，按 state 归约可能接在还没提交的上一份后面。
  assert.match(sessionNavigationSource, /const previous = latestPendingNewSessionControl\(cwd\) \?\? DEFAULT_PENDING_NEW_SESSION_CONTROL;/);
  assert.match(sessionNavigationSource, /const control = reducePendingNewSession\(previous, event\);\s*mirrorPendingNewSessionControl\(cwd, control\);\s*if \(control === previous\) return;/);
  // 建好会话 / 丢弃草稿时两边一起清，否则下一个草稿会从上一份记录继续。
  assert.match(sessionNavigationSource, /clearPendingNewSessionControl\(session\.cwd\);/);
});

test("等待切模期间收紧的工具名单也要带进创建请求", () => {
  // 等待期间草稿仍可改工具档位，而且可能是在切走再回来重建的实例里改的：创建入口读草稿
  // 自己记下的那一份（同一 cwd 共享），浏览器偏好只用来初始化从没改过工具的草稿——
  // 偏好是整台浏览器共用的一份，别的标签页改它或写入被拒时，界面和创建请求就会分叉。
  assert.match(source, /const currentNewSessionToolNames = useCallback\(\(\) => \{\s*const control = currentDraftControl\(\);\s*const draftTools = "tools" in control \? control\.tools : null;/);
  // 挂载时把这一刻真正显示的名单也记进草稿：不记的话，创建请求会重新读偏好，别的标签页
  // 改偏好后界面显示一档、请求用另一档。
  assert.match(source, /if \(!draftTools && newSessionCwd\) \{\s*onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_TOOLS", tools: \{ preset, custom \} \}\);/);
  assert.match(source, /const preset = draftTools\?\.preset \?\? getPreferredToolPreset\(\);/);
  assert.match(source, /const custom = draftTools \? draftTools\.custom : getPreferredCustomTools\(\);/);
  assert.doesNotMatch(source, /newSessionToolsRef/);
  // 选择时同时写进草稿状态：跨标签页改偏好也改不到已选好的一档。
  assert.match(source, /onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_TOOLS", tools: \{ preset, custom: customNames \} \}\);/);
  // 两个创建入口（materialize 和首条消息）都用这份最新名单。
  assert.equal((source.match(/toolNames: currentNewSessionToolNames\(\),/g) ?? []).length, 2);
  assert.doesNotMatch(source, /toolNames: customToolNames \?\? getToolNamesForPreset\(toolPreset\)/);
});

test("切模期间手选的档位要按目标模型限幅后再提交", () => {
  const handleModelChange = source.slice(
    source.indexOf("const handleModelChange = useCallback"),
    source.indexOf("const target = { provider, modelId };"),
  );
  // 界面在等待期间还按切之前的模型给选项：A 支持 max、B 最高只到 high 时，直接保留手选值
  // 会把 B 做不到的档位写进草稿和创建请求。
  assert.match(handleModelChange, /const supported = thinkingLevelsRef\.current\[`\$\{selectedModel\.provider\}:\$\{selectedModel\.modelId\}`\] \?\? null;/);
  assert.match(handleModelChange, /thinkingLevel: picked === "auto" \? picked : clampThinkingLevelToSupported\(picked, supported\),/);
  // 创建入口再兜一次：草稿里残留的越界值也不会被发出去。
  const settings = source.slice(
    source.indexOf("const currentNewSessionSettings = useCallback"),
    source.indexOf("const promptRunIdRef = useRef"),
  );
  assert.match(settings, /const target = model \?\? newSessionModel \?\? newSessionDefaultModel \?\? null;/);
  assert.match(settings, /thinkingLevel: recommendationMatches && level \? clampThinkingLevelToSupported\(level, supported\) : null,/);
});

test("连续被取代的切模不能提前结束等待", () => {
  const wait = source.slice(
    source.indexOf("const awaitDraftModelSwitch = useCallback"),
    source.indexOf("const currentNewSessionSettings = useCallback"),
  );
  // 每一轮都在结算前被下一轮取代时（包括第 21 次），循环不能提前返回：创建随后进入
  // materializing，留下的那次选择会连同它的 SET_MODEL 一起被丢掉。所以不设轮数上限，
  // 只要还有在途登记就继续等；同一份任务再次出现才结束。
  assert.doesNotMatch(source, /MAX_DRAFT_SWITCH_WAITS/);
  assert.match(wait, /let awaited: Promise<DraftModelSelection \| null> \| null = null;\s*for \(;;\) \{/);
  assert.match(wait, /if \(!pending \|\| pending\.task === awaited\) return;/);
});

test("自动推荐档位与手动选择一起发给创建接口，但只有手动算显式选择", () => {
  // 创建接口按这个标记决定要不要把档位写成新的全局默认：自动推荐只作用于这个会话，
  // 写进 settings.json 的 defaultThinkingLevel 会影响之后创建的所有会话。
  const settings = source.slice(
    source.indexOf("const currentNewSessionSettings = useCallback"),
    source.indexOf("const promptRunIdRef = useRef"),
  );
  assert.match(settings, /thinkingLevelExplicit: settings \? settings\.thinkingLevelSource === "manual" : thinkingLevelOverrideRef\.current !== null,/);
  assert.equal((source.match(/thinkingLevelExplicit: latest\.thinkingLevelExplicit,/g) ?? []).length, 2);
});

test("手动选中的 auto 在重挂载后仍然算手动", () => {
  // 标记从草稿恢复：新实例若从 false 起步，目录加载会把历史推荐显示出来，而草稿仍写着
  // 手动 auto（创建请求省略档位），界面和请求又对不上。
  assert.match(source, /const explicitAutoThinkingRef = useRef\(\s*initialPendingSettings\?\.thinkingLevel === "auto" && initialPendingSettings\.thinkingLevelSource === "manual",\s*\);/);
  assert.match(source, /explicitAutoThinkingRef\.current = initialPendingSettings\.thinkingLevel === "auto"\s*&& initialPendingSettings\.thinkingLevelSource === "manual";/);
});

test("运行态快照要告诉调用方档位有没有被采纳", () => {
  // 被跳过的旧档位不能再写回草稿或选择器，否则界面显示旧档位、运行时用新档位。
  assert.match(source, /return \{ thinking: thinkingAdopted \};/);
  assert.match(source, /const adoption = applyRuntimeSnapshot\(read, snapshot\.state\);/);
});

test("过期的默认档位加载不得清掉已切到的新模型的推荐", () => {
  const loadModels = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const loadAllModels = useCallback"),
  );
  // load() 被切模型取代时返回 undefined：把它当成"没有推荐"写进去，
  // 界面还显示着推荐档、创建请求却省掉了 thinkingLevel。
  // `undefined` = 这次加载不适用/已被切模型取代，不能当成"没有推荐"；`null` 才是适用但没有值。
  assert.match(loadModels, /if \(preferredThinking === undefined\) return;/);
  assert.match(loadModels, /recommendedThinkingLevelRef\.current = preferredThinking;/);
  // 推荐档同样要进草稿状态：它已经显示在输入框里，创建请求若省掉 thinkingLevel，服务端会按
  // settings 的默认档位开跑，首条消息用的档位和界面显示的不是一个。
  assert.match(loadModels, /const next = preferredThinking \?\? "auto";/);
  assert.match(loadModels, /onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_THINKING_LEVEL", level: next, source: "auto", recommendationModel: recommendation.model \}\);/);
  // 草稿跟着默认模型、档位是自动推荐时每次加载都重算：默认模型换人后，旧推荐属于上一个模型。
  assert.match(loadModels, /const followsDefault = Boolean\(draftControl\)/);
  assert.match(loadModels, /\(recommendedThinkingLevelRef\.current === null \|\| followsDefault\)/);
  // 用户主动选的 `auto`（交给服务端定档）不该被目录刷新算出的推荐覆盖：否则输入框显示
  // 一个创建请求不会带上的档位。
  assert.match(loadModels, /applyPinnedThinking: !explicitAutoThinkingRef\.current/);
  assert.match(source, /explicitAutoThinkingRef\.current = level === "auto";/);
  assert.match(source, /if \(selection\.thinkingLevel !== "auto"\) explicitAutoThinkingRef\.current = false;/);
});

test("草稿恢复按来源把档位放回推荐值或手动覆盖", () => {
  // 切模型解析出来的档位是"自动推荐"，用户点选的是"手动选择"：
  // 恢复时都塞进手动覆盖，会让自动推荐在重新打开草稿后变成显式选择的档位。
  assert.match(source, /const initialLevelIsManual = initialPendingSettings\?\.thinkingLevelSource === "manual";/);
  assert.match(source, /initialLevelIsManual \? initialThinkingLevel : null,/);
  assert.match(source, /initialLevelIsManual \? null : initialThinkingLevel,/);
  assert.match(source, /onPendingNewSessionEvent\(newSessionCwd, \{ type: "SET_THINKING_LEVEL", level, source: "manual" \}\)/);
  // 另一个实例（切走再回来重建的那个）把模型和档位一起写回草稿后，本实例没有在途切换时要跟进：
  // 否则状态机和界面都换了模型，这个实例的创建请求还在用旧模型。
  assert.match(source, /if \(!isNew \|\| !initialPendingSettings\?\.model \|\| draftModelSwitchRef\.current\) return;/);
  assert.match(source, /newSessionModelOverrideRef\.current = selection\.model;/);
});

test("the external-write error path keeps the queued messages reachable", () => {
  const loader = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const scheduleContextRefresh"),
  );
  // 外部写入时 /context 一直 409，但 get_state / clear_queue 仍可用：读出队列，交给错误页。
  assert.match(loader, /isSessionExternalWriteError\(error\)[\s\S]{0,600}fetchRuntimeState\(sid/);
  assert.match(loader, /setBlockedRecall\(/);

  const handler = source.slice(
    source.indexOf("const handleRecallBlockedQueue"),
    source.indexOf("const handleThinkingLevelChange"),
  );
  assert.match(handler, /type: "clear_queue"/);
  assert.match(handler, /setDraft\(sid, prependChatDraft\(draft/);
  assert.match(handler, /setBlockedRecall\(null\)/);
  assert.match(handler, /setError\(null\)/);
  // 队列清空后 wrapper 才能被淘汰，/context 也才能重新读盘；带缓存的首屏必须让服务端复验，
  // 否则会直接提交旧内容并清掉恢复状态。
  assert.match(handler, /await loadSession\(sid, true, true, \{ validateView: true \}\)/);
  // 取回之后草稿是唯一一份：重读失败也要保留恢复状态，并给出只重试读取的入口。
  assert.match(handler, /setRecalledPending\(true\)/);
  assert.match(handler, /markDraftRestorePending\(sid\)/);
  // 取回结果按会话 ID 送到当前挂载的输入框；旧实例卸载后只写存储，不再碰界面也不再重读。
  assert.match(handler, /notifyRecalledDraft\(sid, draft\)/);
  assert.ok(
    handler.indexOf("if (!mountedRef.current) return;") < handler.indexOf("await loadSession(sid, true, true, { validateView: true })"),
    "an unmounted instance does not reload",
  );
  assert.match(handler, /setRecallError\(e instanceof Error \? e\.message : String\(e\)\)/);
  // 重载成功也要恢复运行态：命令还在跑时建连不会把界面标记成运行中。
  assert.match(handler, /const reloaded = await loadSession\(sid, true, true, \{ validateView: true \}\);/);
  assert.match(handler, /restoreRuntimeFromLoad\(sid, reloaded\.agentState, reloaded\.runtimeRead\)/);
  const retry = source.slice(source.indexOf("const handleRetryBlockedLoad"), source.indexOf("const handleThinkingLevelChange"));
  assert.match(retry, /void loadSession\(sid, true, true, \{ validateView: true \}\)/);
  assert.match(source, /setExternalWriteBlocked\(isSessionExternalWriteError\(error\)\)/);
  // 切走再切回来会重新挂载：恢复状态按会话 ID 留在草稿存储里，挂载时读回来。
  assert.match(
    source,
    /const sid = sessionIdRef\.current \?\? "";\s*setRecalledPending\(hasPendingDraftRestore\(sid\)\);/,
    "a remount reads the marker back",
  );
  assert.match(source, /clearDraftRestorePending\(sid\)/);
  // 取回请求可能在新实例挂载之后才返回：当前会话订阅恢复标记，立刻转成「已取回」并清掉队列提示。
  assert.match(
    source,
    /return subscribeDraftRestore\(sid, \(\) => \{[\s\S]{0,900}?blockedRecallRequestRef\.current \+= 1;[\s\S]{0,900}?setRecalledPending\(true\);\s*setBlockedRecall\(null\);/,
    "a late queue probe cannot bring the stale recall entry back",
  );
  assert.match(source, /if \(requestId !== blockedRecallRequestRef\.current\) return;/);
  // 通过校验的查询结果始终应用：另一个标签页已经取回时队列是空的，入口要跟着消失。
  assert.match(source, /setBlockedRecall\(queued\.steering\.length > 0 \|\| queued\.followUp\.length > 0 \? queued : null\)/);
  // 队列状态按代次校验：预读可能在取回清空队列之前采集、之后才回来，不能把队列写回去。
  // 加载自己推进队列代次，预读的坐标里记的就是这一代（不再另算 queueIsCurrent）。
  assert.match(source, /queueStateGenerationRef\.current \+= 1;\s*\/\/ 预读也用统一读取坐标/);
  assert.match(source, /applyRuntimeSnapshot\(runtimeRead, snapshot\.state\)/);
  assert.doesNotMatch(
    source.slice(source.indexOf("const agentState = earlyRuntimePromise"), source.indexOf("return { loaded: true, agentState, runtimeRead };")),
    /applyRuntimeState\(/,
  );
  assert.match(handler, /queueStateGenerationRef\.current \+= 1;/);
  // 旧实例的取回通知也要让新实例的队列代次失效、并清空输入框里的队列。
  assert.match(
    source,
    /blockedRecallRequestRef\.current \+= 1;\s*updateQueuedMessages\(\{ steering: \[\], followUp: \[\] \}\)/,
  );
  // 预读失败同样按代次校验队列：否则超时的旧请求会把后来出现的排队消息清空。
  // 状态请求失败不重置运行状态：否则旧预读超时会清掉建连补读或 compaction_start 刚设好的压缩状态。
  const earlyFailure = source.slice(
    source.indexOf("Failed to load early session runtime state"),
    source.indexOf("if (showLoading) setLoading(true);"),
  );
  assert.doesNotMatch(earlyFailure, /applyRuntimeState\(undefined\)/);
  // 错误的队列更新与取回后的补查都要写进错误页读的那一份。
  // 实时队列更新也走唯一入口，错误页入口由那一处同步（不再各自写一份）。
  assert.match(source, /case \"queue_update\": \{[\s\S]{0,600}?updateQueuedMessages\(queued\);/);
  assert.match(source, /const queued = normalizeQueuedMessages\(snapshot\?\.state\?\.queuedMessages\);\s*updateQueuedMessages\(queued\);\s*\/\/[^\n]*\n\s*setBlockedRecall\(/);
  // 建连后的补读同样按代次校验队列。
  assert.match(
    source,
    /const connectRead = beginRuntimeRead\(\);\s*void fetchRuntimeState\(sid, controller\.signal\)/,
  );
  // 读取序号：较新的快照提交后，更早的响应不许再覆盖压缩状态（压缩可能发生在取样之后、监听之前）。
  assert.match(source, /lastAppliedRuntimeSeqRef\.current = read\.seq;/);
  // 上下文的思考档位只作回退：运行态已经给过这个会话档位时不再覆盖。
  assert.match(source, /runtimeThinkingLevelSessionRef\.current !== sid/);
  // 迟到的预读同样不许写回旧档位：思考强度与压缩状态共用读取序号。
  assert.match(source, /applyRuntimeSnapshot\(runtimeRead, snapshot\.state\);/);

  // 每次加载错误都按本次结果更新外部写入标记，重试成普通 500 时不会继续误报。
  assert.match(source, /setExternalWriteBlocked\(isSessionExternalWriteError\(error\)\);/);
  // 实时队列更新让在途补读/重查作废；取回通知清空后按最新状态补一次查询。
  assert.match(source, /case "queue_update":[\s\S]{0,200}?queueStateGenerationRef\.current \+= 1;/);
  assert.match(source, /const generation = queueStateGenerationRef\.current \+ 1;\s*queueStateGenerationRef\.current = generation;\s*void fetchRuntimeState\(sid/);
  // 错误页的探查也要按队列代次校验：实时 queue_update 之后回来的旧空队列不能清掉入口。
  assert.match(loader, /const probeRead = beginRuntimeRead\(\);\s*void fetchRuntimeState\(sid, new AbortController\(\)\.signal\)/);
  // 探查也取读取坐标：它拿到的新队列如果只写 blockedRecall，之后返回的旧预读仍会清掉入口。
  assert.match(loader, /const probeRead = beginRuntimeRead\(\);/);
  assert.match(loader, /if \(queueStateGenerationRef\.current !== probeRead\.queueGeneration\) return;/);
  assert.match(loader, /if \(probeRead\.seq <= lastAppliedQueueSeqRef\.current\) return;/);
  assert.match(loader, /lastAppliedQueueSeqRef\.current = probeRead\.seq;\s*updateQueuedMessages\(/);
  // 压缩状态另有代次：预读只应用一次，迟到快照不许把 compaction_start 盖回去。
  assert.match(source, /compactionEpochRef\.current \+= 1;/);
  assert.doesNotMatch(
    source.slice(source.indexOf("const agentState = earlyRuntimePromise"), source.indexOf("return { loaded: true, agentState, runtimeRead };")),
    /applyRuntimeState\(/,
    "the pre-read is applied once, not again after the load",
  );
  // Strict Mode 多跑一次 setup/cleanup：清理后必须恢复，否则仍然挂着的实例会跳过取回后的重载。
  assert.match(source, /mountedRef\.current = true;\s*return \(\) => \{ mountedRef\.current = false; \};/);
});

