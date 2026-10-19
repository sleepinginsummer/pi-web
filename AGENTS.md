# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- Before starting a server, run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse the existing Pi Web process when it is healthy. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

### Upgrading pi

pi's packages depend on each other with `^` ranges, and the published pi-web's dependencies resolve afresh on install (no lockfile ships). Install every `@earendil-works/*` package the tree holds, the SDK's own dependencies included (`pi-codemode`, `pi-mcp`, `pi-telemetry`, …), with `npm install --save-exact`, so npm reuses those exact versions for the SDK's ranges. `lib/pi-packages.test.mjs` fails on any pi package that is not pinned that way; pi-web 0.12.0 pinned four, and installs after pi 1.2.0 paired pi-coding-agent 1.1.0 with pi-codemode 1.2.0. 升级时还要同时更新 `scripts/patch-pi-sdk-extension-cache.mjs` 的 `REVIEWED_SDK_VERSIONS`（先核对 `extensions/loader` 缓存段）并复核 `lib/agent-message-queue.ts` 依赖的 agent-core 队列结构。

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/details/route.ts  GET file path + projected branch tree, without context
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  project-directories/route.ts    GET/POST/DELETE persisted sidebar directories
  sidebar-preferences/route.ts    GET/PATCH synchronized sidebar order and Pin state
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  servers/route.ts                GET ?cwd= dev servers + declared configs | POST start a declared one
  servers/[id]/route.ts           POST { action: "stop" | "dismiss" }
  servers/[id]/logs/route.ts      GET recent output
  servers/settings/route.ts       GET/PUT Settings › General dev server switch
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  project-directories.ts persisted directory list in ~/.pi/agent/pi-web-projects.json
  sidebar-preference-state.ts shared pure order/Pin action reducer
  sidebar-preferences.ts versioned, locked server persistence for sidebar preferences
  sidebar-preferences-client.ts browser migration and HTTP adapter
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeAssistantMessage() — normalizes toolCall field names and converts legacy <thinking> text blocks
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  sidebar orchestration + FileExplorer
  ProjectSection.tsx  project row controls + virtualized session tree
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)
- Do not cache or share complete `AgentSessionServices`: its settings manager, resource loader, and extension runtime are mutable and cwd/session-bound. Cold startup cost is measured in the `services` stage; optimize concrete immutable discovery inputs only, never by reusing services or executing extension factories in a throwaway warmup.
- Pi SDK 1.0.0–1.2.0 仍使用单 cwd 的扩展模块缓存（三个版本的缓存段逐字一致）；`scripts/patch-pi-sdk-extension-cache.mjs` 只接受 `REVIEWED_SDK_VERSIONS` 中已复核的版本，补丁保留最近八个 cwd 的工厂模块，每个会话继续创建独立 runtime。升级 SDK 时必须复核 `extensions/loader` 并更新版本集合或移除补丁，源结构或版本不符时须拒绝安装。
- 保留 Pi SDK 原生的上下文阈值检查与自动压缩（1.0.0–1.2.0 触发条件与调用点一致，1.2.0 只是摘要输入不再包含 thinking）；升级 SDK 时须复核其压缩时机与完整上下文投影，不得重新引入已移除的 pi-web 运行中压缩补丁。

### Session first-paint loading
- Existing sessions load `/api/sessions/[id]/context` first and commit messages immediately. 切回已结束的会话时，只有 `/context` 验证文件版本与活动 leaf 均一致，才恢复有上限的页面内历史快照；不一致就丢弃。 `/details` (file path + projected branch tree) and `/state` use independent abort controllers and load afterward; details failures must not hide a valid context or runtime snapshot.
- Delayed details are identity-bound to the session id so an old tree cannot pair with a new leaf. `/details` must not read entries or build context.
- `ChatWindow` groups history into lightweight index descriptors, applies the visible window, and only then creates JSX. The window count is keyed by session id/cwd so a newly selected session cannot inherit an expanded history window from the previous session.

### Fork uses an independent file-level service
`AgentSession.fork()` mutates the active wrapper in-place, so pi-web does not call it. `lib/session-fork.ts` creates and validates the copied JSONL in an isolated staging directory, cleans staging before commit, then publishes to the real session directory with create-only atomic semantics. `rpc-manager.ts` only updates caches and returns the new id; it must not destroy or mutate the source wrapper, so persisted history can be forked while the source session is running.

