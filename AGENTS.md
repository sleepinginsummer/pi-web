# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

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
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
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
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
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
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts            shared TypeScript types
  normalize.ts        normalizeAssistantMessage() — normalizes toolCall field names and converts legacy <thinking> text blocks
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
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

### Session first-paint loading
- Existing sessions load `/api/sessions/[id]/context` first and commit messages immediately. `/details` (file path + projected branch tree) and `/state` use independent abort controllers and load afterward; details failures must not hide a valid context or runtime snapshot.
- Delayed details are identity-bound to the session id so an old tree cannot pair with a new leaf. `/details` must not read entries or build context.
- `ChatWindow` groups history into lightweight index descriptors, applies the visible window, and only then creates JSX. The window count is keyed by session id/cwd so a newly selected session cannot inherit an expanded history window from the previous session.

### Fork uses an independent file-level service
`AgentSession.fork()` mutates the active wrapper in-place, so pi-web does not call it. `lib/session-fork.ts` creates and validates the copied JSONL in an isolated staging directory, cleans staging before commit, then publishes to the real session directory with create-only atomic semantics. `rpc-manager.ts` only updates caches and returns the new id; it must not destroy or mutate the source wrapper, so persisted history can be forked while the source session is running.

### Two kinds of branching — don't confuse them
- **Fork** (“New session” on persisted user/assistant messages): creates a new independent `.jsonl` file. User-message forks stop before that message and prefill it as a draft; assistant-message forks include that response and completed tool results. Shown as a child in the sidebar tree via `parentSession`.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### Assistant message normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeAssistantMessage()` in `lib/normalize.ts` handles this and converts legacy assistant text blocks in the form `<thinking>...</thinking>` into native thinking blocks. It is called in both `session-reader.ts` (file load) and the SSE/agent-event handling logic in `hooks/useAgentSession.ts` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

### Session-level Shadow Mind toggle
The top bar Shadow switch controls only the current session. `lib/shadow-session-setting.ts` is the single source of truth: it persists `pi-web-shadow-mind-state` custom entries, restores disabled state after wrapper/runtime reload, serializes concurrent pause/resume requests with last-write-wins semantics, and treats a missing optional Shadow extension as unavailable instead of failing session startup. Both the top-bar control and Web `/shadow pause|resume` paths must use `set_shadow_mind_enabled`; never infer state from the extension status text or call the extension command through a second unpersisted path. Unsent sessions are keyed by cwd in `AppShell`; `lib/pending-new-session.ts` owns their reducer and exhaustive UI projection, while `lib/new-session-materialization-client.ts` deduplicates create/finalize requests across `ChatWindow` remounts. An explicit disabled preference is applied and persisted before the first prompt; the default enabled preference is omitted so a missing optional Shadow extension cannot block session creation. Post-start failures retain the real session id and retry the idempotent `finalize-existing` operation only after canonical cwd/session identity validation.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Unfinished tool call auto-recovery
- The SDK's `agent_end` event carries the full message array (`messages`) and a `willRetry` flag. `AgentSessionWrapper` caches those and checks them at `agent_settled` (the true idle boundary).
- If the last assistant message contains a `toolCall` without a matching `toolResult`, the tool execution was interrupted mid-flight; the wrapper sends one `followUp` asking the model to finish that call (`findUnfinishedToolCall` in `lib/rpc-manager.ts`).
- Auto-recovery is skipped when the user aborted (`stopReason=aborted`), the response errored (`stopReason=error`), or the SDK will retry (`willRetry`). Per user prompt it runs at most `MAX_AUTO_CONTINUE_TURNS` (3) times and never twice for the same tool call id (no-progress guard).
- The UI is informed via `auto_continue` / `auto_continue_stopped` SSE events (`useAgentSession` turns them into notices). This is deliberately a native-signal-only guard — it never depends on `todo`/`/goal` extension state, and it does not auto-continue ordinary `stop` responses that the model ended on purpose.

