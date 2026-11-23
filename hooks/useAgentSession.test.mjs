import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const inputControlsSource = await readFile(new URL("../components/InputControls.tsx", import.meta.url), "utf8");

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

test("refreshes Shadow runtime state after a cold SSE connection becomes ready", () => {
  const connector = source.slice(
    source.indexOf("const connectEvents = useCallback"),
    source.indexOf("const ensureEventsConnected"),
  );

  assert.match(
    connector,
    /event\.type === "connected"[\s\S]*?fetchRuntimeState\(sid, controller\.signal\)[\s\S]*?applyRuntimeState\(snapshot\.state, undefined, \{\s*queue: queueStateGenerationRef\.current === queueGeneration && isNewest,\s*compaction: compactionEpochRef\.current === compactionEpoch && isNewest,[\s\S]*?thinking: isNewest && thinkingChoiceRevisionRef\.current === thinkingRevision,?\s*\}\)/,
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
  assert.match(source, /queue: queueStateGenerationRef\.current === read\.queueGeneration && newest,/);
  assert.match(source, /compaction: compactionEpochRef\.current === read\.compactionEpoch && newest,/);
  assert.match(source, /thinking: newest && read\.thinkingRevision === thinkingChoiceRevisionRef\.current,/);
  // 预读改用统一坐标（不再就地算判据），建连补读就地判据也要带上档位版本。
  assert.match(source, /applyRuntimeSnapshot\(runtimeRead, snapshot\.state\)/);
  assert.match(source, /const runtimeRead = beginRuntimeRead\(\);/);
  assert.match(source, /thinking: isNewest && thinkingChoiceRevisionRef\.current === thinkingRevision,/);
  assert.match(source, /const thinkingRevision = thinkingChoiceRevisionRef\.current;\s*void fetchRuntimeState\(sid, controller\.signal\)/);
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
  assert.equal(raw.length, 1, "建连补读之外，运行态快照都必须走 applyRuntimeSnapshot");
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
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    runtimeReadSeqRef: { current: 0 },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    lastAppliedRuntimeSeqRef: { current: 0 },
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
  context.setQueuedMessages(parked);
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
    setIsCompacting() {}, setQueuedMessages() {},
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    setRunningCommands() {}, setFastEnabled() {}, setRuntimeFastAvailable() {}, applyShadowRuntimeState() {},
    setContextUsage() {}, applyContextUsage() {}, setSystemPrompt() {}, setLiveTotalActiveMs() {},
    modelSelectionActions: { setThinkingLevel: (value) => levels.push(value) },
    setExtensionStatuses() {}, setExtensionWidgets() {}, filterVisibleExtensionWidgets: (value) => value ?? [],
    newSessionCwd: null, projectExtensionBinding: () => "bound", onPendingNewSessionEvent() {},
    runtimeThinkingLevelSessionRef: { current: null },
    runtimeBusySnapshotRef: { current: null },
    runtimeReadSeqRef: { current: 0 },
    queueStateGenerationRef: { current: 0 },
    compactionEpochRef: { current: 0 },
    lastAppliedRuntimeSeqRef: { current: 0 },
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
  assert.equal((thinkingHandler.match(/thinkingChoiceRevisionRef\.current \+= 1;/g) ?? []).length, 2);

  // 之后发的读取带着新版本，仍然可以纠正（例如别的标签页又改过档）。
  const later = context.beginRuntimeRead();
  context.applyRuntimeSnapshot(later, { thinkingLevel: "medium" });
  assert.deepEqual(levels, ["low", "low", "medium"]);
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
  assert.match(catchSource, /if \(!isSessionExternalWriteError\(error\) && earlyRuntimePromise\) \{/);
  assert.match(catchSource, /if \(!snapshot \|\| queueStateGenerationRef\.current !== runtimeRead\.queueGeneration\) return;/);
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
    setIsCompacting: (value) => compacting.push(value),
    setQueuedMessages() {},
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
  const guardIndex = body.indexOf("if (toolSelectionPendingRef.current) return;");
  assert.ok(guardIndex > 0, "the re-entry guard is there");
  assert.ok(guardIndex < body.indexOf("setPreferredToolPreset(preset)"), "it runs before the preference is written");
  assert.match(body, /finally \{\s*toolSelectionPendingRef\.current = false;\s*setToolSelectionPending\(false\);/);

  // 派发之前只有一条提前设置：还没有会话时，这一档就是待创建会话要用的选择。
  const beforeSend = body.slice(0, sendIndex);
  assert.equal((beforeSend.match(/setToolPresetState\(preset\)/g) ?? []).length, 1);
  assert.match(beforeSend, /if \(!sid\) \{[\s\S]*?setToolPresetState\(preset\);\s*return;/);
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
    /blockedRecallRequestRef\.current \+= 1;\s*setQueuedMessages\(\{ steering: \[\], followUp: \[\] \}\);/,
  );
  // 预读失败同样按代次校验队列：否则超时的旧请求会把后来出现的排队消息清空。
  // 状态请求失败不重置运行状态：否则旧预读超时会清掉建连补读或 compaction_start 刚设好的压缩状态。
  const earlyFailure = source.slice(
    source.indexOf("Failed to load early session runtime state"),
    source.indexOf("if (showLoading) setLoading(true);"),
  );
  assert.doesNotMatch(earlyFailure, /applyRuntimeState\(undefined\)/);
  // 错误的队列更新与取回后的补查都要写进错误页读的那一份。
  assert.match(source, /case "queue_update": \{[\s\S]{0,600}?setBlockedRecall\(queued\.steering\.length > 0 \|\| queued\.followUp\.length > 0 \? queued : null\)/);
  assert.match(source, /const queued = normalizeQueuedMessages\(snapshot\?\.state\?\.queuedMessages\);\s*setQueuedMessages\(queued\);\s*\/\/[^\n]*\n\s*setBlockedRecall\(/);
  // 建连后的补读同样按代次校验队列。
  assert.match(
    source,
    /const queueGeneration = queueStateGenerationRef\.current;\s*const compactionEpoch = compactionEpochRef\.current;\s*const runtimeReadSeq = \+\+runtimeReadSeqRef\.current;\s*const thinkingRevision = thinkingChoiceRevisionRef\.current;\s*void fetchRuntimeState\(sid, controller\.signal\)/,
  );
  // 读取序号：较新的快照提交后，更早的响应不许再覆盖压缩状态（压缩可能发生在取样之后、监听之前）。
  assert.match(source, /compaction: compactionEpochRef\.current === compactionEpoch && isNewest,/);
  assert.match(source, /lastAppliedRuntimeSeqRef\.current = Math\.max\(lastAppliedRuntimeSeqRef\.current, runtimeReadSeq\);/);
  // 上下文的思考档位只作回退：运行态已经给过这个会话档位时不再覆盖。
  assert.match(source, /runtimeThinkingLevelSessionRef\.current !== sid/);
  // 迟到的预读同样不许写回旧档位：思考强度与压缩状态共用读取序号。
  assert.match(source, /applyRuntimeSnapshot\(runtimeRead, snapshot\.state\);/);
  assert.match(source, /compaction: compactionEpochRef\.current === compactionEpoch && isNewest,[\s\S]*?thinking: isNewest && thinkingChoiceRevisionRef\.current === thinkingRevision,/);
  // 每次加载错误都按本次结果更新外部写入标记，重试成普通 500 时不会继续误报。
  assert.match(source, /setExternalWriteBlocked\(isSessionExternalWriteError\(error\)\);/);
  // 实时队列更新让在途补读/重查作废；取回通知清空后按最新状态补一次查询。
  assert.match(source, /case "queue_update":[\s\S]{0,200}?queueStateGenerationRef\.current \+= 1;/);
  assert.match(source, /const generation = queueStateGenerationRef\.current \+ 1;\s*queueStateGenerationRef\.current = generation;\s*void fetchRuntimeState\(sid/);
  // 错误页的探查也要按队列代次校验：实时 queue_update 之后回来的旧空队列不能清掉入口。
  assert.match(source, /const queueGeneration = queueStateGenerationRef\.current;\s*void fetchRuntimeState\(sid, new AbortController\(\)\.signal\)/);
  assert.match(source, /if \(queueStateGenerationRef\.current !== queueGeneration\) return;/);
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

