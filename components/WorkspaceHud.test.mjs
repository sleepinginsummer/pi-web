import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { JSDOM } from "jsdom";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { WorkspaceHud, parseTodoWidgetLines } = await jiti.import("./WorkspaceHud.tsx");
const { ComposerContextPill } = await jiti.import("./ComposerContextPill.tsx");
const { countSessionFileMutations } = await jiti.import("@/lib/session-artifacts");

test("parseTodoWidgetLines strips ANSI and parses completed, in_progress, and pending items", () => {
  const widget = {
    key: "rpiv-todos",
    placement: "aboveEditor",
    lines: [
      "● Todos (1/3)",
      "├─ \u001b[32m✓\u001b[0m Finished step",
      "├─ ◐ Working step",
      "└─ ○ Queued step",
    ],
  };
  const items = parseTodoWidgetLines(widget);
  assert.deepEqual(items, [
    { status: "completed", text: "Finished step" },
    { status: "in_progress", text: "Working step" },
    { status: "pending", text: "Queued step" },
  ]);
});

test("WorkspaceHud renders folded sections with dedicated Servers row and no Context/Terminal sections", () => {
  const git = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "feat/workspace-hud",
      isWorktree: true,
      branches: ["main", "feat/workspace-hud"],
    },
    status: {
      isGitRepository: true,
      repositoryRoot: "/repo",
      files: [
        { filePath: "/repo/components/WorkspaceHud.tsx", status: "added", code: "A", indexStatus: "A", worktreeStatus: " " },
      ],
      additions: 120,
      deletions: 15,
    },
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: true }; },
  };

  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(WorkspaceHud, {
        cwd: "/repo/.worktrees/workspace-hud",
        sessionId: "00000000-0000-0000-0000-000000000001",
        isNewSession: false,
        git,
        worktrees: [
          { path: "/repo", branch: "main", isMain: true },
          { path: "/repo/.worktrees/workspace-hud", branch: "feat/workspace-hud", isMain: false },
        ],
        artifacts: [
          { id: "file:/repo/docs/spec.md", kind: "doc", name: "spec.md", path: "/repo/docs/spec.md" },
        ],
        todoWidget: {
          key: "rpiv-todos",
          placement: "aboveEditor",
          lines: ["● Todos (1/2)", "├─ ✓ First", "└─ ○ Second"],
        },
        onSwitchBranch: async () => ({ ok: true }),
        onSelectWorktree() {},
        onOpenFileDiff() {},
        onOpenArtifactFile() {},
        onHideArtifact() {},
        onDeleteArtifactFile: async () => ({ ok: true }),
      }),
    ),
  );

  assert.match(html, /workspace-hud-card/);
  assert.match(html, /feat\/workspace-hud/);
  assert.match(html, /workspace-hud/);
  assert.match(html, /\+120/);
  assert.match(html, /-15/);
  assert.match(html, /Changed files/);
  assert.match(html, /Session artifacts/);
  assert.match(html, /spec\.md/);
  assert.match(html, /Servers/);
  assert.match(html, /Background &amp; Scheduled/);
  assert.match(html, /Todo list/);
  assert.match(html, /1\/2/);
  // 确认不包含已移除的上下文与终端区块
  assert.doesNotMatch(html, /上下文与用量/);
  assert.doesNotMatch(html, /网页终端/);
});

test("ComposerContextPill renders folder, branch, and worktree triggers in one frosted pill", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ComposerContextPill, {
        cwd: "/repo/.worktrees/hud",
        isNewSession: true,
        git: {
          branches: {
            isGit: true,
            projectRoot: "/repo",
            currentBranch: "feat/hud",
            isWorktree: true,
            branches: ["main", "feat/hud"],
          },
          status: null,
          loading: false,
          switchingBranch: false,
          error: null,
          refresh() {},
          async switchBranch() { return { ok: true }; },
        },
        worktrees: [
          { path: "/repo", branch: "main", isMain: true },
          { path: "/repo/.worktrees/hud", branch: "feat/hud", isMain: false },
        ],
      }),
    ),
  );

  assert.match(html, /composer-context-pill/);
  assert.match(html, /feat\/hud/);
  assert.match(html, /Select worktree/);
  assert.match(html, /Switch Git branch/);
});