### Two kinds of branching — don't confuse them
- **Fork** (“New session” on persisted user/assistant messages): creates a new independent `.jsonl` file. User-message forks stop before that message and prefill it as a draft; assistant-message forks include that response and completed tool results. Shown as a child in the sidebar tree via `parentSession`.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### Streaming markdown must not re-parse the whole message per frame
- 流式消息每帧都会拿到新的累积文本。整篇重解析的成本随回答长度线性增长（30KB 正文单帧约 34ms 中位、最差 69ms，浏览器还要再加 Prism 与 DOM 提交），主线程被占满时输入框按键会排在 30~70ms 的渲染任务后面，表现为打字卡顿（实测流式期间 keydown 端到端 48~64ms，最差 168ms；空闲基线 24ms）。
- `lib/streaming-markdown-blocks.ts` 只把顶层空行当切点，并避开未闭合的代码围栏、原样 HTML 块、HTML 注释、`$$` 数学块、列表与引用的续行、引用式链接和脚注定义，因此每个冻结块单独解析与整篇解析结果一致。未闭合的代码围栏交给调用方按纯文本渲染。
- `MarkdownBody` 在 `isStreaming` 时按块渲染：冻结块走 `memo` 化的 `StreamingMarkdownBlock`（props 按值稳定，字符串比较即可命中），每帧只重新解析尾部。块级 memo 依赖 `components` 身份稳定，所以渲染回调只能通过 ref 读取，不要把 `onOpenFile` 这类上游回调直接放进 `useMemo` 依赖。
- 流式期间极少数结构允许短暂不一致（还没流到定义的引用式链接/脚注、块边界上的空白文本节点），`message_end` 时 `isStreaming` 变为 false，整篇渲染是最终结果 —— 不要让流式路径成为唯一渲染路径。

### Assistant message normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeAssistantMessage()` in `lib/normalize.ts` handles this and converts legacy assistant text blocks in the form `<thinking>...</thinking>` into native thinking blocks. It is called in both `session-reader.ts` (file load) and the SSE/agent-event handling logic in `hooks/useAgentSession.ts` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Session-level Shadow Mind toggle
The top bar Shadow switch controls only the current session. `lib/shadow-session-setting.ts` is the single source of truth: it persists `pi-web-shadow-mind-state` custom entries, restores disabled state after wrapper/runtime reload, serializes concurrent pause/resume requests with last-write-wins semantics, and treats a missing optional Shadow extension as unavailable instead of failing session startup. Both the top-bar control and Web `/shadow pause|resume` paths must use `set_shadow_mind_enabled`; never infer state from the extension status text or call the extension command through a second unpersisted path. Unsent sessions are keyed by cwd in `AppShell`; `lib/pending-new-session.ts` owns their reducer and exhaustive UI projection, while `lib/new-session-materialization-client.ts` deduplicates create/finalize requests across `ChatWindow` remounts. An explicit disabled preference is applied and persisted before the first prompt. Fresh sessions default to Shadow off: `lib/pending-new-session.ts` keeps staged sessions disabled, so materialization submits an explicit disable for every unsent session; only an explicit per-session enable omits the request and keeps the extension's own enabled default. When the optional extension is unavailable there is no runtime to pause, so the disable still records the preference instead of failing startup, and existing sessions that never recorded an entry keep following the extension default. Post-start failures retain the real session id and retry the idempotent `finalize-existing` operation only after canonical cwd/session identity validation.

新会话 `ensure_session` 使用两阶段创建：`create` 只返回 `runtime-created` 与真实 session id，不等待扩展审批；前端进入 `initializing`，接管 id 并连接 SSE 后，再调用 `finalize-existing` 应用 Shadow 预设及读取完整状态。只有 `ready` 才解锁模型和发送控件。扩展审批仍需用户明确确认，不得自动批准或通过全局配置绕过。切换页面后重新挂载须恢复同一个 runtime 的 SSE 和初始化请求，失败重试不得创建第二个会话。已创建但尚未发送的新会话切换模型必须先等待服务端成功，再提交选择器状态；失败保留原选择并显示错误。

### Session-level OpenAI Fast mode
`lib/fast-session-setting.ts` is the single source of truth for the session Fast preference. `lib/fast-mode.ts` contains only pure key/protocol/clone logic; model-level Priority capability declarations are stored by `lib/model-capabilities.ts` in `~/.pi/agent/pi-web-model-capabilities.json` because the SDK validates `models.json` strictly and sampling parameters are forwarded upstream. The ModelsConfig API temporarily merges this capability as `fast: true` for the form, strips it before writing `models.json`, and rebuilds the sidecar keys from the current model snapshot so deleted or renamed models leave no stale entries. `lib/models-config-commit.ts` is the only paired persistence/read boundary: PUT holds a `proper-lockfile` cross-process lock across snapshot, both atomic writes, and lock-owned rollback; GET takes the same lock only long enough to read immutable file contents and compute a generation hash. Slow SDK/extension catalog creation runs outside the lock and validates generation afterward without repeating side effects. Each `AgentSessionWrapper` atomically owns an immutable runtime snapshot containing one catalog resolver, its same-lifecycle Fast capability set, and a runtime generation; reload installs the whole snapshot once, and queued Fast work from an older generation becomes a no-op. Fast requires either the built-in OpenAI provider or an explicit model capability declaration plus `api: "openai-responses"` or `api: "openai-completions"`; OpenAI-compatible transport alone is insufficient. The setting persists `pi-web-fast-mode-state` custom entries and serializes toggle/model-switch/reload application with last-write-wins semantics. Never mutate `inner.model` or a `modelRuntime` catalog object: Fast application passes a session-private clone with independent `compat`/`samplingParams` objects to `setModel`. Disabling Fast must rebuild from the captured catalog resolver so an explicitly configured base `service_tier` is restored.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
- `/api/models/enabled` 通过独立事务锁串行化读取、编辑和写入，并在锁内新建 SDK `SettingsManager`；不能在调用 SDK 时外层再锁 `settings.json`，否则会与 SDK 自身文件锁冲突。
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

