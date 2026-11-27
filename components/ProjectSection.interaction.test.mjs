import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { PinnedSessionsSection, ProjectSection } = await jiti.import("./ProjectSection.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { sidebarProjectPath, groupSidebarProjects, resolveSidebarProjectMove, expandSidebarProject } = await jiti.import("@/lib/project-groups");
const { emptySidebarPreferences, orderProjectsByPreference, reduceSidebarPreferences } = await jiti.import("@/lib/sidebar-preference-state");

afterEach(cleanup);

function createProps(overrides = {}) {
  return {
    project: {
      path: "/repo",
      name: "repo",
      active: true,
      collapsed: false,
      isMobile: false,
      sessions: [],
      sessionOrder: [],
      ...overrides.project,
    },
    labels: {
      empty: "No sessions",
      remove: "Remove project",
      newSession: "New session",
    },
    actions: {
      onToggleCollapsed() {},
      onMove() {},
      onRemove() {},
      onNewSession() {},
      ...overrides.actions,
    },
    treeProps: {
      selectedSessionId: null,
      runningSessionIds: new Set(),
      unreadSessionIds: new Set(),
      pinnedSessionIds: new Set(),
      sessionPinColors: new Map(),
      isMobile: false,
      openSwipeSessionId: null,
      onOpenSwipeSessionChange() {},
      onSelectSession() {},
      onRenamed() {},
      onMoveSession() {},
      onTogglePinned() {},
      onSetPinColor() {},
      onSessionDeleted() {},
      ...overrides.treeProps,
    },
  };
}


test("worktree 嵌套在原项目下，两层可独立折叠且新建使用子目录动作", () => {
  const calls = [];
  function NestedProjects() {
    const [rootCollapsed, setRootCollapsed] = React.useState(false);
    const [childCollapsed, setChildCollapsed] = React.useState(false);
    return React.createElement(ProjectSection, {
      ...createProps({
        project: { collapsed: rootCollapsed },
        actions: { onToggleCollapsed: () => setRootCollapsed((value) => !value) },
      }),
    }, React.createElement(ProjectSection, createProps({
      project: { path: "/repo-worktrees/feature", name: "feature", collapsed: childCollapsed },
      actions: {
        onToggleCollapsed: () => setChildCollapsed((value) => !value),
        onNewSession: () => calls.push("/repo-worktrees/feature"),
      },
    })));
  }
  render(React.createElement(I18nProvider, null, React.createElement(NestedProjects)));
  const child = screen.getByTitle("/repo-worktrees/feature");
  const childSection = child.closest("section");
  assert.equal(childSection.parentElement.closest("section"), screen.getByTitle("/repo").closest("section"));
  assert.equal(screen.getAllByText("No sessions").length, 1);
  fireEvent.click(child);
  assert.equal(child.getAttribute("aria-expanded"), "false");
  fireEvent.click(childSection.querySelector('[aria-label="New session"]'));
  assert.deepEqual(calls, ["/repo-worktrees/feature"]);
  fireEvent.click(screen.getByTitle("/repo"));
  assert.equal(screen.queryByTitle("/repo-worktrees/feature"), null);
  fireEvent.click(screen.getByTitle("/repo"));
  assert.equal(screen.getByTitle("/repo-worktrees/feature").getAttribute("aria-expanded"), "false");
});

function renderProject(props) {
  return render(React.createElement(I18nProvider, null, React.createElement(ProjectSection, props)));
}

test("项目头只保留折叠、删除和新建动作", () => {
  const calls = [];
  renderProject(createProps({
    actions: {
      onToggleCollapsed: () => calls.push("collapse"),
      onRemove: () => calls.push("remove"),
      onNewSession: () => calls.push("new"),
    },
  }));

  fireEvent.click(screen.getByTitle("/repo"));
  assert.equal(screen.getAllByRole("button").length, 3);
  fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
  fireEvent.click(screen.getByRole("button", { name: "New session" }));

  assert.deepEqual(calls, ["collapse", "remove", "new"]);
});

test("项目拖放将源路径和目标路径交给排序动作", () => {
  const moves = [];
  const { container } = renderProject(createProps({ actions: { onMove: (...args) => moves.push(args) } }));
  const row = container.querySelector('[draggable="true"]');
  const dataTransfer = {
    effectAllowed: "none",
    types: ["application/x-pi-project"],
    setData() {},
    getData: () => "/other",
  };

  fireEvent.dragOver(row, { dataTransfer });
  fireEvent.drop(row, { dataTransfer });

  assert.deepEqual(moves, [["/other", "/repo"]]);
});

test("会话树渲染会话并将选择事件传给父层", () => {
  const selected = [];
  const session = {
    path: "/sessions/one.jsonl",
    id: "session-1",
    cwd: "/repo",
    name: "Session One",
    created: "2026-03-01T00:00:00.000Z",
    modified: "2026-03-01T00:00:00.000Z",
    messageCount: 2,
    firstMessage: "First message",
  };
  renderProject(createProps({
    project: { sessions: [session], sessionOrder: [session.id] },
    treeProps: { onSelectSession: (value) => selected.push(value.id) },
  }));

  fireEvent.click(screen.getByText("Session One"));
  assert.deepEqual(selected, ["session-1"]);
});


test("重命名期间输入框不继承会话拖拽，退出后恢复拖拽", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const session = {
    path: "/sessions/one.jsonl", id: "session-1", cwd: "/repo", name: "Session One",
    created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z",
    messageCount: 2, firstMessage: "First message",
  };
  try {
    const { container } = renderProject(createProps({
      project: { sessions: [session], sessionOrder: [session.id] },
    }));
    const row = container.querySelector("[data-session-row]");
    assert.ok(row);
    assert.equal(row.parentElement.getAttribute("draggable"), "true");
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = row.querySelector("input");
    assert.ok(input);
    assert.equal(input.closest('[draggable="true"]'), null);
    fireEvent.keyDown(input, { key: "Escape" });
    assert.equal(row.parentElement.getAttribute("draggable"), "true");
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});
test("通知定位请求只滚动目标会话一次", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalScrollTo = dom.window.HTMLElement.prototype.scrollTo;
  const scrollCalls = [];
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options) {
    if (this.hasAttribute("data-session-scroll")) scrollCalls.push(options.top);
  };

  const sessions = Array.from({ length: 40 }, (_, index) => ({
    path: `/sessions/${index}.jsonl`,
    id: `session-${index}`,
    cwd: "/repo",
    name: `Session ${index}`,
    created: "2026-03-01T00:00:00.000Z",
    modified: "2026-03-01T00:00:00.000Z",
    messageCount: 2,
    firstMessage: `Message ${index}`,
  }));
  const target = sessions[30];
  const renderTree = (revision) => React.createElement(
    "div",
    { "data-session-scroll": true },
    React.createElement(ProjectSection, createProps({
      project: { sessions, sessionOrder: sessions.map((session) => session.id) },
      treeProps: {
        selectedSessionId: target.id,
        locateSessionRequest: { sessionId: target.id, revision },
      },
    })),
  );

  try {
    const view = render(React.createElement(I18nProvider, null, renderTree(1)));
    assert.equal(scrollCalls.length, 1);
    assert.ok(scrollCalls[0] > 0);

    view.rerender(React.createElement(I18nProvider, null, renderTree(1)));
    assert.equal(scrollCalls.length, 1);

    view.rerender(React.createElement(I18nProvider, null, renderTree(2)));
    assert.equal(scrollCalls.length, 2);
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    dom.window.HTMLElement.prototype.scrollTo = originalScrollTo;
  }
});


