# 会话加载与审查发现修复方案（2026-11-20）

本方案合并三份输入：两份对 `0.17.0-merge.14`（`cbf983e3`）的独立 review，以及针对「切会话慢 / 右侧重绘多」的实测排查。每条都标了**验证状态**：实测过、代码核对过、还是仅静态推断。已被证伪的说法单独列在最后一节，避免后面重复踩。

## 0. 验证口径

- **实测（服务端）**：`curl -w %{time_total}` 对 `/context`、`/details`、`/state`、`/outline` 计时，dev（30141）与本机 curl 两端互校。
- **实测（页面）**：用户 dev 标签页内用页面自带打点（`pi-session-click-to-request` 等）+ `MutationObserver` + `PerformanceObserver(longtask)` 统计提交次数与 DOM 变更量。
- **实测（脚本）**：`node --experimental-strip-types` 直接跑 `lib/outline-headings.ts` 等纯函数；复刻索引扫描；`node -e` 复现 Node 定时器溢出。
- **静态**：`node_modules/.bin/eslint <file>` 精确到行；其余为代码阅读。
- **未做**：完整 `npm test`、e2e、浏览器端 profiler 采样。

## 1. 结论总览

| 编号 | 优先级 | 问题 | 来源 | 验证状态 | 规模 |
|---|---|---|---|---|---|
| P0-1 | P0 | `tail` 原始记录上限导致大会话打开空白 | 本次实测 | **已实测复现** | S |
| P0-2 | P0 | 排队启动的扩展命令整段占着 prompt admission | review A | 代码核对 | S |
| P0-3 | P0 | 大纲标题编号与正文标记口径不一致 | review A（机制改写）+ 本次实测 | **已实测复现** | M |
| P1-1 | P1 | 大纲搜索框聚焦后浮层关不掉 | review B | 代码核对 | XS |
| P1-2 | P1 | 暂存库编辑保存后仍显示「失败」 | review B | 代码核对 | XS |
| P1-3 | P1 | `ChatWindow` 卸载读挂载时的 `session?.id` | review B | 代码核对 | XS |
| P1-4 | P1 | `ChatInput` 快捷键漏 `extensionUiOpen` 依赖 | review B | **eslint 已报** | XS |
| P1-5 | P1 | `useAgentSession` 返回值漏 4 个依赖 | review B | **eslint 已报** | S |
| P1-6 | P1 | 内置斜杠命令闭包漏依赖 | review B | **eslint 已报** | XS |
| P1-7 | P1 | 细节清理：inline code 透传 `node`、死代码 | review B | 代码核对 | XS |
| P2-1 | P2 | minimap 每次测量重拼全部回答 Markdown + 缓存失效 | 本次实测 + review A | **已实测复现** | S |
| P2-2 | P2 | 切会话 = 整树重挂载 + 分 13 次提交 | 本次实测 | **已实测** | M |
| P2-3 | P2 | 折叠的过程详情仍提前构造全套 JSX | review B | 代码核对 | S |
| P2-4 | P2 | 两处无界缓存 | review B | 代码核对 | S |
| P2-5 | P2 | 会话搜索逐行 `JSON.parse` | review B | 代码核对 | S |
| P2-6 | P2 | 日志截断用 `Array.shift()` | review B | 代码核对 | S |
| P2-7 | P2 | 底栏三个轮询无引用稳定、回前台双请求 | review B（部分） | 代码核对 | S |
| P2-8 | P2 | `/state` 携带整份 `systemPrompt` | 本次实测 | **已实测** | S |
| P3-1 | P3 | `parentId` 回溯无环检测 | review B | 代码核对 | S |
| P3-2 | P3 | `check_in_seconds` 无上限 | review B | **已实测 Node 行为** | XS |
| P3-3 | P3 | `/context` 304 仍先建分支树 | review A | 代码核对 | S |

## 2. P0：先修（真 bug，用户可感知或阻塞操作）

### P0-1 大会话打开是空白

**现象**：切到那个 22MB 的 qfang 会话（`01a15768…`，1833 条消息），右侧只剩「向上滚动以加载更早的消息（隐藏 0 条）」，没有一条消息。

**证据**

```
$ curl '…/context?deferThinking=1&deferMedia=1&tail=50'
{"context":{"messages":[],"entryIds":[],"oldestEntryId":"b0577cf8","hasMore":true,"turnsBefore":67,…}}

$ curl '…/context?tail=1'      # 同样是 0 条
$ curl '…/outline'             # 同一会话报告 68 轮
```

该文件尾部有 **386 条连续 custom 记录**（`shadow-mind-event` 290 + `plan-mode-state` 96），而 `tail` 的原始记录上限是 `rawWindowCap(50) = max(200, 50*6) = 300`。