- `/context` 和 `/details` 在读取存活 wrapper 前检查外部 JSONL 追加：空闲时淘汰旧 wrapper，运行中返回 409，不展示旧 leaf；仅允许停止与只读控制命令。新 wrapper 在启动后的实际命令派发前复查磁盘；文件版本变化时逐条核对 JSONL 与内存，连同 ID 重写也不能误认为未变。尾部读取工具能按需越过 64 KB，但 wrapper 新鲜度边界以完整文件校验为准。
- 核对分两层（`lib/session-disk-freshness.ts`）：超过 2MB 的文件在同 inode、严格变长、首行 header 未变、已验证 EOF 前 64 KB 逐字节未动且新增区间逐条对上内存时走增量路径，只读新增字节（107MB 实测 973ms -> 1ms，外部追加判 `changed` 1ms）；其余情况一律全量核对。路径取舍只在 `inspect()` 一处决定（版本短路 + `canSkipPrefixVerification()` 的字节/时间预算），两条路径共用 `compareJsonlEntryLines`/`compareHeaderLine` 的比对规则（空行、pi-web 登记的改写都必须一致），改边界时不要各改一份。增量路径不重读前缀，但跳过是有预算的：累计追加超过 `maxDeferredPrefixBytes`（默认 8MB）或距上次全量核对超过 `maxDeferredPrefixMs`（默认 5 分钟）时强制回到全量，因此「64 KB 窗口之外的原地改写」最迟在这个界线内被发现，不会一直漏检——这两个界线可以注入更小的值以便覆盖边界，`retainedPrefixBytes()` 用来断言保留的字节不随文件增长（`tail` 必须 `Buffer.from` 复制，`subarray` 会共享整个文件缓冲区）。
- pi-web 自己绕开 wrapper 改写文件（当前只有删除父会话时的级联 `parentSession` 重写）必须在同一个循环里对存活 wrapper 调 `adoptSelfAuthoredFileRewrite()`（`DELETE /api/sessions/[id]` -> `AgentSessionWrapper` -> `SessionDiskInspector`）：只登记被改写的那一行，其余内容照旧逐条严格比对，登记后作废上次校验结果并重跑一次全量核对。不登记的话，正在运行的分叉会话会把自己人写的文件判成外部修改并一直 409。
- 通过存活 wrapper 写 `session_info` 之前必须先确认 `diskFreshness() === "current"`：外部手工改名会让 wrapper 内存里的名称过期，拿过期名称当基线会把用户刚写的名字覆盖掉（`lib/session-info-writer.ts` 的 `stale` 语义）。自动命名遇到 `stale` 必须放弃，显式重命名（PATCH）遇到 `stale` 退回文件级写入，让落后的 wrapper 在下次读取时被淘汰重建。热更新/升级前创建的 wrapper 没有 `AgentSessionWrapper.appendSessionInfoName`，写入边界必须退回用它的 `inner.sessionManager.appendSessionInfo()` 并失效列表缓存（两者效果相同，直接调用新方法会对旧实例抛 TypeError）。
- 客户端侧 `session_external_write` 的重试等待只能跟随**请求自身**的 signal（`init.signal`），不能用调用方的 signal：可缓存读取由多个调用方共用一次请求，用调用方的 signal 会变成「一个调用方取消，所有人的重试一起被取消」，单个调用方的取消语义归 `waitForConsumer()`。
- 这类冲突的 409 统一带 `code: "session_external_write"`（`lib/session-external-write.ts` 是唯一契约来源，agent 命令路由、`/context`、`/details` 和强制刷新共用）。客户端把它当可恢复状态：`lib/session-load-client.ts` 自动重试一次，仍失败则由 `useAgentSession` 保留已有消息并给提示，只有无内容可保留时才回退整窗错误页。
- `lib/session-message-persistence.ts` 在主会话和内置子代理的 SDK 保存入口，按 JSONL 序列化规则复制最终工具结果。插件返回结果后再修改嵌套字段（例如 hashline 批次中止标记）不得污染已保存的内存历史；不能通过忽略 `details` 或放宽完整文件比较来规避 409。

### 运行中止与扩展延迟注册的 provider（上游 v0.11.0）
- SDK 1.1 的 `agent_settled.aborted` 由 wrapper 记入 `lastRunAborted`，`prompt_done` 在被停止时带 `aborted: true`。客户端在 `useAgentSession` 中把它写入 `RunCompletion.aborted`，`useCompletionEffects` 对被停止的运行不播放提示音、不发通知（任一客户端的 Stop/Esc 都算），与本机手动停止的通知抑制并存。fork 不使用服务端 `onAgentRunComplete` 推送。
- `lib/deferred-provider-models.ts` 记住扩展只在 `session_start` 注册的 provider 模型，`/api/models` 用它补全列表；`startRpcSession()` 遇到这类模型时以默认模型创建，绑定完成后再切换。切换必须通过 `trackStartupModelSwitch()` 跟随 `whenExtensionsBound()` 的真实绑定生命周期，且仅在会话尚未运行时执行，不能在 create 阶段 `await`，否则新会话两阶段创建会被扩展审批阻塞。`waitUntilReady()` / 请求级等待的超时只拒绝当前调用，不能作为后台切模任务的失败。

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