test("项目折叠与展开使用闭合/打开文件夹图标表示，不渲染额外箭头", () => {
  const expandedView = renderProject(createProps({ project: { collapsed: false } }));
  assert.ok(expandedView.container.querySelector('[data-project-folder-icon="open"]'));
  assert.equal(expandedView.container.querySelector('[data-project-folder-icon="closed"]'), null);
  expandedView.unmount();

  const collapsedView = renderProject(createProps({ project: { collapsed: true } }));
  assert.ok(collapsedView.container.querySelector('[data-project-folder-icon="closed"]'));
  assert.equal(collapsedView.container.querySelector('[data-project-folder-icon="open"]'), null);
});

test("侧栏项目图标加载成功后替换文件夹，加载失败时保留文件夹", () => {
  const projectPath = "/repo with spaces";
  const first = renderProject(createProps({ project: { path: projectPath } }));
  const icon = first.container.querySelector("img");
  assert.ok(icon);
  assert.equal(new URL(icon.src).searchParams.get("project"), projectPath);
  assert.equal(icon.draggable, false);
  assert.ok(first.container.querySelector('[data-project-folder-icon="open"]'));
  fireEvent.load(icon);
  assert.equal(icon.style.opacity, "1");
  assert.equal(first.container.querySelector("[data-project-folder-icon]"), null);
  first.unmount();

  const second = renderProject(createProps({ project: { collapsed: true } }));
  const brokenIcon = second.container.querySelector("img");
  assert.ok(brokenIcon);
  fireEvent.error(brokenIcon);
  assert.equal(second.container.querySelector("img"), null);
  assert.ok(second.container.querySelector('[data-project-folder-icon="closed"]'));
});