test("WorkspaceHud and ComposerContextPill disable branch switching when canSwitch is false", () => {
  const readonlyGit = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "main",
      isWorktree: false,
      branches: ["main", "feat/other"],
      canSwitch: false,
    },
    status: null,
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: false, error: "Access denied" }; },
  };

  const pillHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ComposerContextPill, {
        cwd: "/repo/sub",
        isNewSession: true,
        git: readonlyGit,
      }),
    ),
  );
  assert.match(pillHtml, /<button type="button" disabled="" class="composer-context-item"[^>]*aria-label="Switch Git branch"/);
  assert.match(pillHtml, /main/);

  const hudHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(WorkspaceHud, {
        cwd: "/repo/sub",
        sessionId: "00000000-0000-0000-0000-000000000002",
        isNewSession: false,
        git: readonlyGit,
        worktrees: [],
        artifacts: [{ id: "file:/repo/sub/out.md", kind: "doc", name: "out.md", path: "/repo/sub/out.md" }],
        onSwitchBranch: async () => ({ ok: false, error: "Access denied" }),
        onSelectWorktree() {},
        onOpenFileDiff() {},
        onOpenArtifactFile() {},
        onHideArtifact() {},
        onDeleteArtifactFile: async () => ({ ok: true }),
      }),
    ),
  );
  assert.match(hudHtml, /<button type="button" disabled="" class="workspace-hud-trigger" title="main">/);
});


test("WorkspaceHud defaults to collapsed on new session even with pre-existing git changes, and renders pill on mobile", () => {
  const dirtyGit = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "main",
      isWorktree: false,
      branches: ["main", "feat/demo"],
      canSwitch: true,
    },
    status: {
      isGitRepository: true,
      repositoryRoot: "/repo",
      files: [{ filePath: "/repo/a.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
      additions: 10,
      deletions: 2,
    },
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: true }; },
  };

  const newSessionHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(WorkspaceHud, {
        cwd: "/repo",
        isNewSession: true,
        git: dirtyGit,
        worktrees: [
          { path: "/repo", branch: "main", isMain: true },
          { path: "/repo-wt", branch: "feat/demo", isMain: false },
        ],
        artifacts: [],
        onSwitchBranch: async () => ({ ok: true }),
        onSelectWorktree() {},
        onOpenFileDiff() {},
        onOpenArtifactFile() {},
        onHideArtifact() {},
        onDeleteArtifactFile: async () => ({ ok: true }),
      }),
    ),
  );
  assert.match(newSessionHtml, /workspace-hud-collapsed/);
  assert.doesNotMatch(newSessionHtml, /workspace-hud-anchor is-expanded/);

  const mobileHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(WorkspaceHud, {
        cwd: "/repo",
        isNewSession: false,
        isMobile: true,
        git: dirtyGit,
        worktrees: [{ path: "/repo", branch: "main", isMain: true }],
        artifacts: [{ id: "file:/repo/a.md", kind: "doc", name: "a.md", path: "/repo/a.md" }],
        onSwitchBranch: async () => ({ ok: true }),
        onSelectWorktree() {},
        onOpenFileDiff() {},
        onOpenArtifactFile() {},
        onHideArtifact() {},
        onDeleteArtifactFile: async () => ({ ok: true }),
      }),
    ),
  );
  assert.match(mobileHtml, /workspace-hud-pill-btn/);
  assert.match(mobileHtml, /workspace-hud-anchor is-pill/);
});


async function withHudDom(t, renderInitial) {
  const { window } = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  const { document } = window;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const container = document.querySelector("#root");
  const root = createRoot(container);
  t.after(async () => {
    await React.act(() => root.unmount());
    window.close();
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  const render = async (props) => {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(WorkspaceHud, props)));
    });
  };
  await render(renderInitial);
  return { container, render };
}