Active `ask_user_question` tool starts are retained by `AgentSessionWrapper` for the wrapper lifetime. A new SSE listener receives those starts before pending extension UI requests so a multi-question ask is reconstructed before its first per-question `select` request. Replaying the same tool-call id must preserve the mounted questionnaire state and its request deduplication state so transient reconnects cannot erase answers or duplicate queued questions.

### 排队消息附件与移回
- `lib/queued-messages.ts` 是队列 SSE、运行状态和 `clear_queue` 的统一契约，每条消息包含文字和完整 base64 图片；输入框显示图片数量，移回时同时恢复文字、图片及已有草稿。
- `lib/agent-message-queue.ts` 将 Pi agent-core（1.0.0–1.2.0 的 `agent.js` 逐字一致）的内部 `steeringQueue.messages` / `followUpQueue.messages` 只读依赖隔离在单一边界，结构不兼容时在清空前报错。SDK 的纯文本 getter 和单批 `peekQueuedMessages()` 不能用于移回；以真实队列为准，避免重复移回已 drain 的消息。升级 SDK 必须复核此适配器并运行其集成测试。
- SDK 在真实入队之前广播 `queue_update`，wrapper 延迟到 microtask 读取完整队列；用户 `message_start` 也同步实际队列，覆盖纯图片消息无法被 SDK 文字匹配移除的情况。

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- `AppShell` owns the `/api/agent/running` poll every 2.5 seconds while the tab is visible and pauses it in background tabs. This poll is the only running-session state source; `/api/sessions` must not write a second running snapshot into it.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Running-session polling preserves the existing `Set` reference when ids are unchanged, so the 2.5-second poll does not rerender the full sidebar tree. Streaming assistant deltas are applied in order through a frame batcher; `message_end`/terminal paths flush first, and session switches reset queued deltas.
- `/api/sessions` scans every session file and is not a running-state transport. Agent refresh requests are coordinated at `AppShell` scope so they survive `ChatWindow` remounts: a new session publishes once when its first user message is persisted, then its settled refresh waits up to five seconds and is replaced by a title refresh when that arrives. Existing-session completion remains gated by `settleRun` inside the current mount; never persist its component-local run id in the AppShell coordinator. Never refresh the full list on every `message_end`, non-terminal `agent_end`, or Git-context success.

### Unfinished tool call auto-recovery
- The SDK's `agent_end` event carries the full message array (`messages`) and a `willRetry` flag. `AgentSessionWrapper` caches those and checks them at `agent_settled` (the true idle boundary).
- If the last assistant message contains a `toolCall` without a matching `toolResult`, the tool execution was interrupted mid-flight; the wrapper sends one `followUp` asking the model to finish that call (`findUnfinishedToolCall` in `lib/rpc-manager.ts`).
- Auto-recovery is skipped when the user aborted (`stopReason=aborted`), the response errored (`stopReason=error`), or the SDK will retry (`willRetry`). Per user prompt it runs at most `MAX_AUTO_CONTINUE_TURNS` (3) times and never twice for the same tool call id (no-progress guard).
- The UI is informed via `auto_continue` / `auto_continue_stopped` SSE events (`useAgentSession` turns them into notices). This is deliberately a native-signal-only guard — it never depends on `todo`/`/goal` extension state, and it does not auto-continue ordinary `stop` responses that the model ended on purpose.

### Session title generation uses an independent file-level agent
- Manual auto-naming creates an `operationId` in `AppShell` before opening SSE, then `lib/session-title-operation-client.ts` sends it to `POST /api/sessions/[id]/auto-name`. The route echoes it on `session_title_updated` / `session_title_error`; the client accepts only the matching session, operation, and complete discriminated-union payload, so concurrent tabs and queued requests cannot consume each other's terminal events. One overall deadline covers SSE connection, POST, response parsing, and terminal-event waiting; expiry aborts fetch and closes SSE. The route delegates generation to `generateTitleForSessionFile(filePath, { overwrite: true })`, whose independent SDK services and transport are safe while the main session is streaming.
- The route only resolves the session, submits work, and broadcasts `session_title_updated` / `session_title_error` over the session SSE stream. `lib/session-title-task-coordinator.ts` owns scheduling by stable session id: ordinary callers share work, and overwrite requests share only when their captured name baseline matches. For HMR, `globalThis` stores only the plain task `Map`; every module load creates a current coordinator with current dependencies over that shared registry, so in-flight work survives without freezing old class methods or runners. Deferred-Promise tests cover deduplication, queue order, path migration, manual-rename cancellation, successor creation, cross-generation runner replacement, identity-guard cleanup, and failure cleanup.
- `generateSessionTitle(source, signal?)` in `lib/session-title.ts` supports cancellation and a 90 s timeout. It builds a bounded plain-text transcript from user turns and brief assistant replies, omitting tool results and large payloads; it sends a standalone request through the source agent transport without mutating its session state.