test("PinnedSessionsSection 按项目合并分组，组头展示目录名和会话数", () => {
  const s1 = {
    path: "/sessions/1.jsonl",
    id: "s1",
    cwd: "/work/pi-web",
    name: "First Pinned",
    created: "2026-03-01T00:00:00.000Z",
    modified: "2026-03-01T00:00:00.000Z",
    messageCount: 5,
    firstMessage: "First",
  };
  const s2 = {
    path: "/sessions/2.jsonl",
    id: "s2",
    cwd: "/work/KeyRouter",
    name: "Second Pinned",
    created: "2026-03-01T00:01:00.000Z",
    modified: "2026-03-01T00:01:00.000Z",
    messageCount: 3,
    firstMessage: "Second",
  };
  const s3 = {
    path: "/sessions/3.jsonl",
    id: "s3",
    cwd: "/work/pi-web",
    name: "Third Pinned",
    created: "2026-03-01T00:02:00.000Z",
    modified: "2026-03-01T00:02:00.000Z",
    messageCount: 1,
    firstMessage: "Third",
  };
  const props = createProps({
    treeProps: {
      topPinnedSessionIds: new Set(["s2", "s1", "s3"]),
      onToggleTopPinned() {},
      resolveProject: (session) => ({ name: session.cwd.split("/").pop(), path: session.cwd }),
    },
  });
  const { container } = render(React.createElement(
    I18nProvider,
    null,
    React.createElement(PinnedSessionsSection, {
      title: "Pinned",
      sessions: [s1, s2, s3],
      sessionOrder: ["s2", "s1", "s3"],
      treeProps: props.treeProps,
    }),
  ));

  assert.ok(container.querySelector("[data-pinned-sessions-section]"));
  assert.ok(screen.getByText("Pinned"));

  // 组顺序跟随置顶顺序里首次出现的项目；同目录会话合并成一组。
  const groups = [...container.querySelectorAll("[data-pinned-group]")].map((el) => el.getAttribute("data-pinned-group"));
  assert.deepEqual(groups, ["/work/KeyRouter", "/work/pi-web"]);
  const names = [...container.querySelectorAll("[data-pinned-group-name]")].map((el) => el.textContent);
  assert.deepEqual(names, ["KeyRouter", "pi-web"]);
  const counts = [...container.querySelectorAll("[data-pinned-group-count]")].map((el) => el.textContent);
  assert.deepEqual(counts, ["1", "2"]);

  // 目录信息只由组头给出，行内不再重复项目名。
  assert.deepEqual([...container.querySelectorAll("[data-session-project]")], []);
  assert.deepEqual([...container.querySelectorAll("[data-session-row] div[title]")].map((el) => el.textContent), ["Second Pinned", "First Pinned", "Third Pinned"]);
});