### Session title generation uses an independent file-level agent
- Manual auto-naming creates an `operationId` in `AppShell` before opening SSE, then `lib/session-title-operation-client.ts` sends it to `POST /api/sessions/[id]/auto-name`. The route echoes it on `session_title_updated` / `session_title_error`; the client accepts only the matching session, operation, and complete discriminated-union payload, so concurrent tabs and queued requests cannot consume each other's terminal events. One overall deadline covers SSE connection, POST, response parsing, and terminal-event waiting; expiry aborts fetch and closes SSE. The route delegates generation to `generateTitleForSessionFile(filePath, { overwrite: true })`, whose independent SDK services and transport are safe while the main session is streaming.
- The route only resolves the session, submits work, and broadcasts `session_title_updated` / `session_title_error` over the session SSE stream. `lib/session-title-task-coordinator.ts` owns scheduling by stable session id: ordinary callers share work, and overwrite requests share only when their captured name baseline matches. For HMR, `globalThis` stores only the plain task `Map`; every module load creates a current coordinator with current dependencies over that shared registry, so in-flight work survives without freezing old class methods or runners. Deferred-Promise tests cover deduplication, queue order, path migration, manual-rename cancellation, successor creation, cross-generation runner replacement, identity-guard cleanup, and failure cleanup.
- `generateSessionTitle(source, signal?)` in `lib/session-title.ts` still supports cancellation for direct callers and applies the title-run timeout (90 s). Its 256 KB / 60-message limit is explicitly an `AgentMessage` budget, not a hard limit for the final provider payload after system prompt, tool schema, and provider conversion. Messages are grouped by complete user turns; compacted-history prefixes that crowd out the first user are dropped, oversized assistant/tool tails are excluded, and a single oversized user is Unicode-safely truncated after accounting for the actual title instruction.

### File-level title generation (manual + automatic + trash + bulk) does not create RPC sessions
- `generateTitleForSessionFile(filePath, options?)` in `lib/session-file-title.ts` titles any session `.jsonl` (active or trashed) without building an `AgentSessionWrapper`: it creates SDK services + an `AgentSession` directly, runs `generateSessionTitle`, then appends a `session_info` entry through a freshly opened `SessionManager`. The write uses session-id and name compare-and-set checks, so a PATCH/RPC manual rename made while generation is running wins. By default existing names and sessions without user messages are skipped; `{ overwrite: true }` is reserved for explicit manual regeneration.
- **Automatic first-round naming**: `AgentSessionWrapper.maybeAutoTitleSession()` (triggered once per wrapper at `agent_settled`, guarded by `autoTitleTriggered`) fires `generateTitleForSessionFile` on the session file. Because that path uses its own services/transport, it is safe to run right after the main run settles; success broadcasts `session_title_generated` over SSE, which `useAgentSession` turns into a sidebar list refresh. Sessions that already have a name are skipped, so existing sessions are untouched.
- Deleting a session (`DELETE /api/sessions/[id]`) fire-and-forgets `queueTrashSessionTitle(trashedName)`; the trash list reads the generated name from a tail scan of the file (`readTrashedSessionName` in `lib/trash.ts`, fallback first user message) so restored sessions keep their title.
- Bulk backfill lives in `lib/bulk-title.ts` (`POST/GET/DELETE /api/titles/bulk`, no UI button — it was requested as a one-off backfill and the button was later removed, but the API remains for curl-triggered runs). It snapshots trash + all active sessions and processes its list sequentially. All callers share the global title-task registry; delete/restore path changes migrate the task target while the stable session id remains the scheduling key.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Global attention notifications
- `lib/attention-events.ts` publishes normalized ask/dialog/custom events to the app-level SSE subscription. The upstream `ExtensionUiRequest` protocol does not carry a source tool-call id, so select/input suppression while an ask is active is deliberately a **session-level heuristic**, not exact origin matching. It prevents duplicate ask notifications but may suppress an unrelated concurrent select/input notification in the same session. Do not claim exact matching or patch SDK tool internals; exact matching requires an upstream origin field propagated by the extension and SDK UI protocol.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### PWA 版本与 Service Worker 更新策略
- 生产环境必须使用每次构建唯一的版本标识注册 `/sw.js?v=<build-version>`，静态缓存名称也必须包含同一个版本；不能只使用长期不变的 `package.json` 版本，否则代码变化后浏览器可能继续命中旧 chunk。
- 新 Service Worker 安装完成后保持 `waiting`，由界面提示“发现新版本”；用户确认后发送 `SKIP_WAITING`，并在 `controllerchange` 后刷新页面。不要在 `install` 阶段无条件调用 `skipWaiting()`。
- 激活新 Service Worker 时只清理 `pi-web-` 前缀下的旧版本缓存，不得清理其它站点数据或认证信息。`/sw.js`、页面导航和 API 请求必须绕过静态资源缓存。
- 开发环境不注册 Service Worker，并在 Next 客户端代码加载前注销同源旧注册、删除 `pi-web-` 缓存；清理完成后若页面仍被旧 worker 控制，只自动重载一次，避免刷新循环。
- 重启 8081 的 Node/Next.js 进程不会注销浏览器中的 Service Worker。已有标签页或独立 PWA 窗口可能继续由旧 worker 控制，必须让页面重新加载并执行清理逻辑；必要时关闭该同源的全部页面后重新打开。

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
