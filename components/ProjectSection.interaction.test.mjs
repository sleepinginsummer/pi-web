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

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProjectSection } = await jiti.import("./ProjectSection.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

afterEach(cleanup);

function createProps(overrides = {}) {
  return {
    project: {
      path: "/repo",
      name: "repo",
      active: true,
      collapsed: false,
      pinned: false,
      isMobile: false,
      sessions: [],
      sessionOrder: [],
      ...overrides.project,
    },
    labels: {
      empty: "No sessions",
      pin: "Pin project",
      remove: "Remove project",
      newSession: "New session",
    },
    actions: {
      onToggleCollapsed() {},
      onMove() {},
      onTogglePinned() {},
      onRemove() {},
      onNewSession() {},
      ...overrides.actions,
    },
    treeProps: {
      selectedSessionId: null,
      runningSessionIds: new Set(),
      unreadSessionIds: new Set(),
      pinnedSessionIds: new Set(),
      isMobile: false,
      openSwipeSessionId: null,
      onOpenSwipeSessionChange() {},
      onSelectSession() {},
      onRenamed() {},
      onMoveSession() {},
      onTogglePinned() {},
      onSessionDeleted() {},
      ...overrides.treeProps,
    },
  };
}

function renderProject(props) {
  return render(React.createElement(I18nProvider, null, React.createElement(ProjectSection, props)));
}

test("项目头触发折叠、Pin、删除和新建动作", () => {
  const calls = [];
  renderProject(createProps({
    actions: {
      onToggleCollapsed: () => calls.push("collapse"),
      onTogglePinned: () => calls.push("pin"),
      onRemove: () => calls.push("remove"),
      onNewSession: () => calls.push("new"),
    },
  }));

  fireEvent.click(screen.getByTitle("/repo"));
  fireEvent.click(screen.getByRole("button", { name: "Pin project" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
  fireEvent.click(screen.getByRole("button", { name: "New session" }));

  assert.deepEqual(calls, ["collapse", "pin", "remove", "new"]);
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