test("PinnedSessionsSection 中独立置顶的子代理作为独立根节点，折叠父会话不会隐藏它", () => {
  const parent = {
    path: "/sessions/parent.jsonl",
    id: "parent",
    cwd: "/work/pi-web",
    name: "Parent Session",
    created: "2026-03-01T00:00:00.000Z",
    modified: "2026-03-01T00:00:00.000Z",
    messageCount: 5,
    firstMessage: "Parent",
  };
  const pinnedSub = {
    path: "/sessions/sub1.jsonl",
    id: "pinned-sub",
    cwd: "/work/pi-web",
    name: "Pinned Subagent",
    created: "2026-03-01T00:01:00.000Z",
    modified: "2026-03-01T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "Pinned sub",
    relation: { kind: "subagent", parentSessionId: "parent" },
  };
  const nestedSub = {
    path: "/sessions/sub2.jsonl",
    id: "nested-sub",
    cwd: "/work/pi-web",
    name: "Nested Subagent",
    created: "2026-03-01T00:02:00.000Z",
    modified: "2026-03-01T00:02:00.000Z",
    messageCount: 1,
    firstMessage: "Nested sub",
    relation: { kind: "subagent", parentSessionId: "parent" },
  };
  const props = createProps({
    treeProps: {
      topPinnedSessionIds: new Set(["pinned-sub", "parent"]),
      onToggleTopPinned() {},
      resolveProject: (session) => ({ name: session.cwd.split("/").pop(), path: session.cwd }),
    },
  });
  render(React.createElement(
    I18nProvider,
    null,
    React.createElement(PinnedSessionsSection, {
      title: "Pinned",
      sessions: [parent, pinnedSub, nestedSub],
      sessionOrder: ["pinned-sub", "parent"],
      treeProps: props.treeProps,
    }),
  ));

  // 折叠父会话，只隐藏未独立置顶的 nestedSub，不影响独立置顶的 pinnedSub
  fireEvent.click(screen.getByTitle("Collapse forks"));
  assert.ok(screen.getByText("Pinned Subagent"));
  assert.equal(screen.queryByText("Nested Subagent"), null);
  assert.equal(screen.getByTitle("/work/pi-web").querySelector("[data-pinned-group-count]").textContent, "2");
});


test("置顶分组按项目根目录合并，折叠互相独立且保留选择与拖拽动作", () => {
  const sessions = [
    { id: "main", cwd: "/work/pi-web", projectRoot: "/work/pi-web", name: "Main pin" },
    { id: "branch", cwd: "/work/pi-web-worktrees/fix", projectRoot: "/work/pi-web", name: "Worktree pin" },
    { id: "blog", cwd: "/work/blog", projectRoot: "/work/blog", name: "Blog pin" },
  ].map((session) => ({ ...session, path: `/sessions/${session.id}.jsonl`, created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 2, firstMessage: session.name }));
  const selected = [];
  const moves = [];
  const treeProps = createProps({ treeProps: {
    topPinnedSessionIds: new Set(sessions.map((session) => session.id)),
    resolveProject: (session) => ({ path: session.projectRoot, name: session.projectRoot.split("/").pop() }),
    onSelectSession: (session) => selected.push(session.id),
    onMoveSession: (...args) => moves.push(args),
  } }).treeProps;
  const { container } = render(React.createElement(I18nProvider, null, React.createElement(PinnedSessionsSection, {
    title: "Pinned", sessions, sessionOrder: ["branch", "blog", "main"], treeProps,
  })));
  assert.deepEqual([...container.querySelectorAll("[data-pinned-group-count]")].map((node) => node.textContent), ["2", "1"]);
  assert.equal(container.querySelectorAll("[data-session-project-mark]").length, 2);
  assert.deepEqual([...container.querySelectorAll("[data-session-row] div[title]")].map((node) => node.textContent), ["Worktree pin", "Main pin", "Blog pin"]);
  fireEvent.click(screen.getByText("Worktree pin"));
  assert.deepEqual(selected, ["branch"]);
  const target = screen.getByText("Main pin").closest("[data-session-row]").parentElement;
  fireEvent.drop(target, { dataTransfer: { getData: () => "branch" } });
  assert.deepEqual(moves, [["branch", "main"]]);
  const header = screen.getByTitle("/work/pi-web");
  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("Worktree pin"), null);
  assert.ok(screen.getByText("Blog pin"));
  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByText("Worktree pin"));
});