function makeStubSharedPolling(servers = []) {
  return {
    sharedDevServers: {
      data: { servers, configs: [] },
      error: null,
      pending: new Set(),
      async refresh() {},
      async start() {},
      async stop() {},
      async dismiss() {},
    },
    sharedScheduled: {
      data: { tasks: [] },
      error: null,
      pending: new Set(),
      async refresh() {},
      async toggle() {},
      async remove() {},
    },
    sharedBackground: {
      data: { commands: [] },
      error: null,
      pending: new Set(),
      async refresh() {},
      async stop() {},
      async dismiss() {},
    },
  };
}

test("new session auto-expands on equal-line-count edit of an already-dirty file even when git stats stay unchanged", async (t) => {
  const sameDirtyGit = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "main",
      isWorktree: false,
      branches: ["main"],
      canSwitch: true,
    },
    status: {
      isGitRepository: true,
      repositoryRoot: "/repo",
      files: [{ filePath: "/repo/a.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
      additions: 1,
      deletions: 1,
    },
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: true }; },
  };
  const baseProps = {
    cwd: "/repo",
    sessionId: null,
    isNewSession: true,
    git: sameDirtyGit,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
    artifacts: [],
    sessionMutationCount: 0,
    onSwitchBranch: async () => ({ ok: true }),
    onSelectWorktree() {},
    onOpenFileDiff() {},
    onOpenArtifactFile() {},
    onHideArtifact() {},
    onDeleteArtifactFile: async () => ({ ok: true }),
    ...makeStubSharedPolling([]),
  };

  const { container, render } = await withHudDom(t, baseProps);
  // 1. 新会话默认收起（即使已有脏文件 a.ts +1/-1）
  assert.ok(container.querySelector(".workspace-hud-collapsed"));
  assert.equal(container.querySelector(".workspace-hud-anchor.is-expanded"), null);

  // 2. 发出首条消息（isNewSession -> false），尚未发生编辑，保持收起
  await render({ ...baseProps, isNewSession: false, sessionId: "sess-equal-edit", sessionMutationCount: 0 });
  assert.ok(container.querySelector(".workspace-hud-collapsed"));
  assert.equal(container.querySelector(".workspace-hud-anchor.is-expanded"), null);

  // 3. 本会话通过 replace 等行数修改了已脏的 a.ts：Git 统计仍是 M / +1/-1，artifacts 仍为空，
  //    但 sessionMutationCount 变为 1，浮卡应自动展开
  await render({ ...baseProps, isNewSession: false, sessionId: "sess-equal-edit", sessionMutationCount: 1 });
  assert.ok(container.querySelector(".workspace-hud-anchor.is-expanded"));
  assert.equal(container.querySelector(".workspace-hud-collapsed"), null);
});

test("pre-existing running project dev server does not prematurely expand a new session; newly started/restarted server does", async (t) => {
  const cleanGit = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "main",
      isWorktree: false,
      branches: ["main"],
      canSwitch: true,
    },
    status: {
      isGitRepository: true,
      repositoryRoot: "/repo",
      files: [],
      additions: 0,
      deletions: 0,
    },
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: true }; },
  };
  const preExistingServer = {
    id: "srv-1",
    name: "web",
    projectCwd: "/repo",
    cwd: "/repo",
    status: "running",
    managed: true,
    startedAt: 1000,
  };
  const baseProps = {
    cwd: "/repo",
    sessionId: null,
    isNewSession: true,
    git: cleanGit,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
    artifacts: [],
    sessionMutationCount: 0,
    onSwitchBranch: async () => ({ ok: true }),
    onSelectWorktree() {},
    onOpenFileDiff() {},
    onOpenArtifactFile() {},
    onHideArtifact() {},
    onDeleteArtifactFile: async () => ({ ok: true }),
    ...makeStubSharedPolling([preExistingServer]),
  };

  const { container, render } = await withHudDom(t, baseProps);
  // 1. 项目已有运行中服务器，新会话阶段保持收起
  assert.ok(container.querySelector(".workspace-hud-collapsed"));
  assert.equal(container.querySelector(".workspace-hud-anchor.is-expanded"), null);

  // 2. 首次发送消息（isNewSession -> false），同一旧服务器仍在运行，不应误判为本会话活动而展开
  await render({ ...baseProps, isNewSession: false, sessionId: "sess-server-baseline" });
  assert.ok(container.querySelector(".workspace-hud-collapsed"));
  assert.equal(container.querySelector(".workspace-hud-anchor.is-expanded"), null);

  // 3. 旧服务器停止也不应触发自动展开
  await render({
    ...baseProps,
    isNewSession: false,
    sessionId: "sess-server-baseline",
    ...makeStubSharedPolling([{ ...preExistingServer, status: "stopped" }]),
  });
  assert.ok(container.querySelector(".workspace-hud-collapsed"));

  // 4. 随后重新启动或新启动服务器实例（startedAt 变化），浮卡自动展开
  await render({
    ...baseProps,
    isNewSession: false,
    sessionId: "sess-server-baseline",
    ...makeStubSharedPolling([{ ...preExistingServer, status: "running", startedAt: 2000 }]),
  });
  assert.ok(container.querySelector(".workspace-hud-anchor.is-expanded"));
  assert.equal(container.querySelector(".workspace-hud-collapsed"), null);
});


