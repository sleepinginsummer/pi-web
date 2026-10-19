import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
});
const { cleanup, render } = await import("@testing-library/react");
afterEach(cleanup);

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
// 保留生产代码中的 effect 顺序，覆盖活动 leaf 变化与新定位请求同时提交的情况。
const anchorEffects = source.slice(
  source.indexOf("const previousLeafIdRef = useRef"),
  source.indexOf("  useEffect(() => {\n    if (!searchTarget || loading || searchLoadRef.current)"),
);
const compiled = ts.transpileModule(anchorEffects, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const useAnchorEffects = new Function("scope", `
  const {
    useEffect, useLayoutEffect, useRef, activeLeafId, loading, scrollPositionRequest,
    pendingScrollRestore, setPendingScrollRestore, restoreAnchorReadyFor, setRestoreAnchorReadyFor,
    restoreLoadPositionRef, prevScrollDistanceRef, historyCursor, searchTarget, loadingEarlierMessages,
    entryIds, setRenderWindow, renderWindowKey, MAX_MOUNTED_HISTORY_GROUPS, hasEarlierMessages,
    scrollToLatest, loadEarlierMessages, messages, messageContentRef, scrollToElement, visibleCount,
  } = scope;
  ${compiled}
`);
const maxWindow = Number(source.match(/const MAX_MOUNTED_HISTORY_GROUPS = (\d+)/)[1]);

test("压缩改变活动 leaf 时先挂载本次卡片，再定位；旧 leaf 的清理不能取消定位", () => {
  const scrolls = [];
  const scrollToElement = (element, offset) => scrolls.push({ id: element.dataset.entryId, offset });
  const scrollToLatest = () => assert.fail("不能回退到最后一条回复");
  const loadEarlierMessages = () => assert.fail("本次卡片已在上下文中，不应加载其它历史页");

  function Harness({ leaf, entryIds, request }) {
    const [pendingScrollRestore, setPendingScrollRestore] = useState(null);
    const [restoreAnchorReadyFor, setRestoreAnchorReadyFor] = useState(null);
    const [renderWindow, setRenderWindow] = useState({ key: "session", count: 1, offset: 0 });
    const messageContentRef = useRef(null);
    const restoreLoadPositionRef = useRef(null);
    const prevScrollDistanceRef = useRef(800);
    useAnchorEffects({
      useEffect, useLayoutEffect, useRef, activeLeafId: leaf, loading: false, scrollPositionRequest: request,
      pendingScrollRestore, setPendingScrollRestore, restoreAnchorReadyFor, setRestoreAnchorReadyFor,
      restoreLoadPositionRef, prevScrollDistanceRef, historyCursor: entryIds[0], searchTarget: null,
      loadingEarlierMessages: false, entryIds, setRenderWindow, renderWindowKey: "session",
      MAX_MOUNTED_HISTORY_GROUPS: maxWindow, hasEarlierMessages: false, scrollToLatest, loadEarlierMessages,
      messages: entryIds.map((id) => ({ role: "custom", customType: "compaction", id })),
      messageContentRef, scrollToElement, visibleCount: renderWindow.count,
    });
    const visibleIds = renderWindow.count === 1 ? entryIds.slice(-1) : entryIds;
    return React.createElement("div", { ref: messageContentRef }, visibleIds.map((id) => (
      React.createElement("div", { key: id, "data-entry-id": id }, id)
    )));
  }

  const before = ["old-compaction", "last-reply"];
  const view = render(React.createElement(Harness, { leaf: "old-leaf", entryIds: before, request: null }));
  const after = ["new-compaction", "old-compaction", "last-reply"];
  const request = { generation: 1, position: { entryId: "new-compaction" } };
  view.rerender(React.createElement(Harness, { leaf: "new-leaf", entryIds: after, request }));

  assert.ok(view.container.querySelector('[data-entry-id="new-compaction"]'));
  assert.deepEqual(scrolls, [{ id: "new-compaction", offset: 16 }]);
  view.rerender(React.createElement(Harness, { leaf: "new-leaf", entryIds: after, request }));
  assert.equal(scrolls.length, 1, "普通重渲染不能重复移动用户的阅读位置");
});
