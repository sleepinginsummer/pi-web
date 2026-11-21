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

  assert.match(reconcileSource, /readAgentSnapshot\(sid\)/);
  assert.match(reconcileSource, /reconcileRequestGenerationRef\.current = generation/);
  assert.match(reconcileSource, /generation !== reconcileRequestGenerationRef\.current/);
  assert.equal((source.match(/const reconcileAgentState = useCallback/g) ?? []).length, 1);
  assert.match(mountSource, /agentState\.busy && runtimeState/);
  assert.match(reconcileSource, /applyRuntimeState\(snapshot\.state, \{ sid, runId, requestId: usageRequestId \}\)/);
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
  assert.match(paginationSource, /hasMore: false \}/);
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

  assert.match(connector, /event\.type === "connected"[\s\S]*?fetchRuntimeState\(sid, controller\.signal\)[\s\S]*?applyRuntimeState\(snapshot\.state\)/);
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
  assert.equal((jumpSource.match(/fetchSessionContext\(/g) ?? []).length, 1);
});