test("new session auto-expands when a nested edit succeeds inside a failed codemode script with unchanged git stats", async (t) => {
  const sameDirtyGit = {
    branches: {
      isGit: true,
      projectRoot: "/repo",
      currentBranch: "main",
      isWorktree: false,
      branches: ["main"],
      canSwitch: true,
    },
    status: {
      isGitRepository: true,
      repositoryRoot: "/repo",
      files: [{ filePath: "/repo/a.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }],
      additions: 1,
      deletions: 1,
    },
    loading: false,
    switchingBranch: false,
    error: null,
    refresh() {},
    async switchBranch() { return { ok: true }; },
  };
  const baseProps = {
    cwd: "/repo",
    sessionId: null,
    isNewSession: true,
    git: sameDirtyGit,
    worktrees: [{ path: "/repo", branch: "main", isMain: true }],
    artifacts: [],
    sessionMutationCount: 0,
    onSwitchBranch: async () => ({ ok: true }),
    onSelectWorktree() {},
    onOpenFileDiff() {},
    onOpenArtifactFile() {},
    onHideArtifact() {},
    onDeleteArtifactFile: async () => ({ ok: true }),
    ...makeStubSharedPolling([]),
  };

  const { container, render } = await withHudDom(t, baseProps);
  assert.ok(container.querySelector(".workspace-hud-collapsed"));

  await render({ ...baseProps, isNewSession: false, sessionId: "sess-nested-err", sessionMutationCount: 0 });
  assert.ok(container.querySelector(".workspace-hud-collapsed"));

  // 外层 codemode 因后续步骤报错返回 isError: true，但前面已成功执行 replace（status: "ok"），
  // 且已有脏文件 a.ts 的 Git 统计维持 M / +1/-1 不变
  const messages = [
    {
      role: "assistant",
      timestamp: 6000,
      content: [
        { type: "toolCall", toolCallId: "cm-1", toolName: "codemode", input: { code: "..." } },
      ],
    },
  ];
  const toolResults = new Map([
    [
      "cm-1",
      {
        role: "toolResult",
        toolCallId: "cm-1",
        toolName: "codemode",
        isError: true,
        content: [{ type: "text", text: "Error: later step failed" }],
        nestedCalls: {
          calls: [
            { id: "n1", name: "replace", arguments: { remove_from: "aaaaa", remove_to: "aaaaa", text: "y" }, status: "ok" },
            { id: "n2", name: "bash", arguments: { command: "exit 1" }, status: "error", error: "exit 1" },
          ],
        },
      },
    ],
  ]);
  const mutationCount = countSessionFileMutations(messages, toolResults);
  assert.equal(mutationCount, 1);

  await render({
    ...baseProps,
    isNewSession: false,
    sessionId: "sess-nested-err",
    sessionMutationCount: mutationCount,
  });
  assert.ok(container.querySelector(".workspace-hud-anchor.is-expanded"));
  assert.equal(container.querySelector(".workspace-hud-collapsed"), null);
});