### File-level title generation (manual + automatic + trash + bulk) does not create RPC sessions
- `generateTitleForSessionFile(filePath, options?)` in `lib/session-file-title.ts` titles any session `.jsonl` (active or trashed) without building an `AgentSessionWrapper`: it creates SDK services + an `AgentSession` directly, runs `generateSessionTitle`, then appends a `session_info` entry. The write goes through `lib/session-info-writer.ts`: when a live wrapper owns that file, the entry is appended through **its** `SessionManager` (SDK updates memory and disk together, so pi-web's own write can never look like an external modification — a file-level `SessionManager` append left the live wrapper one entry behind and made every `/context` of a running session answer 409). Without a live wrapper the fresh `SessionManager` path runs as before, keeping the session-id and name compare-and-set checks, so a PATCH/RPC manual rename made while generation is running wins; a name-baseline mismatch against a live wrapper abandons the write instead of falling back to the file path. By default existing names and sessions without user messages are skipped; `{ overwrite: true }` is reserved for explicit manual regeneration.
- The same rule applies to `PATCH /api/sessions/[id]` (manual rename): it prefers the live wrapper's `SessionManager` and only opens a fresh one when no wrapper owns the file. `AgentSessionWrapper.appendSessionInfoName()` is that write path.
- **Automatic first-round naming**: `AgentSessionWrapper.maybeAutoTitleSession()` (triggered once per wrapper at `agent_settled`, guarded by `autoTitleTriggered`) fires `generateTitleForSessionFile` on the session file. Because that path uses its own services/transport, it is safe to run right after the main run settles; success broadcasts `session_title_generated` over SSE, which `useAgentSession` turns into a sidebar list refresh. Sessions that already have a name are skipped, so existing sessions are untouched.
- Deleting a session (`DELETE /api/sessions/[id]`) fire-and-forgets `queueTrashSessionTitle(trashedName)`; the trash list reads the generated name from a tail scan of the file (`readTrashedSessionName` in `lib/trash.ts`, fallback first user message) so restored sessions keep their title.
- Bulk backfill lives in `lib/bulk-title.ts` (`POST/GET/DELETE /api/titles/bulk`, no UI button — it was requested as a one-off backfill and the button was later removed, but the API remains for curl-triggered runs). It snapshots trash + all active sessions and processes its list sequentially. All callers share the global title-task registry; delete/restore path changes migrate the task target while the stable session id remains the scheduling key.

### Sidebar order and Pin synchronization
- `lib/sidebar-preference-state.ts` 是项目/会话排序与会话 Pin 的共享纯归约器；目录不再提供 Pin 按钮或保存 Pin 状态。服务端与客户端乐观更新必须使用同一归约器。
- `lib/sidebar-preferences.ts` persists versioned state in `~/.pi/agent/pi-web-sidebar-preferences.json`; PATCH actions use `withPrivateFileLock()` plus revision conflict detection. `lib/project-directories.ts` uses the same lock helper for atomic multi-browser membership changes. Clients rebase and retry once after a `409`.
- `hooks/useSidebarNavigation.ts` composes the two client synchronization boundaries: `useSidebarPreferences` owns versioned order/Pin state, while `useProjectDirectories` owns serialized directory membership GET/POST/DELETE and focus refresh. Remote membership removals flow into explicit, idempotent preference-removal actions. Do not expose raw directory setters or reintroduce localStorage order/Pin hooks.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### HTML preview renders the file as a document
- 文件监听的连接状态与文件版本独立：`meta` 和 `change` 共用 `getFileWatchVersion()` 的文件标识、大小及修改时间版本；`useFileWatch` 重连只核对版本，版本未变时不得递增 `bust` 或重置预览。隐藏/重开面板及页面回到前台应保留 HTML 输入、选择和滚动状态，暂停期间的同大小编辑、替换和删除仍需使旧预览失效。
- `.html`/`.htm` open in Preview by default. The iframe's `src` is the document route `/api/files/raw/<absolute path>` (path segment, not `srcDoc` and not `?type=raw`) so the page's own relative references — sibling stylesheets, scripts, and images — resolve to sibling files. Subresource requests drop the query string, which is why the mode lives in the path.
- That document stays under `sandbox="allow-scripts"` plus a `Content-Security-Policy: sandbox allow-scripts` response header, so page script always runs in an opaque origin and cannot reach Pi Web's session. Preview stays read-only: POST, `fetch`/XHR, and every other route must keep failing for it.
- A sandboxed frame is an opaque origin, so the browser marks its requests `cross-site` and the origin guard in `lib/request-security.ts` rejects them. `isSandboxedPreviewAssetRequest()` is the single, deliberately narrow exception: GET + `Sec-Fetch-Dest` in {style, script, image, font, audio, video} + the `/api/files/raw/` prefix. Do not widen it, and do not add `allow-same-origin` to the preview iframe.
- 开启密码登录时，`lib/html-preview-auth.ts` 在已通过文件授权的 HTML raw 入口签发 24 小时目录凭据，并重定向到 `/api/files/raw/~preview-<credential>/<absolute path>`；路径中的凭据随相对资源 URL 保留，解决不透明沙盒不发送 `SameSite=Lax` 登录 Cookie 的问题。proxy 只接受带有效目录凭据的既有静态子资源请求，raw 分支共用凭据校验并保留原文件授权；凭据同时受真实路径限制，不能用于登录、fetch/XHR、写请求或目录外符号链接。不得通过关闭登录、放宽 Cookie 或增加 `allow-same-origin` 绕过。
- `getInlineFileMime()` in `lib/file-types.ts` picks the Content-Type for inline file responses; a stylesheet or script served with the wrong type is refused by the browser. `RAW_FILE_PATH_SEGMENT` in `lib/request-security.ts` is the shared name of that route prefix.
### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Dev servers (launch.json + host-owned processes)
- `lib/dev-server-manager.ts` owns every dev server process in `globalThis.__piWebDevServers`, keyed by project cwd — not by an AgentSession, so a server outlives the session that started it (idle disposal, reload) and the panel and later sessions see the same list. Processes are spawned as their own process group and stopped by signalling the group; `npm run dev` otherwise leaves its child holding the port.
- Servers are declared in `.pi/launch.json`, then `.claude/launch.json` (Claude Code's format, so one file serves both; `.pi` wins on a name clash). `lib/dev-server-config.ts` validates entries; a command entry needs a `port`, an entry with only `url` attaches to an outside server and is never killed.
- `lib/dev-server-extension.ts` is a hidden inline extension registering `server_start` / `server_list` / `server_logs` / `server_stop`. The model learns the launch file from the tool description and `promptGuidelines` — no system-prompt edits. Start/stop re-check at call time that bash (or powershell) is active and the switch is on, so they add no capability beyond the shell tool.
- The Settings › General switch is stored in `~/.pi/agent/pi-web-dev-servers.json`, defaults on, and fails closed on a damaged file. Off registers no tools (applies on reload) and does not stop running servers; the bottom-bar entry stays while the project has servers.
- UI: `DevServersShelf` sits in `ExtensionStatusBar`'s `leading` slot, so it appears only in an open conversation, never on the new-session welcome page. It renders when the project has a server this pi-web process started (running or finished) or its launch file has errors (the trigger then carries a red dot); a launch file that is valid but never ran does not show it (declared servers are listed inside once it is shown). A bar with only that slot hides itself via `:has()` when the shelf renders nothing. Previews are `server:<id>` overlay tabs (`components/overlay-tabs.ts`) sharing the subagent tab slot; `DevServerViewer` frames the URL (host swapped to the page's host for LAN access, `allow-same-origin` dropped if it would share Pi Web's origin) or shows logs.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `false` when the file or field is absent. Malformed settings fail closed; atomic updates preserve unknown fields.
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Global attention notifications
- `lib/attention-events.ts` publishes normalized ask/dialog/custom events to the app-level SSE subscription. The upstream `ExtensionUiRequest` protocol does not carry a source tool-call id, so select/input suppression while an ask is active is deliberately a **session-level heuristic**, not exact origin matching. It prevents duplicate ask notifications but may suppress an unrelated concurrent select/input notification in the same session. Do not claim exact matching or patch SDK tool internals; exact matching requires an upstream origin field propagated by the extension and SDK UI protocol.
- `AppShell` owns the running-session snapshot and `useRunningSessionTransitions`; `useBackgroundCompletionNotifications` consumes completed transitions, while `SessionSidebar` only receives the current snapshot/transitions for unread markers and list refreshes. `lib/running-session-transitions.ts` owns the pure diff.
- `hooks/useSessionNotifications.ts` is the composition boundary for browser notifications and the in-app floating queue. `useCompletionNotification` publishes the in-app intent before applying browser permission/enabled gates, then remains responsible for system delivery; `useFloatingSessionNotifications` owns per-session deduplication, manual dismissal, and clearing when the session becomes active. Completion effects set `showWhenActive` so the session being viewed still gets a completion popup; attention events omit it and remain background-only. Keep the queue and rendering out of `AppShell`.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### PWA 版本与 Service Worker 更新策略
- 当前合并版本使用 `0.10.0-merge.43`；此后每次代码变更都必须将最后一位递增 1，并同步更新 `package.json` 与 `package-lock.json`。
- 生产环境必须使用每次构建唯一的版本标识注册 `/sw.js?v=<build-version>`，静态缓存名称也必须包含同一个版本；不能只使用长期不变的 `package.json` 版本，否则代码变化后浏览器可能继续命中旧 chunk。
- 新 Service Worker 安装完成后保持 `waiting`，由界面提示“发现新版本”；用户确认后发送 `SKIP_WAITING`，并在 `controllerchange` 后刷新页面。不要在 `install` 阶段无条件调用 `skipWaiting()`。
- 激活新 Service Worker 时只清理 `pi-web-` 前缀下的旧版本缓存，不得清理其它站点数据或认证信息。`/sw.js`、页面导航和 API 请求必须绕过静态资源缓存。
- 开发环境不注册 Service Worker，并在 Next 客户端代码加载前注销同源旧注册、删除 `pi-web-` 缓存；清理完成后若页面仍被旧 worker 控制，只自动重载一次，避免刷新循环。
- 重启 8081 的 Node/Next.js 进程不会注销浏览器中的 Service Worker。已有标签页或独立 PWA 窗口可能继续由旧 worker 控制，必须让页面重新加载并执行清理逻辑；必要时关闭该同源的全部页面后重新打开。

### CI 工作流（fork 本地差异）
- `demo-pages.yml` 在本 fork 只由 PR 与手动触发运行，已移除 push 触发：fork 未启用 GitHub Pages，push 触发会让 `actions/configure-pages` 必然失败。合并上游时不要恢复该 push 触发。
- 上游 e2e 用例与它对应的产品改动必须成对合并。本 fork 重写了 `MarkdownBody`/`MermaidBlock`/`AppShell`/`run.mjs` 等文件，上一轮合并只带进了上游用例而丢掉了实现，CI 因此变红。三个已知配套点：`CodeHighlight.tsx` 与 `MermaidBlock.tsx` 的代码块背景必须用 `backgroundColor`（不能与 Prism 主题的 `background` 简写混用）；`AppShell` 根部必须挂 `useTheme()`，否则系统配色切换不生效；`extension-dialog.mjs` 的通知断言要按通知架可能同时保留同文案通知来写。
- 同一类合并丢失还发生在提及链路上：`AppShell` 给 `FileViewer` 传的 `onAtMention={handleAtMention}` 是整文件提及（无选区时的 `@` 按钮）的唯一入口，`handleAtMention`/`handleAtMentions`/`handleFileLineMention` 三个回调还需在移动端回到输入框。`e2e/file-panel.mjs` 断言这条链路的输入框取值与面板开关，合并 `AppShell` 后必须保持通过。

### 上游合并取舍（v0.11.0 起）
- 侧栏保留 fork 实现（ProjectSection、sidebar-preferences 同步、回收站、会话搜索）。上游 v0.11.0 的侧栏重设计（`session-ui-state`、分组/归档/项目置顶、行菜单 Fork、新会话项目栏 `NewSessionContextBar`/`ProjectWorktreePicker`）及依赖它的后续功能均未合入，合并时对这些新文件按删除处理，需要时单独移植。
- fork 早期以 squash 方式整合上游，合并基线之前的上游改动可能从未进入 fork，三方合并会把它们当作“fork 已删除”静默丢弃。合并时对基线已有、fork 缺失的上游功能要逐个确认，例如本次补回的 Service Worker 导航/静态资源 8s 首字节超时（上游 #879）。
- 上游与 fork 都实现过的功能，按以下结论合并，后续合并不要重新引入另一套：
  - 会话目录变化：`lib/session-list-scanner.ts` 采用上游 v0.12.2 版本（尾部续读 #1259、成员检查 #1100、延后写索引）。fork 原有的 recursive `fs.watch` 增量 stat 从未被启用（`trustWatcher` 无调用方），已随之移除，`session-reader.ts` 不再导出 `invalidateSessionDirectorySnapshot`。
  - 旧消息分页：fork 的 `loadEarlierMessages` 在同一次 `setHistoryPage` 中提交游标和 `loading`，并拒绝重复 entryId，上游 d474ce2 的重复前插问题不存在，未移植。
  - 新会话首条消息：fork 在发送途中切走会话时拒绝发送并通过 `setDraft` 保留草稿，上游 e7d0fda（切走后照常发送）未移植。
  - 通知：fork 的 NoticeShelf 收起时单行居中，上游 d850be1 不适用；终端二维码（#755）按 `splitNoticeText` 以 `.notice-shelf-art` 渲染。
  - 回合最终回答的拆分副本通过 `lib/turn-views.ts` 按原消息缓存（#1005），不要在渲染中重新 `withAssistantBlocks`。
  - 流式 markdown（上游 a952ed5 `markdown-blocks`）：保留 fork 的 `streaming-markdown-blocks`。实测 2.1 万字符的回复，只要正文里有一个行内 HTML（如 `<kbd>`），上游切分就整体失效，每帧平均重解析约 1.1 万字符；fork 平均约 220 字符，且未闭合围栏走纯文本快路径。无 HTML 时两者相当。MarkdownBody 额外整体 memo。
  - 流式渲染范围（上游 e8d91ef `StreamingStore`）：已移植外部 store，继续使用 fork 按帧合并的增量；`StreamingReply` 单独订阅正文，ChatWindow 只订阅流式状态和块数，块增删时更新 fork 的运行中过程窗口。ChatInput/ChatMinimap 保持 memo，minimap 测量通过稳定 getter 读取当前回复。message_end 仍先 flush，再追加完成消息并清空 store；会话切换继续 reset 帧队列，旧 run 事件仍在原入口拒绝。`TextBlock` 直接渲染当前 `block.text`，仅按需加载的完整正文进入 state，稳定 key 不得冻结流式文字。
  - Prism 按需加载（上游 046bc67）：聊天代码块保留 fork 按语言拆分的 `lib/prism-languages.ts`；文件查看器仍用完整 Prism，因为服务端识别的语言多于按需加载表。代码块接入上游 `lib/highlight-queue.ts` 的高亮预算：同一任务内超出预算的代码块先纯文本显示，空闲时由新到旧补上高亮。
  - HTML 大文件预览（上游 93b3aba）：fork 的预览走 `/api/files/raw/` 文档路由，不受 256 KB 分块限制，未移植。
  - 删除项目全部会话（上游 c8182b1 `session-delete`、`/api/sessions/delete`）：fork 侧栏已有“移除项目并删除会话”，删除路径保留 fork 的回收站与级联改写登记，未合入。
- 子代理查看采用上游 SubagentViewer：`AppShell` 的 `agentTabs` 与文件、终端标签并列，激活时与终端互斥地覆盖文件标签，关闭时按终端、子代理、文件的顺序选择下一个；切换项目时丢弃子代理标签。MessageView 的回调为 `onOpenSubagent(sessionId, label)`，不再跳转主会话。
- 文件标签按项目暂存（上游 d69b33e）：`useFilePanel.switchWorkspace()` 在 `handleCwdChange` 的项目切换处调用，查看器状态按 `workspaceGeneration` 回写到所属项目；激活中的终端在切换后继续占用面板。
- 侧栏的“等待输入”来自 `/api/agent/running` 的 `awaitingInputSessionIds`（运行中且有阻塞型扩展 UI 请求），`SessionItem` 用琥珀色呼吸圆点替换运行动画，其余仍按运行中处理。
- 会话行在桌面端用 Ctrl/Cmd/Shift/Alt 点击或中键点击时，以 `lib/session-links.ts` 的 `?session=` 链接在新标签页打开；URL 链接的会话已不存在时，侧栏采用的项目保持空白新会话，不恢复其上次打开的会话（#1168）。
- 运行期间 ChatWindow 通过 `useAudio().holdAudio()` 保持提示音的 AudioContext 运行，空闲时自动挂起（#1157）。
- `display: false` 的自定义消息与 pi TUI 一致完全不渲染（ChatWindow 跳过且不计入过程详情，MessageView 入口兜底），不再显示“隐藏的扩展消息”卡片。
- CLI 的 `version/status/stop/open` 来自上游；`pi-web update` 在 fork 中禁用，只打印 fork Release 与 `scripts/macos-service.sh` 的更新方式，绝不执行 `npm install -g @agegr/pi-web`。
- 消息 key（上游 #1184）：`lib/message-keys.ts` 的别名在 `useAgentSession.commitContextSnapshot()` 统一计算，ChatWindow 的消息、过程分组和分组 Fragment 都按 `messageKeys` 取 key，MessageView 的块按位置取 key。fork 读取器与上游有两处差异，测试已按 fork 行为调整：历史用户图片被换成按需加载的 URL，所以用户消息只比较文字和图片类型；压缩摘要按 SDK 上下文投影放在最前，运行中途压缩后本轮消息改用各自的 entry id。
- 延迟 provider 的启动模型切换（#1240）在 fork 中仍在扩展绑定后于后台执行，通过 `trackStartupModelSwitch()` 登记可重试操作。`whenExtensionsBound()` 不带请求期限；单次 finalize/prompt 的等待超时只拒绝请求，后台审批、切模和目录发现继续执行，不得写入 `extensionsError`。真实切模失败才持久保留错误并阻止发送；显式 `finalize-existing` 重试复用同一个 runtime，且并发重试共享一次切换。手动偏好与启动切换在 wrapper 内串行提交：成功手动选模会解除错误并废弃旧启动目标，旧任务不得再覆盖模型或写回错误；失败的手动选择不取消初始化。仅调整强度时仍初始化目标模型，并在切模后恢复用户原始请求的强度，不能继承占位模型的限幅结果。
- 生产 `npm start` / `start:lan` 与 macOS 服务统一通过 `bin/pi-web.js` 启动；必须在 Next 读取 prerender manifest 前轮换 preview 密钥，轮换失败拒绝启动，避免公开构建包中的 preview id 绕过 proxy 登录校验。
- 上游 v0.12.2 的回合耗时（#1222）、缓存与费用提示（#1265，设置 › 常规开关）、过程折叠摘要、长思考分段渲染（#1196）、代理切换器的用量和子代理标签开关、技能文档相对链接（`MarkdownBody` 的 `onNavigateLink` 经 ref 读取，保持块级 memo 命中）、终端主题和新主题已移植；上游侧栏相关的文档段落未合入。