test("通知定位展开置顶项目组，同一定位不覆盖之后的手动折叠", () => {
  const session = { id: "target", cwd: "/work/target", path: "/sessions/target.jsonl", name: "Target pin", created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 1, firstMessage: "Target" };
  const treeProps = createProps({ treeProps: {
    topPinnedSessionIds: new Set([session.id]),
    resolveProject: () => ({ path: session.cwd, name: "target" }),
  } }).treeProps;
  const renderPinned = (request) => React.createElement(I18nProvider, null, React.createElement(PinnedSessionsSection, {
    title: "Pinned", sessions: [session], sessionOrder: [session.id], treeProps: { ...treeProps, locateSessionRequest: request },
  }));
  const view = render(renderPinned(null));
  fireEvent.click(screen.getByTitle(session.cwd));
  assert.equal(screen.queryByText(session.name), null);
  view.rerender(renderPinned({ sessionId: session.id, revision: 1 }));
  assert.ok(screen.getByText(session.name));
  fireEvent.click(screen.getByTitle(session.cwd));
  view.rerender(renderPinned({ sessionId: session.id, revision: 1 }));
  assert.equal(screen.queryByText(session.name), null);
  view.rerender(renderPinned({ sessionId: session.id, revision: 2 }));
  assert.ok(screen.getByText(session.name));
});


test("收起前一个置顶组后，后一个组立即更新虚拟列表位置", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const group = this.closest("[data-pinned-group]");
    let top = 0;
    if (group) {
      const firstExpanded = document.querySelector('[data-pinned-group="/a"] button')?.getAttribute("aria-expanded") === "true";
      top = group.getAttribute("data-pinned-group") === "/a" ? 30 : (firstExpanded ? 40 * 54 : 0) + 60;
    }
    return { top, bottom: top + 200, height: 200, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} };
  };
  try {
    const sessions = Array.from({ length: 50 }, (_, index) => ({
      id: `layout-${index}`, cwd: index < 40 ? "/a" : "/b", path: `/sessions/layout-${index}.jsonl`, name: `Layout ${index}`,
      created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 1, firstMessage: "Layout",
    }));
    const treeProps = createProps({ treeProps: {
      topPinnedSessionIds: new Set(sessions.map((session) => session.id)),
      resolveProject: (session) => ({ path: session.cwd, name: session.cwd }),
    } }).treeProps;
    render(React.createElement(I18nProvider, null, React.createElement("div", { "data-session-scroll": true }, React.createElement(PinnedSessionsSection, {
      title: "Pinned", sessions, sessionOrder: sessions.map((session) => session.id), treeProps,
    }))));
    assert.equal(screen.queryByText("Layout 40"), null);
    fireEvent.click(screen.getByTitle("/a"));
    assert.ok(screen.getByText("Layout 40"));
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});


