import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
}
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TeamSidebarSection } = await jiti.import("../components/TeamSidebarSection.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

// 使用真实 React 表单检查确认流程；真实 Chromium 检查侧栏 transform 下的模态布局。
test("团队编辑回填、二次确认、取消保留草稿、错误可见及目录展示", async (t) => {
  const team = { id: "team-1", name: "原团队", prompt: "原目标", createdAt: 1, updatedAt: 10, cards: [], members: [
    { id: "l", sessionId: "leader-session", role: "leader", name: "leader", title: "负责人", prompt: "拆分任务", cwd: "/repo", createdAt: 1 },
    { id: "d", sessionId: "dev-session", role: "member", name: "dev", title: "开发", prompt: "开发", cwd: "/other", createdAt: 2 },
  ] };
  const writes = [];
  const changes = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      if (fail) return Response.json({ error: "团队已发生变化，请重新打开" }, { status: 409 });
      return Response.json({ team: { ...team, name: "新团队", members: [{ ...team.members[0], sessionId: "new-session", cwd: "/new" }] } });
    }
    return Response.json({ modelList: [] });
  });
  let browser;
  try {
    render(React.createElement(I18nProvider, null, React.createElement("div", { style: { transform: "translateX(0)", width: 280 } },
      React.createElement(TeamSidebarSection, { teams: [team], selectedSessionId: null, runningSessionIds: new Set(),
        awaitingInputSessionIds: new Set(), unreadSessionIds: new Set(), defaultCwd: "/tmp", onSelectMemberSession() {},
        onOpenBoard() {}, onTeamsChanged(value) { changes.push(value); } }))));
    const directory = screen.getByRole("button", { name: "Working directory：/repo" });
    assert.equal(directory.textContent, "repo");
    fireEvent.pointerEnter(directory, { pointerType: "mouse" });
    assert.equal(screen.getByRole("tooltip").textContent, "/repo");
    fireEvent.pointerLeave(directory, { pointerType: "mouse" });
    assert.equal(screen.queryByRole("tooltip"), null);
    fireEvent.click(directory);
    assert.equal(screen.getByRole("tooltip").textContent, "/repo");
    fireEvent.click(directory);
    assert.equal(screen.queryByRole("tooltip"), null);
    assert.ok(screen.getByRole("button", { name: /dev 开发/ }), "点按目录不应收起团队成员");
    assert.ok(screen.getAllByTitle("/other").length > 0);
    fireEvent.click(screen.getByRole("button", { name: "原团队 Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit team" });
    assert.equal(dialog.open, true);
    const inputs = dialog.querySelectorAll("input");
    assert.deepEqual([...inputs].map((input) => input.value), ["原团队", "leader", "/repo"]);
    assert.deepEqual([...dialog.querySelectorAll("textarea")].map((input) => input.value), ["原目标", "拆分任务"]);
    fireEvent.change(inputs[0], { target: { value: "新团队" } });
    fireEvent.change(inputs[2], { target: { value: "/new" } });
    fireEvent.submit(dialog.querySelector("form"));
    assert.equal(writes.length, 0, "首次保存只能进入确认");
    assert.match(screen.getByRole("alert").textContent, /all 2 current members/);
    assert.equal(dialog.querySelector("fieldset").disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    assert.equal(writes.length, 0);
    assert.equal(inputs[0].value, "新团队");
    assert.equal(dialog.querySelector("fieldset").disabled, false);

    browser = await chromium.launch();
    const page = await browser.newPage();
    for (const width of [320, 1024]) {
      await page.setViewportSize({ width, height: 500 });
      await page.setContent('<style>*{box-sizing:border-box}body{margin:0;--bg:white;--text:black;--border:#ddd}</style>' + document.body.innerHTML);
      await page.evaluate(() => { const d = document.querySelector("dialog"); d.removeAttribute("open"); d.showModal(); });
      const bounds = await page.locator("dialog").boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `原生模态不能被侧栏裁切: ${width}, ${JSON.stringify(bounds)}`);
      assert.ok(bounds.width > 280, "窄侧栏不能限制编辑表单宽度");
      const save = page.getByRole("button", { name: "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      assert.equal(await save.isVisible(), true);
    }

    fireEvent.submit(dialog.querySelector("form"));
    fireEvent.submit(dialog.querySelector("form"));
    await waitFor(() => assert.ok(screen.getByText("团队已发生变化，请重新打开")));
    assert.equal(changes.length, 0);
    assert.equal(inputs[0].value, "新团队");
    fail = false;
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Confirm rebuild" }).disabled, false));
    fireEvent.submit(dialog.querySelector("form"));
    await waitFor(() => assert.equal(changes.length, 1));
    assert.deepEqual(writes[1], { name: "新团队", prompt: "原目标", leaderName: "leader", leaderPrompt: "拆分任务",
      confirmRebuild: true, expectedUpdatedAt: 10, cwd: "/new" });
    assert.deepEqual(changes[0], { sessionId: "new-session", cwd: "/new" });
    assert.equal(screen.queryByRole("dialog"), null);
  } finally {
    await browser?.close();
    cleanup();
  }
});

test("创建团队预填可修改的 Leader 提示词，不显示职位字段，允许清空默认提示词", async (t) => {
  const { DEFAULT_TEAM_LEADER_PROMPT } = await jiti.import("../lib/team-types.ts");
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      return Response.json({ team: { id: "new-team", members: [] } });
    }
    return Response.json({ modelList: [] });
  });
  try {
    render(React.createElement(I18nProvider, null, React.createElement(TeamSidebarSection, {
      teams: [], selectedSessionId: null, runningSessionIds: new Set(), awaitingInputSessionIds: new Set(),
      unreadSessionIds: new Set(), defaultCwd: "/repo", onSelectMemberSession() {}, onOpenBoard() {}, onTeamsChanged() {},
    })));
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = screen.getByRole("dialog", { name: "Create team" });
    assert.equal(screen.queryByText("Leader title"), null);
    const fields = dialog.querySelectorAll("textarea");
    assert.equal(fields[1].value, DEFAULT_TEAM_LEADER_PROMPT);
    assert.match(fields[1].value, /验收标准/);
    fireEvent.change(fields[1], { target: { value: "" } });
    fireEvent.change(dialog.querySelector("input"), { target: { value: "测试团队" } });
    fireEvent.submit(dialog.querySelector("form"));
    await waitFor(() => assert.equal(writes.length, 1));
    assert.equal(writes[0].leaderPrompt, "");
    assert.equal(Object.hasOwn(writes[0], "leaderTitle"), false);
  } finally {
    cleanup();
  }
});