**机制**（两处同源截断，必须一起改）：`sliceActiveBranch`（[lib/session-reader.ts:880-925](file:///Volumes/syy2t/project/pi-web/lib/session-reader.ts#L880-L925)，运行中 wrapper 走这条）从叶子往上走，只有 `user` / `assistant` / `compaction` 计入 `tail`，但循环在 `chain.length >= rawWindowCap` 时也会停；离线会话走 `readIndexedContextPage`（[lib/session-content-index.ts:399-410](file:///Volumes/syy2t/project/pi-web/lib/session-content-index.ts#L399-L410)），里面有一份一模一样的 `rawLimit = Math.max(200, tail * 6)`。只改一处，另一条路径仍然空白。尾部 300 条全是 custom，于是「可见消息 0 条、hasMore 仍为 true」。

**修法**：把两处的原始记录上限统一成「软上限 + 硬上限 + 字节预算」，由 `lib/session-page-budget.ts` 一处实现：软上限到点时页里已有消息就收尾；一条都没有（尾部是连续的过程记录）就继续向前，直到硬上限（或索引路径的字节预算），越过软上限后凑够最少可见条数即停。客户端在首屏仍为 0 条时最多自动补 3 页（`FIRST_PAGE_BACKFILL_LIMIT`），再没有内容就保留「加载更早消息」入口。要点：

- 保留现有语义：`before` 分页不重复边界记录（`excludeLeaf`）。
- 不要只调大 `rawWindowCap`：长 custom 串没有上界，调多大都可能再次触发。
- 单页返回的字节上限要有，否则一次拉进整段工具输出会拖慢首屏。

**验证**：`context?tail=50` 对该会话应返回非空 `messages`（约 50 条可见消息）；再对 1833 条那个会话跑一遍 `npm test -- session-reader`（`lib/session-reader.test.mjs` 里补一条「尾部大量 custom 记录仍能凑满 tail」的用例）。

**风险**：分页边界的 `oldestEntryId` 计算必须与 `hasMore` 一致，否则会出现「加载更早消息」点不动或重复前插（`useAgentSession` 有重复 entryId 的拒绝逻辑，会直接报错）。

---

### P0-2 排队启动的扩展命令挡住自己的取消指令

**现象**：用「后续」排队的扩展命令（如 `/review`）启动后，`/review cancel` 和新消息都要等命令跑完；`Stop` 提示无法中止（这部分是设计如此）。

**机制**（[lib/rpc-manager.ts:1434-1500](file:///Volumes/syy2t/project/pi-web/lib/rpc-manager.ts#L1434-L1500)）

- 排队投递 `deliverParkedPrompt` 先 `acquirePromptAdmission()`，释放只发生在 `preflightResult` 回调或 `await inner.prompt(...)` 之后——而 pi 对扩展命令要等 handler 返回才回调。于是整段命令运行期间都占着 `promptAdmissionTail`。
- 直接提交路径（[`:2303`](file:///Volumes/syy2t/project/pi-web/lib/rpc-manager.ts#L2303)）特意在 dispatch 后立刻 `acceptPreflight()`，并在 `finally`（`:2357`）释放；注释写明了原因。

**修法**：`deliverParkedPrompt` 复用直接路径的策略——`inner.prompt()` 返回后若判定是扩展命令派发（`deliveredCommand` 非空），立即 `release()`；`preflightResult` 里的 `release()` 保持幂等（已有 `released` 标志）。同时保证：

- 提前释放后，`disposition` 仍要在回调到达时记录，用于决定是否发 `prompt_done`。
- `entry.settle()` 的时机不变（仍等命令返回）。

**验证**：`lib/rpc-manager-command-queue.integration.test.mjs` 加用例——「排队启动的 `/slow` 运行期间，`/slow cancel` 能在 1 个 tick 内被派发」。

**风险**：admission 提前释放意味着命令运行期间可以有新的 prompt 进入 SDK，这与直接提交路径的行为一致，不是新语义。

---

### P0-3 大纲标题编号与正文标记不一致

**现象**：在大纲里点某轮的标题，跳到正文里另一个标题（或点不到）。

**证据（实测）**

```
$ node --experimental-strip-types  # 直接跑 lib/outline-headings.ts
extractOutlineHeadings("- 第一点\n  # 列表里的标题\n- 第二点\n\n## 顶层标题")
→ [ {level:1, text:'列表里的标题'}, {level:2, text:'顶层标题'} ]
```

正文侧（[lib/markdown.ts:719-732](file:///Volumes/syy2t/project/pi-web/lib/markdown.ts#L719-L732) 的 `remarkAnswerHeadingMarkers`）只给 **AST 顶层** h1/h2 打 `data-answer-heading`，列表项里的那个标题不认领 → 大纲多一条 → 后续编号整体后移一位。

两类错位都要修：

1. **预览把拼接后的整篇解析，正文逐块解析。** 第二块以两格缩进的标题开头时，拼进第一块的列表会成为嵌套节点，预览少一条、编号前移（实测：拼接后顶层标题只剩 `["标题乙"]`，逐块是 `["标题甲","标题乙"]`）。这是「跳错标题」的直接原因。
2. **行扫描器把列表项里的标题也算成大纲标题**，而正文只标顶层，编号同样错位（`extractOutlineHeadings("- 第一点\n  # 列表里的标题\n- 第二点\n\n## 顶层标题")` 返回两条）。

review A 描述的具体形状（「列表把第一个标题吞了」）用它给的输入复现不出来——`joinAnswerBlocks` 用空行拼接，列表吞不掉后面的顶格标题；上面第 1 条才是真实机制。

**修法**：让两侧共用同一套判定。推荐在服务端/前端都改为「按块解析出顶层标题」：用 `remark` 解析每个文本块，取顶层 h1/h2（与渲染侧完全相同的规则），再拼接编号。若不想引入解析依赖，退化方案是给行扫描器加最小块结构状态机（列表/引用/缩进代码内的 `#` 不算标题），但两边必须共用同一实现。

**验证**：新增用例——「列表项里的标题不进大纲」「引用块里的标题不进大纲」「两块文本各带标题时编号与 DOM 顺序一致」。前端可加一条渲染 + 断言 `[data-answer-heading]` 数量的测试。

**风险**：服务端 `/outline` 与前端 `ChatMinimap` 都用到 `extractOutlineHeadings`，改口径会影响两处输出（这正是目标），需要同时验证回收站预览（`TrashSessionDetail`）复用的路径。

## 3. P1：真 bug，改动小

### P1-1 大纲搜索框聚焦后浮层关不掉
[ChatMinimap.tsx:730-739](file:///Volumes/syy2t/project/pi-web/components/ChatMinimap.tsx#L730-L739) 的 `schedulePreviewHide` 在 `searchFocusedRef.current` 为真时直接返回；输入框 `onBlur`（[`:871`](file:///Volumes/syy2t/project/pi-web/components/ChatMinimap.tsx#L871)）只把标志置 false，不触发隐藏。结果：聚焦搜索 → 鼠标移出 → 点击别处失焦后浮层常驻。
**修法**：`onBlur` 置 false 后，若当前不再 hover 于胶囊/浮层，则 `setMinimapHovered(false)`（需要一个 hover 状态 ref 或在 blur 里直接调度一次 `schedulePreviewHide`）。

### P1-2 暂存库编辑保存后仍显示「失败」
[message-stash.ts:109](file:///Volumes/syy2t/project/pi-web/lib/message-stash.ts#L109) 用 `{ ...item, … }` 生成新条目，`failed: true` 被继承；`view()` 优先按 `item.failed` 投影状态。而 `changeStashedMessage` 的 recover 分支（`:129`）会清 `failed`，保存路径没清。
**修法**：保存时显式写入 `failed: false`。

### P1-3 `ChatWindow` 卸载读挂载时的 `session?.id`
[ChatWindow.tsx:580-603](file:///Volumes/syy2t/project/pi-web/components/ChatWindow.tsx#L580-L603) 的 `useLayoutEffect(..., [])` 清理函数闭包锁死挂载时的 `session`。`sessionKey` 是导航计数器（`hooks/useSessionNavigation.ts:37`），**pending 新会话变成正式会话时不会自增**，所以该会话切走时 `session?.id` 仍是 `undefined`，阅读位置不保存。
**修法**：把 `sessionId` / `onScrollPositionChange` 放进 ref，清理函数从 ref 读。

### P1-4 / P1-5 / P1-6 三处漏依赖（eslint 已报）

```
components/ChatInput.tsx:1517   missing: extensionUiOpen
hooks/useAgentSession.ts:3951   missing: allModelList, loadAllModels, modelSelectionState.isScoped, startSideChat
hooks/useAgentSession.ts:3462   missing: handleCompact, opts.chatInputRef, sessionStats, translate
```

**注意**：P1-5 不能无脑补依赖。该 useMemo 的注释写明目的是「流式期间保持返回对象引用不变，让下游 memo 命中」。补 `allModelList` 后，`loadAllModels` 完成时 memo 会失效一次（可接受，本来就要更新）；但若把 `startSideChat` 这类回调也补进去，需要确认其身份不会每次渲染都变，否则 memo 形同虚设。
**修法**：先确认 `startSideChat`/`loadAllModels` 的 `useCallback` 依赖是否稳定；稳定则补进去，不稳定则改用 ref 暴露最新实现 + 稳定包装。补完后跑一次流式场景下的渲染计数测试（`components/ChatWindow.performance.test.mjs` 有现成手段）。

### P1-7 细节清理
- [MarkdownBody.tsx:161-172](file:///Volumes/syy2t/project/pi-web/components/MarkdownBody.tsx#L161-L172)：`code` 渲染器没像同文件 `ol`（`:179`）、`div`（`:249`）那样解构 `node`，`{...props}` 会把 `node` 塞进 `<code>`。
- [tool-settings.ts:158-167](file:///Volumes/syy2t/project/pi-web/lib/tool-settings.ts#L158-L167)：第二个 `if` 的条件是第一个的子集，永远走不到。

## 4. P2：性能（按实测收益排序）

### P2-1 minimap 每次测量重拼全部回答 Markdown
**实测**：`cachedHasOutlineHeadings` 以正文为键、上限 200；201 条回答连测两轮 **命中 0 次 / 未命中 402 次**。更贵的是上游——[ChatMinimap.tsx:521](file:///Volumes/syy2t/project/pi-web/components/ChatMinimap.tsx#L521) 在每次 `measureNodes` 里对每条已加载回答调用 `getAssistantAnswerMarkdown`（内部 `joinAnswerBlocks` 逐块 split + 正则），测量在挂载、滚动、尺寸变化时都会跑（100ms 节流）。
**修法**：按消息对象缓存提取结果（`WeakMap<AgentMessage, {markdown, headings}>`），测量只读缓存；「文本/标题提取」与「DOM 几何测量」拆开，高度微变时复用文本结果。坐标未变时复用旧 `allNodes` 引用，避免不必要的重渲染。

### P2-2 切会话整树重挂载 + 多次提交
**实测**（用户 dev 标签页）：766 条消息的会话 `/context` 863ms / 181KB，首次 DOM 变更 961ms，最后一次 1657ms，**13 次提交 / 57 处变更**；113 条消息的会话 7 次 / 379→1098ms；页面内置打点记录的一次切换为 `click→request 34ms`、`request→data 639ms`；空闲 8 秒 0 次变更（说明不是常驻轮询）。
**修法**：把消息列表抽成只依赖 `messages / entryIds / renderWindow / turnAnchors` 的 memo 子组件；`details`、`state`、滚动定位的更新不再触达消息树。可选：把 `loadSession` 里的 `setChat` 系列状态合并为一次 `useReducer` 提交。
**验证**：同一测量脚本复跑，目标是把单次切换的提交次数压到 ≤4 次、跨度 < 800ms。

### P2-3 折叠的过程详情仍提前构造 JSX
[ChatWindow.tsx:1429-1442](file:///Volumes/syy2t/project/pi-web/components/ChatWindow.tsx#L1429-L1442) 在折叠态也跑 `renderMessage(...)` 填 `processViews`，`:1529` 只是把数组包进 `renderChildren`。20 轮 × 20 步时会白白构造几百个元素与闭包。
**修法**：外层只收集轻量索引，`renderMessage` 移到 `renderChildren` 回调内部。

### P2-4 两处无界缓存
- 服务端 [session-content-index.ts:61-64](file:///Volumes/syy2t/project/pi-web/lib/session-content-index.ts#L61-L64)：`__piSessionContentIndexes` 无淘汰，每个浏览过的会话的 `records` + `tree` 永久驻留（已落盘，加 LRU 64~128 几乎零代价）。
- 前端 [MessageView.tsx:69](file:///Volumes/syy2t/project/pi-web/components/MessageView.tsx#L69)：`deferredContentCache` 无上限（同文件 `thinkingContentCache` 有 100 条 LRU）。

### P2-5 会话搜索逐行 `JSON.parse`
[session-search.ts:110](file:///Volumes/syy2t/project/pi-web/lib/session-search.ts#L110)：除 side-chat 边界前与超长行外，每行都完整 parse 才判断角色。3 秒预算大部分花在大块工具输出上，导致会话被截断漏搜。
**修法**：parse 前先做原始字符串粗筛（是否含 `"role":"user"` / `"role":"assistant"`，以及是否可能命中关键词），只对候选行 parse。

### P2-6 日志截断用 `Array.shift()`
[background-commands.ts:143](file:///Volumes/syy2t/project/pi-web/lib/background-commands.ts#L143)、[dev-server-manager.ts:65](file:///Volumes/syy2t/project/pi-web/lib/dev-server-manager.ts#L65)：256KB 满后每次追加都 `shift()`（O(N) 搬移）。高频刷屏日志下会吃主线程。
**修法**：`head` 下标 + 死区过半时一次性 `slice`，或环形缓冲。

### P2-7 底栏三个轮询：引用稳定 + 回前台去重
`useDevServers` / `useScheduledTasks` / `useBackgroundCommands` 每 4/5/6 秒 `setData(next)`，每次都是新对象 → 底栏无条件重渲染；`visibilitychange` 与定时器会各发一次请求。**注意**：这三个 hook 在隐藏时已经不发请求（tick 里有 `visibilityState === "visible"` 判断），所以「后台仍轮询」的说法不成立，只修引用稳定与双请求。

### P2-8 `/state` 携带整份 `systemPrompt`
实测：普通会话 33.8KB（其中 systemPrompt 31.9KB），重会话 169.9KB（其中 167.2KB）。它只在顶栏「系统」面板里展示，却跟着每次切换、以及运行中每 15 秒的 `reconcileAgentState` 一起传输。
**修法**：`get_state` 不再内联 `systemPrompt`，改由 `loadSystemPrompt` 单独请求（该入口已存在）。
**风险**：扩展通过 `before_agent_start` 改写的 prompt 只在 `get_state` 里可见，拆开后要保证单独接口返回同一份。

## 5. P3：加固

- **P3-1 环检测**：`lib/session-outline.ts:160`、`lib/session-content-index.ts:414`、`:480` 的 `while (cursor)` 加 `visited` 集合。`sliceActiveBranch` 已有 `rawCap` 兜底，不在此列。
- **P3-2 `check_in_seconds` 上限**：`lib/background-commands.ts:327-332` 只校验 `>= 60`；超过 2147483 秒时 `setInterval` 会被 Node 压成 **1ms**（实测：`TimeoutOverflowWarning … Timeout duration was set to 1`），tooltip 里的「12 次上限」会瞬间烧完并连写 12 次盘。加 `<= 86400`。
- **P3-3 `/context` 的 304 前置判断**：live wrapper 走 `readSessionBrowseSnapshot` 时在比对 ETag 前就 `projectSessionTree(getTree())`。可先读版本判断 304 再建树。**`/outline` 那半不做**：客户端不给它发 `If-None-Match`（全仓只有 `lib/session-load-client.ts:214` 会发），是死路径。
- **P3-4 大纲跳转的守卫**：`jumpToUnloadedTurn`（[ChatMinimap.tsx:680-706](file:///Volumes/syy2t/project/pi-web/components/ChatMinimap.tsx#L680-L706)）在 `await onLoadUntilEntry` 之后没有校验目标仍然有效。跨会话不受影响（ChatWindow 按 `sessionKey` 重挂载），真正存在的是**同会话内切分支**：旧分支的加载结果会 `onRevealHistory` 到新分支的窗口。修法：比较 `turn.entryId` 与当前 `sessionId + leafId` 快照，失配直接丢弃。

## 6. 执行批次

| 批次 | 内容 | 依赖/说明 |
|---|---|---|
| 1 | P0-1、P0-2、P0-3 | 各自独立；P0-1 有现成的 22MB 会话可验收 |
| 2 | P1-1 … P1-7 | 全是小改动，适合一次性清掉 eslint 里这几条 warning |
| 3 | P2-1、P2-2、P2-3 | 都和「右侧渲染」相关，可一起量测对比 |
| 4 | P2-4 … P2-8、P3-* | 收益递减，按需 |

批次 1 完成后必须复跑：`node_modules/.bin/tsc --noEmit`、`npm run lint`、相关 `*.test.mjs`（`session-reader`、`rpc-manager-command-queue.integration`、`session-outline`）。

## 7. 已被否定的说法（不要再跟进）

| 说法 | 结论 |
|---|---|
| 「`/outline` 冷启动要为 22MB 建索引，实测 17.4 秒」 | **证伪**。同数据同路径复测：建索引 0.506s（`/context` 触发）、`/outline` 0.029s（`Server-Timing: read;dur=13.3`）、二次 0.008s；脚本复刻整份文件逐行 parse 仅 307ms。那个 17.4s 是一次性冷启动/首次路由编译，不是稳定成本。因此**不做**「大纲索引后台预热」。 |
| 「`/outline` 304 仍生成整份大纲」 | 机制属实，但客户端从不发 `If-None-Match`，是死路径。 |
| 「底栏三 hook 在后台标签页仍每 4~6s 发请求」 | **不成立**。tick 里有 `visibilityState === "visible"` 判断，隐藏时不发请求；只有定时器还在重排。 |
| 「漏依赖导致用户看不到新拉出的模型」 | **推不出**。`loadAllModels` 同时调用 `mergeCatalog`，而它改的 `modelNames`/思考等级映射本来就在依赖里。真实隐患只是回调闭包过期。 |
| 「大纲拼接后列表吞掉第一个标题」 | **不成立**。`joinAnswerBlocks` 用空行拼接，实测仍得到两个标题；真实问题是「扫全文」vs「只标顶层」。 |
| 「跨会话跳转会清掉新会话的加载态」 | **不成立**。ChatWindow 按 `sessionKey` 重挂载，旧组件上的 setState 落在已卸载组件。只有同会话内切分支才会。 |
| 「排队条件 `runningCommands.length === 0` 直接删掉」 | 暂不删。先修 P0-2，再把它收敛成「本轮会结束（`isStreaming`）就排队」，避免出现「parked 命令等不到 flush」的停摆。 |

## 8. 第一批实施记录（已完成）

### 改动

| 编号 | 改动 | 文件 |
|---|---|---|
| P0-1 | 新增页预算模块：软上限 + 硬上限 + 字节预算 + 越过软上限后的最小可见条数，两条读取路径共用 | `lib/session-page-budget.ts`（新增）、`lib/session-reader.ts`、`lib/session-content-index.ts` |
| P0-1 | 首屏 0 条消息且 `hasMore` 时最多自动补 3 页，失败/重复则停在当前页 | `hooks/useAgentSession.ts`（`FIRST_PAGE_BACKFILL_LIMIT`） |
| P0-2 | 排队投递改为「先发起 prompt，命令派发即释放 admission，再 await」 | `lib/rpc-manager.ts`（`deliverParkedPrompt`） |
| P0-2 | 「后续」不再因为已有命令在跑就插队执行：只要本轮还在跑就排队 | `lib/rpc-manager.ts`（`prompt` case） |
| P0-3 | 预览按文本块渲染，标题编号每块从 0 开始；点击用「块下标 + 块内下标」定位 | `components/ChatMinimap.tsx`（`AssistantOutline`、`scrollToHeading`） |
| P0-3 | 正文每个回答文本块的根节点带 `data-answer-block` | `components/MarkdownBody.tsx`、`components/MessageView.tsx` |
| P0-3 | 行扫描器按列表缩进只认顶层标题 | `lib/outline-headings.ts` |

### 验收

- **P0-1（改前 → 改后）**：22MB 会话 `01a15768…` 的 `/context?tail=50` 从 `messages: 0`（`hasMore: true`）变为 15 条；`before=<oldest>` 的下一页 97 条，与首页 `entryIds` 无重叠。
- **P0-2**：新增两条集成用例，并确认**去掉修复后各自失败**：
  - `a delivered parked command releases prompt admission while it runs`（去掉 `if (deliveredCommand) release();` 后失败）
  - `a follow-up command waits for the turn even while another command runs`（把 `runningCommands.length === 0` 加回去后失败）
- **P0-3**：新增用例覆盖「第二块以缩进标题开头时预览仍列出两个标题」「列表项/有序列表/嵌套列表里的标题不算大纲标题」「没有列表时两三格缩进的顶层标题照常识别」。
- **静态检查**：`tsc --noEmit` 通过；改动文件 `eslint` 0 error（14 条 warning 均为既存项，对应方案里的 P1 批次）。

### 复查修正（同日）

| 问题 | 修正 |
|---|---|
| 首屏补页的循环实际不会执行：`viewSnapshotRef.current.page` 要等下一次渲染才同步，循环里读它必然是旧的空页，`page.sid !== sid` 直接 break | 循环收进 `lib/first-page-backfill.ts` 的 `backfillFirstPage()`，游标取自首屏快照、`loadedCount` / `loadedEntryIds` 直接读 ref，不再读 `viewSnapshotRef` |
| 补页提交用旧页快照覆盖元数据：`{ ...loaded.snapshot }` 会把会话尾部的 model / thinkingLevel 改回「从 `before` 往上算」的旧值；`preserveScroll: true` 让首屏不再滚到最新 | 新增 `mergeOlderPage()`：元数据沿用首屏那页，只取旧页的 messages / entryIds / oldestEntryId / hasMore / turnsBefore；滚动选项沿用本次加载的 `options` |
| 服务端 `/outline` 仍把文本块拼起来扫标题，和前端逐块口径不一致（后一块的缩进标题会被前一块的列表吞掉） | `lib/session-outline.ts` 抽出 `extractFinalAssistantBlocks()`，标题改为逐块 `extractOutlineHeadings()` 后按 `MAX_HEADINGS_PER_TURN` 截断；拼接结果只用于摘要 |

新增测试：
- `lib/first-page-backfill.test.mjs`（7 条）：首屏有内容不补页、空页按游标连续补、重复页拒绝、上限、提交失败即停、无更早页不发请求、合并保留首屏元数据。
- `lib/session-outline.test.mjs`：两块文本（列表 + 缩进标题）时服务端大纲必须给出两个标题（改回拼接即失败）。
- `hooks/useAgentSession.test.mjs`：断言补页读同步值、不读 `viewSnapshotRef.current.page`、元数据来自首屏、滚动沿用 `options`。

### 复查修正（第二批）

| 问题 | 修正 |
|---|---|
| 首屏补页的判定仍可能读到客户端状态：`loadedCount()` / `loadedEntryIds()` 读 ref，同一个异步续体里它可能还是上一帧、甚至上一个会话的值，一读就误判「已经有消息」 | `backfillFirstPage()` 只看服务端响应：`first` 换成「实际提交进界面的那一份」（恢复的更大窗口由 `committedSnapshot` 捕获），消息数与 entryId 都从 `first` 和每页响应累计，接口里不再有客户端状态；每翻一页还要求游标真的前进（`next !== before`），否则停 |
| 大纲漏标题：`- - -` 分隔线被行扫描器当成列表项，后面两格缩进的 `## 标题` 变成「列表里的嵌套标题」，正文渲染了标题却没有展开入口 | `lib/outline-headings.ts` 新增 `THEMATIC_BREAK`（CommonMark：分隔线优先于列表项），分隔线不再开列表，但仍按缩进结束更深的列表；列表项**内部**的分隔线不结束该项 |
| 服务端 `/outline` 与前端口径要复用同一份逐块结果 | 新增 `outlineHeadingsFromBlocks(blocks, limit)`；`lib/session-outline.ts` 与大纲预览（逐块 ReactMarkdown，只保留顶层标题）都用逐块顶层标题，拼接只留给搜索与摘要 |

新增/更新测试：
- `lib/session-outline.test.mjs`：「分隔线 `- - -` 不是列表」覆盖同一块与跨块、`***`/`___` 变体、列表内部分隔线仍算嵌套；「逐块解析的顶层标题与服务端大纲、正文一致」断言 `outlineHeadingsFromBlocks` 与拼接扫法的差异，以及服务端 `buildSessionOutlineFromEntries` 用同一份结果。
- `lib/first-page-backfill.test.mjs`：改为响应驱动接口，补「游标没前进立即停」「没有游标也停」。
- `hooks/useAgentSession.test.mjs`：断言补页不读 `loadedCount`/`loadedEntryIds`/`messagesRef`/`viewSnapshotRef`，首屏取 `committedSnapshot ?? contextResult.value.snapshot`。

实测（dev 30141，临时 fixture 测完删除）：
- 2,050 条连续隐藏记录：服务端首屏 `messages: 0 / hasMore: true`，浏览器打开后自动补页一次（`before=<首屏游标>&tail=50`）即拿到第三页的两条消息，正文正常渲染。
- `- - -` + 两格缩进 `## 标题`：`/outline` 返回 `['分隔线后的标题', '第二个标题']`，正文 DOM 的两个 `[data-answer-heading]` 文本一致（remark 解析结果同样是两个顶层标题）。

## 9. 批次 2~4 实施记录

### 批次 2（P1）

| 项 | 改动 | 测试 |
|---|---|---|
| P1-1 大纲浮层失焦收不起来 | `ChatMinimap` 增加 `hoveringRef`：搜索框 `onBlur` 置位后，指针已离开就调度一次收起；定时器到点再确认一次指针不在浮层里 | `ChatMinimap.test.mjs`「搜索框失焦后浮层能收起」 |
| P1-1 追加：锁定后浮层打不开 | 锁定仍表示「悬停不展开」（#1128 的语义），另留显式入口：点胶囊把浮层钉住/放开（`previewPinned`），展开状态 = `minimapHovered \|\| previewPinned`；上锁/解锁都清掉两种状态 | 同上「锁定浮层后仍能展开」；浏览器实测：上锁→点胶囊展开→再点收起→解锁 |
| P1-2 暂存库保存仍显示失败 | `saveStashedMessage` 显式写 `failed: false` | `message-stash.test.mjs`「失败的暂存编辑保存后重新排队」 |
| P1-3 卸载读挂载时的 session id | 卸载 effect 改读 `sessionIdRef`（hook 里那份，跟着创建更新）与 `onScrollPositionChangeRef` | tsc/eslint |
| P1-4/5/6 漏依赖 | `ChatInput` 键盘处理补 `extensionUiOpen`；`executeBash` 的 `ensureEventsConnected` 改 ref（避免整条依赖链换代）；命令分发器补 `handleCompact`/`opts.chatInputRef`/`translate`，`sessionStats` 走 ref；返回值 `useMemo` 补 `allModelList`/`loadAllModels`/`modelSelectionState.isScoped`/`startSideChat`（都是稳定引用）；顺带清掉 `ChatWindow` 的 3 条（`t` 多余、`unlockAudio` 缺失、卸载 effect 的 ref 依赖） | eslint 这几处已清零 |
| P1-7 细节清理 | `MarkdownBody` 的 `code` 渲染器 `delete props.node`；`tool-settings.ts` 删掉永远走不到的第二个 `if` | tsc/eslint |

### 批次 3（P2）

| 项 | 改动 | 测试 / 实测 |
|---|---|---|
| P2-1 minimap 每次测量重拼回答 | `cachedAssistantAnswer()`：按消息对象 WeakMap 缓存 `getAssistantAnswer()`，`blocks` 引用稳定后 `AssistantOutline` 的 memo 也能命中；`measureNodes` 结果等价时不再 `setAllNodes`（`sameTurnNodes`） | `ChatMinimap.test.mjs`「每次测量复用同一条回答的提取结果」 |
| P2-2 拆消息子树 | **复测后不拆**：dev 上 113 条消息的会话，切换全程 `click→request 20ms`、`request→data 342ms`、`data→paint 75ms`，settle 期只有每秒一次的工具时钟 DOM 变更、无长任务。原 961→1657ms / 13 次提交是**分页之前**的数字，现在每页只挂 ~50 条可见消息，客户端绘制已降到 75ms 量级，把 2000 行的渲染闭包拆成带 ~30 个 props 的 memo 组件风险大于收益 | 计划中的 `< 800ms` 目标已满足 |
| P2-3 折叠过程详情仍造 JSX | 循环改成收集 `ProcessDescriptor`（轻量描述），`renderProcessViews()` 只在 `ProcessDetailsGroup` 展开/露出时调用 | 新增 `ProcessDetailsGroup.test.mjs`（折叠时回调不执行）+ `ChatWindow.performance.test.mjs` 断言 |
| P2-4 两处无界缓存 | `session-content-index` 加 `rememberIndex()`（LRU 128，索引已落盘）；`MessageView` 的 `deferredContentCache` 加 100 条上限 | `session-content-index.test.mjs`「按 LRU 保留有上限」 |
| P2-5 搜索逐行 parse | 解析前两道粗筛：`"role":"user\|assistant"` 结构筛；术语全部「原始行安全」时按「一个词都没出现」排除（带 `\u` 转义的行照旧解析，粗筛只在侧聊边界之后生效） | `session-search.test.mjs`「粗筛不误伤」「大块工具输出不参与匹配」 |
| P2-6 日志 shift | 新增 `lib/bounded-log.ts` 的 `trimLogPrefix()`：超限一次裁到 75% 水位，两边共用 | `bounded-log.test.mjs`（3 条） |
| P2-7 底栏轮询 | 三个 hook 改用 `hooks/usePolledJson.ts`：内容不变时保留旧引用、`visibilitychange` 与定时器共用一次 in-flight、旧响应不覆盖新状态、间隔可随状态快慢而不重启轮询 | `hooks/usePolledJson.test.mjs`（2 条） |
| P2-8 `/state` 带整份 systemPrompt | `get_state` 默认不返回，只有 `includeSystemPrompt: true`（系统面板的 `loadSystemPrompt`）才带上；`/api/sessions/[id]/state` 与 `?systemPrompt=0` 走同一口径 | 实测 `/api/agent/[id]` full 31,021B vs slim 1,027B（提示词 29,033 字符）；`rpc-manager-shutdown.test.mjs` 补「默认不带」 |

### 批次 4（P3）

| 项 | 改动 |
|---|---|
| P3-1 环检测 | `session-outline.ts`、`session-content-index.ts`（分页与大纲两处祖先遍历）加 `visited` 集合；`session-outline.test.mjs` 补「父链成环时大纲不会卡死」（去掉守卫即超时） |
| P3-2 `check_in_seconds` 上限 | 新增 `MAX_CHECK_IN_SECONDS = 86400`，工具描述同步；`background-commands.test.mjs` 补 3e9 / 86401 拒绝 |
| P3-3 `/context` 304 前置 | 新增 `liveSessionBrowseVersion()`：存活会话先只读版本比对 `If-None-Match`，命中 304 就不再 `projectSessionTree`；`context-route.test.mjs` 断言顺序，带 `before` 的分页不参与 304 |
| P3-4 大纲跳转守卫 | `jumpToUnloadedTurn` 在 `await onLoadUntilEntry` 之后用 `jumpTargetRef` 复核目标仍是当前目标，否则丢弃（不再 `onRevealHistory` 到新分支）；切换会话/分支时一并清掉 `pendingNavigationRef`；`finally` 不再清掉新一次跳转的加载态 |

## 10. 边界复测修正（merge.15 之后）

| 问题 | 根因 | 修法 | 验证 |
|---|---|---|---|
| 补页期间会话文件被重写，聊天停在空白页 | 补页是两次独立请求，合并时只按「元数据取首屏、消息取旧页」拼，没核对两页是否同一视图；旧页的 `hasMore: false` 会把「加载更早消息」入口一起关掉 | `lib/first-page-backfill.ts` 加 `sameSessionView()`（版本 + 分支末端）；`loadSession` 在 `readOlder` 里发现不一致就标记 `viewChanged`、丢弃该页，并**重读一次首屏**（`options.reloadedAfterRewrite` 防止无限重读） | `first-page-backfill.test.mjs`「补页的页必须和首屏属于同一个会话视图」+ `useAgentSession.test.mjs` 源形态断言 |
| 列表项里的未闭合围栏让大纲漏标题 | 行扫描器只在遇到结束标记时关闭围栏；remark 在列表项结束（缩进退回容器外）时就会收尾，后面的 `##` 在正文里是标题 | `scanOutlineLines` 给围栏记下 `containerIndent`：缩进退回容器之外即视为围栏结束，该行继续按正文扫描；开围栏前先按缩进关掉更深的列表 | `session-outline.test.mjs`「列表项里的围栏随容器结束而结束」5 个用例；另用 remark 逐例对照（含两个「该隐藏」的反例） |
| 底栏轮询换项目后旧结果覆盖新数据 | `usePolledJson` 只用请求序号挡同一接口的乱序；操作收尾时调用的 `refresh` 属于旧 URL，序号反而更大 | 增加 `urlRef`：`refresh` 发现当前 URL 已变就直接返回（不发请求），提交与错误写入再核对请求序号 + URL；两个任务 hook 的 `actionError`、开发服务 hook 的 `setError` 按 `cwd` 判断 | `hooks/usePolledJson.test.mjs` 用真 React + JSDOM 复现「A 的删除未完成 → 切到 B → A 完成」；去掉守卫即失败（`旧项目的刷新不该再发请求`） |

## 11. 第三轮复核修正

| 问题 | 根因 | 修法 |
|---|---|---|
| `app/api/sessions/[id]/state/route.test.mjs` 变红（但全量一直是绿的） | ① 断言写死 `getRpcSessionSnapshot(id)`，agent 路由为了 `?systemPrompt=0` 多了 options 参数；② **测试入口的 glob**：`node --test 'app/.../[id]/...'` 把 `[id]` 当字符集，一个用例都不匹配，退出码仍是 0，整份文件被静默跳过（实测输出 `tests 0`） | 断言放宽到 `\(id\b` 并补「状态读取不带提示词」两条；`scripts/run-tests.mjs` 把路径里的 glob 元字符转义成 `[[]` / `[]]` 再交给 `--test`，三份带方括号的测试文件由此真正跑起来（又暴露出两处同样陈旧的断言：`openSessionManager` 导入清单、`accepted: true, mode` 后新增的 `queued` 回执） |
| `parentId` 环检测漏了两处同链路遍历 | 上一轮只给每处第一条 `while` 加了 `visited` | `readIndexedContextPage` 的 `settingsCursor` 循环、`lib/session-turns.ts` 的 `countTurnsBefore` 都补 `visited`；新增 `lib/session-turns.test.mjs`（轮次计数 + 成环不卡死，去掉守卫即失败） |
| 旧大纲跳转收尾误清新跳转的待定位目标 | 早退分支无条件 `pendingNavigationRef.current = null` | 只在 `pendingNavigationRef.current?.entryId === turn.entryId` 时清空 |
| 补页合并只从首屏重拼 | 连补多页时每次都用 `firstSnapshot`，中间页的记录不会留在视图里（当前条件下可见结果等价，但条件一放宽就会丢） | 改为在 `latestSnapshot` 上累加，提交成功后再更新它 |

## 12. 第四轮复核修正（0.17.0-merge.19）

| 问题 | 根因 | 修法 |
|---|---|---|
| 刷新路径遇到文件重写会停在旧首屏 | 重写重试复用了 `options`：首屏请求的 `skipCache` 只跟 `validateView` 走，刷新路径它是 false，于是命中本地缓存（版本没变时会走 304），拿回旧页和旧游标；补页再撞一次视图变化就被「只重试一次」挡住 | 重试前 `invalidateSessionContext(sid)` 丢掉过期缓存，首屏请求改为 `skipCache: options.validateView \|\| options.reloadedAfterRewrite`，强制服务端按版本复验；重试本身仍走完整加载（提交首屏 + 补页） |
| 大纲仍漏标题 / 多标题 | 行扫描器只能逼近 CommonMark。实测 16 个形状只对上 7 个：反引号围栏的 info string 含反引号（那根本不是围栏）、HTML 块（div/script/注释/CDATA/自定义标签，6 种）、frontmatter、`$$` 数学块 | 大纲标题改为**用正文那条 remark 解析**：`extractOutlineHeadings()` 用 `remark-parse + remark-frontmatter + remark-gfm + remark-math`（即 `markdownRemarkPlugins` 里会改变块结构的那一半）取根节点 h1/h2；`hasOutlineHeadings()` 先用「有没有 `#`/Setext 下划线」的字符粗筛省掉 AST。对照脚本 16/16 一致。新增运行时依赖 `unified`、`remark-parse`，并把 `remark-gfm`/`remark-math` 从 devDependencies 提为 dependencies（正文解析要用它们）。`session-outline.test.mjs` 增加按 `markdownRemarkPlugins` 复算的对照用例，正文插件表一变就会红 |
| 旧项目的操作成功会抹掉新项目的失败提示 | 失败分支按 `cwdRef` 判断了，成功分支无条件 `setActionError(null)` | `useScheduledTasks`、`useBackgroundCommands` 的成功分支同样只在 `cwdRef.current === cwd` 时清提示；`useDevServers` 的 `setError(null)` 同理。新增 `hooks/useScheduledTasks.test.mjs`：真 React + JSDOM 复现「A 未完成 → 切 B → B 失败 → A 成功」，去掉守卫即失败 |

验证：全量 570 文件 / 4128 通过 / 0 失败 / 77 跳过；`tsc --noEmit` 通过；`eslint .` 0 error（40 条既存 warning）。

## 13. 移动端大纲入口（0.17.0-merge.20）

移动端此前完全没有大纲：`ChatWindow` 在 `isMobile` 时直接不渲染 `ChatMinimap`（阈值 `max-width: 640px`），所以手机上读长回答翻不回去。

- **入口**：顶栏移动端主操作组里新增一个图标按钮，位置固定在「更多」之前，`aria-pressed` 反映开关；只在有消息的会话出现（新会话点了也没内容）。
- **形态**：不复制一套实现。`ChatMinimap` 增加 `variant="sheet"`，同一份浮层（搜索、轮次列表、展开预览、标题跳转）摊成底部抽屉：`.rail[data-sheet]` 铺满视口当背景，`.preview` 改成贴底的圆角卡片，胶囊轨道在抽屉里隐藏；点背景或头部 ✕ 关闭。
- **收起时机**：不能挂在 `onNavigate` 上。未加载轮次要先分页、未挂载的节点要等 `measureNodes` 补测，抽屉提前卸载会把 `pendingNavigationRef` 一起带走，跳转就落空。改成大纲自己在跳转**完成**时调用 `finishNavigation()`（同步滚动后、或待定位目标被消费后）。
- **状态**：`AppShell` 按会话 id 记（`mobileOutlineSessionId`），切会话自动关闭，与观察面板同一套做法。

验证：`tsc --noEmit` 通过；`eslint` 0 error；`AppTopBar`/`ChatMinimap` 新增用例（按钮排在「更多」前且随可用性出现、抽屉形态渲染、空会话说明）；真机式 400px 窗口实测：按钮出现 → 抽屉列出 15 轮 → 点背景/✕/跳转都能收起。

已知（与本改动无关，桌面同样复现）：大纲里对**未加载轮次**点「跳到对话」会把历史翻出来（18 → 43 行），但视口没有滚到目标轮次（1440px 桌面轨道上同样 `scrollTop` 保持 0）。这条走的是 `jumpToUnloadedTurn` → `pendingNavigationRef` → `measureNodes` 的既有路径，需要单独排查 `targetTurn.scrollTop` 的测量时机。

## 14. 移动端输入行重排（0.17.0-merge.21）

原来移动端把「更多」放在输入框下面那一行，思考强度藏在「更多」菜单里。运行中那一行还要塞 Stop，模型名称被挤成两行、按钮也没地方放。

改成与桌面同一套位置关系：

```
                       ⌾10%  ⋯更多        ← 输入框右上方（composer-top-row）
┌───────────────────────────────────────┐
│ 消息...输入 / 使用命令，输入 @ 查找文件  │
│  🖼  @                          [→]     │
└───────────────────────────────────────┘
  🖼  @  模型名称  │ ◇思考强度      ■Stop  ▤
```

- 「更多」搬到输入框上方那一排（与桌面 `ComposerTopUtilities` 同一位置），抽成 `MobileComposerMenu`；下方那一行只剩运行控制与暂存库。
- 思考强度从菜单里拿出来，和桌面一样常驻在模型选择器后面（`ThinkingControl isMobile`）。菜单里只留工具预设、Fast、压缩、提示音、通知。
- 菜单在输入框上方，展开方向朝上（`.is-compact` 让按钮和上下文环同高，不再按 44px 整行按钮撑高）。

验证：`InputControls`/`ChatInput` 相关用例改为断言新位置（下方那一行不再有「更多」、菜单里不再有思考强度）；400px 窗口实测：更多在输入框右上方、思考强度常驻、菜单向上展开。

最长名称实测：把会话模型换成当前列表里最长的那条（`sleepinsum-deepseek` / `DeepSeek V4.1 Flash 0910`，44 字符），400px 宽下输入框下方那一行仍放得下——模型名占两行（198px）、后面接思考强度 `max`（51px）、右侧暂存库按钮，行内没有横向溢出（`scrollWidth === clientWidth`）。

## 15. 全量复查（0.17.0-merge.22）

按文件逐个复查 merge.15~21 的 41 个改动源文件（3,134 行新增），发现并修掉三处**父链成环时**的漏洞——都属于「手改坏的文件会让某条遍历重复取同一条记录或走不到头」：

| 位置 | 表现 | 修法 |
|---|---|---|
| `lib/session-reader.ts` `sliceActiveBranch()` | 内存分页路径没有环检测：分页预算改成 walker 后，条数上限不再等于「只走一圈」，成环时同一记录会重复进页 | 加 `visited`（与磁盘索引路径一致）；用例：成环只走一圈、页内不重复 |
| `lib/transcript-notices-server.ts` `ancestor()` | 找「缓存预热被计费的那条消息」时成环会原地打转 | 加 `visited`，找不到就返回 undefined |
| 同上 `onBranch` 构建 | 沿父链收集分支成员时成环会死循环 | 用集合自身当 `visited` |

其余复查结论（读过 + 实测）：

- `/context` 的 304 前置判断：外部改写检查仍在它之前，ETag 命中返回 304（`resolve;dur=0.4`），带 `before` 时不走 304。
- `get_state` 拆分：不带 `includeSystemPrompt` 为 1,027 B 且无 `systemPrompt`；带上为 30,587 B（提示词 28,602 字符），所有状态轮询都走 `agentStatusUrl()`（`systemPrompt=0`），`state.systemPrompt` 的消费方都有 undefined 守卫。
- 命令 admission 的提前 `release()` 与 preflight 回调里的 `release()` 共用 `released` 幂等标志，安全。
- `usePolledJson` 的请求序号 + URL 双重校验、`usePolledJson` 的可见性判断、`sameTurnNodes` 的引用比较（回答缓存按消息对象 WeakMap，blocks 引用稳定）均正确。
- `hasOutlineHeadings` 的字符粗筛只可能对 ATX/Setext 漏判，而这正是 remark 能给出标题的两种形状，不会漏。
- `finishNavigation` 只在用户主动跳转的三条路径上触发（已核对全部调用点），不会因为滚动重测误关抽屉。
- `data-answer-block` 的下标在 `getAssistantAnswer()` 与 `MessageView` 里用的是同一个 `answerBlocks` 数组，逐块标题定位不会错位。

验证：全量 570 文件 / 4132 通过 / 0 失败；`tsc --noEmit` 通过；`eslint` 0 error。

## 16. 大纲「跳到对话」落空（0.17.0-merge.23）

**现象**：长会话里点大纲中「未加载」轮次的「跳到对话」，历史会翻进来（18 → 43 行），但视口不动，`scrollTop` 还是 0，目标在 3600px 之外。

**根因**：待定位目标的落点取的是 `targetTurn.scrollTop` —— `measureNodes()` 在遍历 `messageRefs` 时缓存的偏移。翻页刚挂进来的消息这一轮还没经过 `messageRefs`，缓存值是 `null`，于是「有目标但量不到位置」，代码什么都不做，pending 就一直挂着。

**修法**（按用户拍板的方案）：待定位时**直接量 DOM** —— 用 `[data-entry-id]` 找到目标元素，读它的 `getBoundingClientRect()` 减去容器 rect 得到落点，量到什么滚什么；缓存偏移只在元素还没进 DOM 时兜底。标题跳转本来就量的 DOM（块 + 块内标题），这次把「回到目标轮次」也统一过来。另外加了退出条件：连续 10 次测量都量不到就清掉 pending 并在面板提示，不再无限挂着（按需加载期间不计数，那段时间目标本来就还没翻出来）。

**验证**（真浏览器，非 background tab）：
- 移动端 400px：抽屉 → 第 03 轮「跳到对话」→ `scrollTop` 0 → **3474**（目标距容器顶 146px，正好落在设计的三分之一处），抽屉自动收起（截图 `/tmp/jump-fixed.png`）
- 桌面 1440px 轨道：同一次跳转 `scrollTop` **2473**，目标距顶 156px
- 顺带确认：此前「滚动位置一直是 0」的观测有一半是**后台标签页**造成的——隐藏标签页里 `requestAnimationFrame` 与 smooth 滚动都不跑，`scrollTo` 被调用但不动。测这类滚动必须先把窗口激活。
- 同一份规则也接到**已加载轮次的双击跳转**（`scrollToNode`）：先量 DOM，量不到才退回缓存偏移。桌面 1440px 实测双击第 10 轮，落点距容器顶 156px（设计的三分之一处）。

## 17. 大纲与正文的数学预处理对齐（0.17.0-merge.24）

正文（`MarkdownBody`）、展开预览（`AssistantOutline`）、文件预览都先跑 `normalizeDisplayMath()`：
把 `\[…\]` 整理成 remark-math 能稳定解析的 `$$…$$` 块。完整目录直接解析原文，于是 `\[…\]` 里的
`## 小标题` 在正文里是公式内容、在旧轮次的目录里却成了一个标题。

- 数学预处理从 `lib/markdown.ts` 抽到独立模块 `lib/display-math.ts`（纯字符串处理，无依赖）：
  服务端目录不能再 import 客户端渲染模块（`react-markdown` / `rehype-*` 只在 devDependencies 里，
  发布包安装后并不存在）。`lib/markdown.ts` 保留同名再导出，调用方不用改。
- `extractOutlineHeadings()` 解析前也跑 `normalizeDisplayMath()`，目录、预览、正文从此吃同一份输入。
- `lib/markdown.test.mjs` 改成走 jiti 加载（`markdown.ts` 现在有无扩展名的相对再导出，Node 自带的
  类型剥离要求写全扩展名）。
- 对照测试补了两种形状（`\[…\]` 与 `$$…$$` 里的 `##`），并新增一条专门用例；去掉预处理后三条断言
  里有两条立刻变红。

验证：全量 570 文件 / 4134 通过 / 0 失败；`tsc --noEmit` 与 `eslint` 通过。

## 18. 触屏上点消息不出复制按钮（0.17.0-merge.25）

**现象**（用户报告）：移动端点回复正文不出复制按钮；点其他内容出过一次之后，回头再点正文又「轻松能点出来」。

**根因**：动作栏完全由 `hovered` 驱动（`onMouseEnter`）。触屏没有真正的 hover——iOS Safari 只对浏览器认为「可点」的元素合成 mouseenter，按在纯文本上不发；先在可点元素上按一下之后合成事件才打开，于是出现「回头就灵」的错觉。

**修法**：`components/useMessageActionsReveal.ts`，触屏（`pointerType !== "mouse"`）按在这条消息上就显示动作栏，按到别处收起（document 捕获阶段；`[data-message-actions]` 上的按下不算「别处」，否则点复制按钮会把栏收掉）。鼠标仍走 hover。用户消息与助手消息共用这一个 hook。

**用户补充的两个关键事实**：① 设备是安卓 Chrome；② 「触发一次滚动就能触发按钮显示」。第②点正好印证了根因：滚动时 Chrome 会合成一次 `mousemove`/`mouseover`，hover 这才建立，按钮随之出现。

**第二版（更贴合安卓）**：改成「点一下」判定 —— `pointerdown` 记下位置，抬起在 **document** 上读（手指滑出元素也不丢），位移超过 `TAP_SLOP_PX`（16px）就不算点按。这样滚动划过消息不会闪出动作栏；把「只有滚动才灵」的依赖彻底去掉。

**验证**：jsdom + React 用例（点一下显示、点按钮不收、点外面收起、滚动/拖动不显示、鼠标不参与）；真浏览器 400px + 触摸模拟，并**拦掉所有合成 mouseover/mouseenter/mousemove**：点一下 opacity 0 → 1；按住上下拖动 95px 后抬起仍为 0。

## 19. merge.25/26 的自查修正（0.17.0-merge.27）

复查这两批改动后改掉两处：

1. **注释把平台写窄了**：原注释只说 iOS Safari 不合成 mouseenter，会误导后来人。实际触屏浏览器都按自己的时机补发兼容鼠标事件：iOS 只对「可点」元素合成，安卓 Chrome 常常要滚动一下才补发 `mousemove`/`mouseover`（用户实测「滚一下按钮就出来了」）。注释与 `docs/agents/sessions.md` 都已改写。
2. **多指抬起顺序**：`finishPress` 先清 `pressRef` 再比对 `pointerId`，第二根手指抬起会把第一根手指的点按作废。改成先比对再清，并补用例（恢复旧顺序该用例变红，已实测）。

复查后保留不动的意见（都记在这里，不擅自扩大改动）：

- 每条挂载的消息常驻 2 个 document 监听（`pointerup`/`pointercancel`）。当前渲染窗口只有几条到几十条，成本可忽略；若将来窗口显著变大，可在按下时才挂、抬起即摘。
- 混合设备（触屏 + 鼠标）上，鼠标点空白不会收起点按唤出的动作栏，要等下一次 hover 或点按；hover 的 `onMouseLeave` 会兜住常见路径。
- 键盘/读屏本来就没有唤出动作栏的路径，这次没有回归，也没有新增。
- 用例是 hook 级替身，没有覆盖 `MessageView` 的真实接线（`ref` / `onPointerDown` 挂在哪一层、hook 是否在提前 return 之前调用）。这类接线错误由浏览器实测兜住。
- `hovered` 这个名字现在既表示 hover、也表示点按唤出，可读性一般；改名要动两处状态与方法入参，收益不大，暂不改。

## 20. 移动端文件行改成左滑出操作条（0.17.0-merge.28）

**问题**：`components/FileExplorer.tsx` 的 `FileTreeNodeActions` 只在 `hovered` 时渲染，手机上没有 hover，侧栏抽屉里的「下载 / 插入路径 / 提及 / 定位」根本点不出来。和消息动作栏同一个毛病，项目里已有既定做法：`SessionItem` 用 `if (!isMobile) setHovered(true)` 加一套移动端入口。

**修法**（用户选定「移动端改成左滑出现」）：
- 复用 `hooks/useSwipeActions.ts`（会话行已经在用），`TreeNode` 每行接一份手势；`FileExplorer` 用 `swipeOpenPath` 保证同一时间只开一行。
- 操作条是行内的绝对定位块，`translateX(FILE_ROW_SWIPE_WIDTH + offset)`：关着时整块不渲染，左滑时从右侧滑入盖住行尾。`overflow: hidden` 只加在移动端，`touch-action: pan-y` 保住竖向滚动。
- 移动端只放图标（`compact`）：`@` + 下载 + 定位 实测 75px，手势终点取 84px。桌面保持原样（带文字的 `@提及`、`在访达中打开`），悬浮行为不变。
- 移动端忽略 hover（`if (!isMobile) setHovered(true)`），Git 状态点不会被伪悬停顶掉。
- 点这一行只当作收起（`consumeClick()`），不会顺带打开文件/展开目录；点别的行会把开着的那条收起来。

**验证**（400px + 触摸模拟）：左滑文件行 → 操作条滑入，三个按钮 `将路径插入聊天 | 下载文件 | 在访达中打开`；内容 75px / 条宽 84px 不溢出；点这一行收起且不导航；竖向拖拽列表照常滚动（348 → 473）；1200px 桌面上鼠标悬浮仍是原来那组带文字按钮、没有滑出块。

**调整（merge.29）**：按用户要求，移动端操作条只留 `@`（把路径插入聊天）。宽度从 84 降到 40，按钮 30px 高 24；`compact` 时下载与「在访达中打开」不再渲染，没有 `onAtMention` 的场合连手势都不接，避免滑出一块空白。桌面不受影响。截图 `/tmp/mobile-at-only.png`。

## 21. 聊天文件改用「选择文件」入口并落到下载目录（0.17.0-merge.30）

**背景**：聊天原本只把图片当附件（base64 内容块，不落盘），其他文件走「拖进聊天 / 回形针」→ 上传到会话工作目录根 + 插入 `@文件名`。用户要求：文件也走同一个入口，落点改到下载目录，粘贴逻辑不动。

**改动**：
- `lib/file-upload.ts` 新增 `rename` 冲突策略与 `uniqueUploadName()`：重名按浏览器习惯变成 `report (1).pdf`，扩展名保留，`.` 开头或无扩展名整串当基名，绝不覆盖。
- 上传响应新增 `paths`（绝对路径，与 `uploaded` 一一对应），`uploaded` 在 `rename` 下是改名后的名字。
- `app/api/upload-target/route.ts` + `lib/upload-target-client.ts`：落点由服务端给出（`<home>/Downloads`），客户端不拼路径，Windows 分隔符不会出错；客户端只取一次并缓存，失败不缓存。
- `getUploadDirectory()` 发现上传目标正是 `~/Downloads` 时补一次 `allowFileRoot()`：不补则 403。代价是该目录此后可被 `/api/files` 列出读取（聊天里的路径要能点开预览）。
- `ChatWindow.uploadDroppedFiles` 改落点、改策略、按 `paths` 插 `@绝对路径`（含空格自动加引号），并在上传前发一条「正在把 N 个文件存到下载目录…」提示；不再要求会话有 cwd，所以手机上没选项目也能传。
- 图片与粘贴路径一行未动：图片仍是内容块（模型直接看图，落盘反而要退化成路径引用）。

**验证**：
- 单测：`lib/file-upload.test.mjs`（重名规则、`.` 开头、目录也算占用、`rename` 解析）、`app/api/files/upload-route.test.mjs`（不覆盖原文件、`paths` 正确、`skip` 仍跳过、下载目录上传后从 403 变可列）、`app/api/upload-target/route.test.mjs`。
- 浏览器（1200px 桌面 / 400px 移动端）：点回形针选两个文件 → 落到 `~/Downloads`，输入框得到 `@/Users/syy/Downloads/pi-web-upload-check.txt @"…/my report.txt"`（空格加引号）；同名再传得到 `pi-web-upload-check (1).txt` 且 mention 指向新名字；提示文案出现两次「下载目录」。移动端 `label[for=chat-attach-input]` 可见、title 为「附加文件」，同样上传成功。
- 实测后已删除 `~/Downloads` 与项目目录里的测试文件。

## 22. 复查 merge.30 的五处问题（0.17.0-merge.31）

外部审查提了 5 条，逐条核对后四条是缺陷、一条是既有行为：

1. **下载目录不存在时首次上传 404**（确认）。`getUploadDirectory()` 只做 `stat`。现在 `rename` 上传到下载目录时会先 `mkdir -p`（精简镜像里 `/home/node` 没有 Downloads），失败才报 500。新增用例：HOME 下没有 Downloads 时首次上传成功。
2. **校验前就放开整个目录**（确认，安全回归）。原来一进 `getUploadDirectory()` 就 `allowFileRoot()`，于是 `upload-check`、`skip`、甚至失败的上传都能把下载目录变成可浏览/可覆盖的允许根。现在：写例外只在「`type=upload` 且 `strategy=rename`」时给（`allowDownloadsWrite`），且不授予读取；读取权限改为**真的写出文件之后**才 `allowFileRoot()`。用例覆盖 skip/overwrite/error/upload-check/非法文件名五种情况都保持 403，成功后才 200。
3. **同名目录/符号链接时改名后仍被拒**（确认）。`nonReplaceableSet` 检查原先不看策略，`rename` 选好的 `notes (1)` 也被挡住。改成只对 `overwrite` 生效。用例：同名目录与符号链接都能写成 `notes (1)` / `link (1)`，`overwrite` 仍拒绝。
4. **并发同名可能失败**（确认，P3）。`wx` 撞 `EEXIST` 时现在重新选名重试（`MAX_RENAME_ATTEMPTS = 5`），写入仍独占。没做并发的确定性用例，靠代码路径与顺序用例覆盖。
5. **附件引用点不开**（确认，但不是这次引入的：以前 `@文件名` 同样不可点）。新增 `remarkFileMentions`：渲染时把 `@/绝对路径` / `@"/带 空格"` 包成链接，文字原样、模型仍只看到纯文本；只认绝对路径，`@某人`、行内代码、相对路径都不动。用例覆盖四种形状。点击落到文件查看器的本地链接分支（既有能力，指向绝对路径；上传成功后下载目录已在允许根里）。

验证：`app/api/files/upload-route.test.mjs` 6 条、`lib/markdown.test.mjs` 45 条、`lib/file-upload.test.mjs` 5 条全过；全量见提交信息。

## 23. 移动端：Stop 收进「更多」，大纲抽屉落到当前（0.17.0-merge.32）

用户提了两处移动端体验问题：

1. **Stop 暴露在输入行，误触概率高**（拇指一带就停掉一次运行）。现在 Stop 只在「更多」菜单里：
   `InputControls` 的移动端分支只留暂存库，`MobileComposerMenu` 的运行控制不再按运行状态隐藏
   （空闲=压缩、运行中=停止、压缩中=停止压缩），按完自动收起菜单。Stop 藏进去后，「更多」
   按钮在运行/压缩时亮一个点（运行 `--accent`、压缩红），否则看不出还有任务在跑。
   键盘打开时这一行和原来一样隐藏，所以停运行仍要先收起键盘——文档已同步。
2. **大纲抽屉打开时停在第一轮**。现在打开那一刻落在正在读的那一轮（按 rect 居中，只动列表自己的
   scrollTop，不会带着背后的对话滚），测不到活动轮（还没测量、或在未加载区）时落到列表末尾；
   落位只做一次，之后用户自己滚动不会被拉回。

验证（400px + 触摸）：运行中输入行里已无 Stop（只有上下文环、「更多」、侧聊、引导、后续、模型、
推理、暂存库）；点「更多」出现「停止 Agent」，点它运行停止、菜单收起、发送按钮回来、「更多」的点消失。
大纲：对话在底部时抽屉 `scrollTop` 到底（末轮完整可见）；把对话滚到 35% 再开，抽屉把第 2 轮居中。
用例：`components/InputControls.test.mjs` 改成断言「Stop 不在输入行 + 运行中「更多」有点 + 菜单的运行
控制不被隐藏」。

## 24. 移动端：暂存库进「更多」，模型名两行放满（0.17.0-merge.33）

1. **暂存库搬进「更多」**：`InputControls` 移动端分支直接 `return null`，那一行只剩附件按钮、
   模型名称、思考强度。暂存库入口经 `MobileComposerMenu` 的 `endAction` 交给 `PreferenceToggles`
   渲染，和提示音/通知并排；点开仍是原来的底部抽屉，菜单留在后面。桌面的位置不变。
2. **模型名称尽量完整**：省下的约 40px 全给模型 chip；另外把 chip 内边距从 `4px 10px` 压到
   `4px 7px`、分隔线外边距 3px→2px，并给按钮补 `textAlign: left`（按钮默认居中，短的服务商名
   「magpie/」会缩在中间）。实测 400px：chip 文本宽 213px，`magpie/` + `DeepSeek-V4.1-Flash ·
   deepseek365`（209px）整段放得下，不省略尾部服务商名。

验证（400px + 触摸）：输入行 = [附件][模型两行][思考强度]，没有 Stop/暂存库；「更多」里依次是
工具预设、压缩上下文、暂存库、提示音、通知、收起，点暂存库弹出原来的抽屉。截图
`/tmp/mobile-model-full2.png`（模型名）、`/tmp/mobile-menu-with-stash.png`（菜单）、
`/tmp/mobile-stash-in-menu.png`（抽屉）。用例：`components/InputControls.test.mjs` 新增「暂存库
不在输入行 + 由 PreferenceToggles 渲染 + 菜单透传 endAction」。

## 25. /review 复查 merge.29–merge.33（0.17.0-merge.34）

独立审查提了 5 条 + 1 条可选优化，逐条核对：

1. **下载目录的写权限被读授权带出来了**（确认）。写成功后 `allowFileRoot()` 让这个目录成为普通允许根，
   之后 `overwrite` 就能替换其中原有文件。修：`getUploadDirectory()` 对该目录**只认 `rename`**，
   其它策略即便读权限已授予也 403；用例覆盖 overwrite/skip/error 三种策略都拒绝且原文件不变。
   审查建议的「授权持久化 / 限定到具体文件」没做：预览依赖进程内允许根，而按会话引用的授权需要
   客户端带 `sessionId`（文件查看器打开聊天附件时不带），改动面更大；现在的边界是「只读可预览、
   写只认 rename」。
2. **下载目录是符号链接时校验无效**（部分确认）。审查说得对：两侧都是同一个 realpath，比较恒成立。
   但请求目标必须正好是 `<home>/Downloads`，写入落到用户自己的软链目标并不越界；返回的 `paths`
   和授权用的都是解析后的真实目录，预览照常。没改，补了说明。
3. **文件名带 `#`/`?`、Windows 盘符路径生成坏链接**（确认）。修：`fileMentionHref()` 转义 `%?#` 与
   空白（`resolveLocalFileHref()` 先按 `#`/`?` 切分再解码，不转义就会截断），盘符转成
   `file:///D:/…`（否则清洗器当未知协议丢掉），`remarkFileMentions` 也接受 `D:\…` 形状。用例补
   「文件名里的 # ?」「Windows 盘符」两条。
4. **抽屉仍会停在较早轮次**（确认：用户要的就是「最后」，我先前做成了活动轮优先）。修：抽屉固定落到
   列表末尾，活动轮只保留高亮；行是异步来的，靠 `MutationObserver` 在第一次可滚时落位，只做一次。
   实测：对话在 35% 处打开抽屉，`scrollTop == max`、末轮完整可见。
5. **暂存库里的 Esc 会把菜单一起收掉**（确认）。修：`InputControlsMenu` 的 Esc 处理跳过来自
   `<dialog>` 的事件，交给暂存库自己的 `onCancel`。浏览器里没法可靠复验（CDP 的合成 Esc 不触发
   原生 dialog 的 cancel），只做了代码层与合成事件检查。

**可选优化**（采纳）：`rename` 跳过 `inspectUploadTargets()`，每份附件少一次同步 `lstat`。

验证：全量见提交信息；`lib/markdown.test.mjs` 47 条、`app/api/files/upload-route.test.mjs` 7 条。

## 26. 真机反馈（merge.31 上）——5 个问题

1. **点附件按钮要等很久才弹选择框、有时弹不出**（确认）。附件按钮是 `<label htmlFor>`：原生标签激活先挪焦点，
   手机上等于收/开一次键盘，`useViewportHeight` 一变整棵聊天重排，选择框要等主线程空下来。
   改成 `<button>` + `input.click()`，`onPointerDown` 里 `preventDefault()` 保住焦点。
2. **移动端上传不了**：与 1 同源（选择框都没弹出来），不是上传接口的问题。
3. **压缩期间两个 Stop**（确认）。`RunControls` 里「停止压缩」和「Stop」同时命中，两个都是一模一样的红方块。
   压缩时只留「停止压缩」。
4. **顶部一直「加载中」**（确认可能）。历史分页请求没有期限，服务端一卡就永久停在加载中
   （开发服这次也真的卡死过一次）。加 30 秒期限，超时走既有 `finally` 清 loading，按钮可重试。
5. **模型名第一行浪费、名字被截断**（确认）。移动端把 `provider/` 单独渲染成第一行，第二行再放模型名，
   结果第一行只有 "magpie/"。改成一整段两行（`-webkit-line-clamp: 2`）：实测
   `magpie/DeepSeek-V4.1-Flash · deepseek365` 排成「magpie/DeepSeek-V4.1-Flash ·」/「deepseek365」，不省略。
6. **「更多」排成两行**（确认，用户要求一行）。`width: auto` 在 60px 宽的定位父级里每行只排一个按钮；
   改 `width: max-content` + `max-width: min(100vw - 16px, 420px)`，两组容器改 `display: contents`。
   实测 400px 视口：332×58，一行 6 个按钮，不溢出；运行中也只有一个「停止」。

## 27. 分页三处复查（merge.36）

外部审查针对 merge.35 的历史分页提三条，逐条核对后都成立：

1. **Safari 16.2 翻不出更早消息**（确认）。`AbortSignal.any()` 是 Safari 17.4 才有的，
   `AbortSignal.timeout()` 要 16.4；`AbortSignal.any()` 在老 Safari 上会**在发请求前**抛 TypeError，
   连本来能翻的历史也一起废掉。改成 `withPageDeadline()`：`AbortController` + `setTimeout`（与
   `lib/session-load-client.ts` 既有写法一致），`finally` 里 `release()` 清计时器并摘掉监听，切会话
   时的取消照旧由外层 `controller` 传播。
2. **超时后自动重发同一页**（确认）。顶部哨兵还在视口里，`loading` 一清就重建
   `IntersectionObserver` 再请求同一个游标 —— 顶部会无限闪「加载中」。现在超时/出错把该游标标成
   `failed`：哨兵不再自动发，顶部变成「加载失败，点击重试」（`retryEarlierMessages`）。成功一页、
   新上下文快照、会话加载都会把标记清零。
3. **大纲跳转的逐页请求没有期限**（确认）。`loadUntilEntryId` 循环里的每页现在都走
   `fetchJumpPage()`（同样的 `withPageDeadline`），失败也把 `loading` 清掉并标 `failed`，
   顶部与跳转按钮都不会一直转圈。

**顺带发现（本次未改，范围外）**：`lib/session-load-client.ts:288` 的 `/state` 请求也在用
`AbortSignal.any()`，`lib/agent-client.ts`、`lib/provider-usage.ts`、`components/MessageStash.tsx`
在用 `AbortSignal.timeout()`。按本项目的 Safari 16.2 基线它们同样会在老 Safari 上抛错，
要不要统一换掉需要单独拍板（改的是会话加载与聊天发送的关键路径）。

## 28. 分页失败的两处复查（merge.37）

1. **404 之后仍会自动重发**（确认）。会话文件在页面打开期间被删/归档时，分页接口回 404 →
   `kind: "missing"`，原来落进通用的「不是 loaded 就退出」分支，`failed` 仍是 false，顶部哨兵
   还会重发同一游标，用户也看不到任何重试或说明。修：先校验请求仍属于当前会话，再单独处理
   `missing` —— `hasMore: false` 关掉分页、不挂重试（重试一个删掉的文件没意义），并提示
   「会话文件已不存在，无法加载更早的消息」。其余非 `loaded` 一律按失败处理（挂重试）。
2. **大纲跳转后续页失败会污染顶部重试**（确认）。`loadUntilEntryId` 的各页只存在局部数组里，
   第二页超时时一页都没提交，顶部游标还停在第一页之前，`finally` 却把它标成失败；顶部「点击重试」
   于是从第一页又跑一遍普通分页，回不到原跳转。修：只有 `step === 0`（顶部游标那一页）失败才设
   顶部失败标记（`firstPageFailed`），后续页失败留给大纲入口（`revealFailed`，再点那一轮）。

验证：全量 572 文件 / 4149 通过 / 0 失败；tsc、eslint 通过；新增「missing 先于通用失败分支、
关闭分页并提示」「只有首页失败才设顶部标记、fetchJumpPage(before, step === 0)」的用例。