test("顶部置顶区收起后，下方项目列表通过高度监听补出可见会话", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const observers = new Set();
  globalThis.ResizeObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { observers.delete(this); }
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const isLower = !this.hasAttribute("data-session-scroll") && !this.closest("[data-pinned-sessions-section]");
    const expanded = document.querySelector("[data-pinned-group] button")?.getAttribute("aria-expanded") === "true";
    const top = isLower && expanded ? 1000 : 0;
    return { top, bottom: top + 200, height: 200, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} };
  };
  try {
    const pinned = { id: "above", cwd: "/above", path: "/sessions/above.jsonl", name: "Above pin", created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 1, firstMessage: "Above" };
    const lower = { ...pinned, id: "below", cwd: "/below", name: "Below session" };
    const treeProps = createProps({ treeProps: {
      topPinnedSessionIds: new Set([pinned.id]),
      resolveProject: () => ({ path: pinned.cwd, name: "above" }),
    } }).treeProps;
    const { container } = render(React.createElement(I18nProvider, null, React.createElement("div", { "data-session-scroll": true },
      React.createElement(PinnedSessionsSection, { title: "Pinned", sessions: [pinned], sessionOrder: [pinned.id], treeProps }),
      React.createElement(ProjectSection, createProps({ project: { path: lower.cwd, sessions: [lower], sessionOrder: [lower.id] } })),
    )));
    assert.equal(screen.queryByText(lower.name), null);
    fireEvent.click(screen.getByTitle(pinned.cwd));
    act(() => {
      const pinnedSection = container.querySelector("[data-pinned-sessions-section]");
      for (const observer of observers) {
        if (observer.targets.has(pinnedSection)) observer.callback();
      }
    });
    assert.ok(screen.getByText(lower.name));
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});


test("置顶分组复用 Windows 路径身份，等价路径合并且切换原始写法后保留折叠状态", () => {
  const sessions = [
    { id: "windows-a", cwd: "D:\\Repo-Worktrees\\Feature" },
    { id: "windows-b", cwd: "d:/repo-worktrees/feature" },
  ].map((session) => ({
    ...session, projectRoot: "D:\\Repo", isWorktree: true, path: `/sessions/${session.id}.jsonl`, name: session.id,
    created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 1, firstMessage: session.id,
  }));
  const treeProps = createProps({ treeProps: {
    topPinnedSessionIds: new Set(sessions.map((session) => session.id)),
    resolveProject: (session) => ({ path: sidebarProjectPath(session), name: "Feature" }),
  } }).treeProps;
  const renderPinned = (sessionOrder) => React.createElement(I18nProvider, null, React.createElement(PinnedSessionsSection, {
    title: "Pinned", sessions, sessionOrder, treeProps,
  }));
  const view = render(renderPinned(["windows-a", "windows-b"]));
  assert.equal(view.container.querySelectorAll("[data-pinned-group]").length, 2);
  const header = screen.getByTitle(sessions[0].cwd);
  assert.equal(header.querySelector("[data-pinned-group-count]").textContent, "2");
  assert.equal(new URL(header.querySelector("img").src).searchParams.get("project"), sessions[0].cwd);
  fireEvent.click(header);
  assert.equal(screen.queryByText("windows-a"), null);
  assert.equal(screen.queryByText("windows-b"), null);

  // 调换置顶顺序会改变组头保留的原始路径，但不能改变分组身份或重置折叠状态。
  view.rerender(renderPinned(["windows-b", "windows-a"]));
  const reorderedHeader = screen.getByTitle(sessions[1].cwd);
  assert.equal(reorderedHeader, header);
  assert.equal(reorderedHeader.getAttribute("aria-expanded"), "false");
  assert.equal(reorderedHeader.querySelector("[data-pinned-group-count]").textContent, "2");
  assert.equal(new URL(reorderedHeader.querySelector("img").src).searchParams.get("project"), sessions[1].cwd);
  assert.equal(screen.queryByText("windows-a"), null);
  fireEvent.click(reorderedHeader);
  assert.ok(screen.getByText("windows-a"));
  assert.ok(screen.getByText("windows-b"));
});


test("置顶主目录与 worktree 归入同一项目，定位展开两层并保留会话动作", () => {
  const sessions = [
    { id: "main-pin", cwd: "/repo", name: "Main pin" },
    { id: "worktree-pin", cwd: "/repo-worktrees/feature", name: "Worktree pin", isWorktree: true },
  ].map((session) => ({
    ...session, projectRoot: "/repo", path: `/sessions/${session.id}.jsonl`,
    created: "2026-03-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", messageCount: 1, firstMessage: session.id,
  }));
  const selected = [];
  const treeProps = createProps({ treeProps: {
    topPinnedSessionIds: new Set(sessions.map((session) => session.id)),
    resolveProject: (session) => ({ path: sidebarProjectPath(session), name: session.isWorktree ? "feature" : "repo" }),
    onSelectSession: (session) => selected.push(session.id),
  } }).treeProps;
  const renderPinned = (locateSessionRequest) => React.createElement(I18nProvider, null, React.createElement(PinnedSessionsSection, {
    title: "Pinned", sessions, sessionOrder: ["worktree-pin", "main-pin"], treeProps: { ...treeProps, locateSessionRequest },
  }));
  const view = render(renderPinned(null));
  const root = screen.getByTitle("/repo").closest("[data-pinned-group]");
  const child = screen.getByTitle("/repo-worktrees/feature");
  assert.ok(root.contains(child));
  assert.equal(root.querySelector("[data-pinned-group-count]").textContent, "2");
  assert.equal(child.querySelector("[data-pinned-group-count]").textContent, "1");
  fireEvent.click(screen.getByText("Worktree pin"));
  assert.deepEqual(selected, ["worktree-pin"]);
  fireEvent.click(child);
  assert.ok(screen.getByText("Main pin"));
  assert.equal(screen.queryByText("Worktree pin"), null);
  fireEvent.click(screen.getByTitle("/repo"));
  view.rerender(renderPinned({ sessionId: "worktree-pin", revision: 1 }));
  assert.ok(screen.getByText("Worktree pin"));
  assert.equal(screen.getByTitle("/repo").getAttribute("aria-expanded"), "true");
  assert.equal(screen.getByTitle("/repo-worktrees/feature").getAttribute("aria-expanded"), "true");
});


test("项目头拖拽移动整个父组，原先排在前面的 worktree 保持在组内", () => {
  const sessions = [{ cwd: "/repo-worktrees/feature", projectRoot: "/repo", isWorktree: true }];
  function Projects() {
    const [state, setState] = React.useState({ ...emptySidebarPreferences(), projectOrder: [sessions[0].cwd, "/repo", "/other"] });
    const groups = groupSidebarProjects(state.projectOrder, sessions, null, (paths) => orderProjectsByPreference(paths, state.projectOrder));
    return React.createElement("div", { "data-project-groups": true }, groups.map((group) => React.createElement(ProjectSection, {
      ...createProps({
        project: { path: group.path, name: group.path },
        actions: { onMove: (source, target) => {
          const move = resolveSidebarProjectMove(groups, source, target);
          if (move) setState((current) => reduceSidebarPreferences(current, { type: "move_project", ...move }, false));
        } },
      }), key: group.path,
    }, group.worktrees.map((path) => React.createElement(ProjectSection, {
      ...createProps({ project: { path, name: path } }), key: path,
    })))));
  }
  const view = render(React.createElement(I18nProvider, null, React.createElement(Projects)));
  const target = screen.getByTitle("/other").closest('[draggable="true"]');
  fireEvent.drop(target, { dataTransfer: { getData: () => "/repo" } });
  const rootNames = [...view.container.querySelector("[data-project-groups]").children]
    .map((section) => section.querySelector("button[title]").title);
  assert.deepEqual(rootNames, ["/other", "/repo"]);
  assert.ok(screen.getByTitle("/repo").closest("section").contains(screen.getByTitle(sessions[0].cwd)));
});

test("Windows 当前 worktree 收起父组后再次定位，按等价路径展开实际目录", () => {
  const groups = [{ path: "d:/repo", worktrees: ["d:/repo-worktrees/feature"] }];
  const target = "D:/REPO-WORKTREES/Feature".replaceAll("/", "\\");
  function Projects() {
    const [collapsed, setCollapsed] = React.useState(new Set());
    const toggle = (path) => setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    return React.createElement(React.Fragment, null,
      React.createElement("button", { onClick: () => setCollapsed((current) => expandSidebarProject(groups, current, target)) }, "Locate worktree"),
      React.createElement(ProjectSection, createProps({
        project: { path: groups[0].path, collapsed: collapsed.has(groups[0].path) },
        actions: { onToggleCollapsed: () => toggle(groups[0].path) },
      }), React.createElement(ProjectSection, createProps({
        project: { path: groups[0].worktrees[0], name: "feature", collapsed: collapsed.has(groups[0].worktrees[0]) },
        actions: { onToggleCollapsed: () => toggle(groups[0].worktrees[0]) },
      }))),
    );
  }
  render(React.createElement(I18nProvider, null, React.createElement(Projects)));
  fireEvent.click(screen.getByTitle(groups[0].worktrees[0]));
  fireEvent.click(screen.getByTitle(groups[0].path));
  assert.equal(screen.queryByTitle(groups[0].worktrees[0]), null);
  fireEvent.click(screen.getByText("Locate worktree"));
  assert.equal(screen.getByTitle(groups[0].path).getAttribute("aria-expanded"), "true");
  assert.equal(screen.getByTitle(groups[0].worktrees[0]).getAttribute("aria-expanded"), "true");
  fireEvent.click(screen.getByTitle(groups[0].path));
  fireEvent.click(screen.getByText("Locate worktree"));
  assert.equal(screen.getByTitle(groups[0].path).getAttribute("aria-expanded"), "true");
});

test("PinnedSessionsSection 置顶分组与 worktree 子分组支持直接新建会话且不触发折叠", () => {
  const main = { id: "s-main", path: "/s/main.jsonl", cwd: "/repo", projectRoot: "/repo", isWorktree: false, created: "", modified: "2026-04-01T00:00:00Z", messageCount: 1, firstMessage: "主仓库" };
  const wt = { id: "s-wt", path: "/s/wt.jsonl", cwd: "/repo-worktrees/feat", projectRoot: "/repo", isWorktree: true, created: "", modified: "2026-04-02T00:00:00Z", messageCount: 1, firstMessage: "分支" };
  const createdCwds = [];
  const treeProps = {
    ...createProps().treeProps,
    topPinnedSessionIds: new Set(["s-main", "s-wt"]),
    resolveProject: (session) => ({ name: session.cwd.split("/").pop(), path: session.cwd }),
  };

  render(React.createElement(I18nProvider, null, React.createElement(PinnedSessionsSection, {
    title: "置顶",
    sessions: [main, wt],
    sessionOrder: ["s-main", "s-wt"],
    onNewSession: (path) => createdCwds.push(path),
    formatNewSessionLabel: (name) => `在 ${name} 新建置顶会话`,
    treeProps,
  })));

  const mainToggle = screen.getByTitle("/repo");
  const wtToggle = screen.getByTitle("/repo-worktrees/feat");
  const mainNewBtn = screen.getByRole("button", { name: "在 repo 新建置顶会话" });
  const wtNewBtn = screen.getByRole("button", { name: "在 feat 新建置顶会话" });

  fireEvent.click(mainNewBtn);
  fireEvent.click(wtNewBtn);

  assert.deepEqual(createdCwds, ["/repo", "/repo-worktrees/feat"]);
  assert.equal(mainToggle.getAttribute("aria-expanded"), "true");
  assert.equal(wtToggle.getAttribute("aria-expanded"), "true");
});
