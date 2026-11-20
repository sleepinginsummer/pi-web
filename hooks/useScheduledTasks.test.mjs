import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useScheduledTasks } = await jiti.import("./useScheduledTasks.ts");

/**
 * 真 React + JSDOM：给「操作在切项目之后才收尾」这件事一个可复现的顺序。
 *
 * 复现的是 review 里的时序：A 的删除还没返回 → 切到 B → B 的删除失败（提示出现）
 * → A 的删除成功。A 成功那次如果无条件清提示，就会把 B 的失败抹掉。
 */
test("旧项目的操作成功不会清掉新项目的失败提示", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => "visible" });
  const polls = [];
  const posts = [];
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    // 轮询立即返回空列表（这条用例只关心操作请求的时序），POST 由用例逐个回应。
    fetch: (url, init) => {
      if (init?.method === "POST") {
        return new Promise((resolve) => {
          posts.push({
            url: String(url),
            respond: (ok, body) => resolve({ ok, status: ok ? 200 : 500, json: async () => body }),
          });
        });
      }
      polls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
    },
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let hook = null;
  const root = createRoot(dom.window.document.getElementById("root"));
  function Fixture({ cwd }) {
    hook = useScheduledTasks(cwd);
    return null;
  }
  const render = (cwd) => act(async () => { root.render(createElement(Fixture, { cwd })); });

  try {
    await render("/project-a");
    assert.equal(polls.at(-1), "/api/scheduled-tasks?cwd=%2Fproject-a");

    // A 的删除：请求发出去，先不回应。
    let deleteOnA = null;
    await act(async () => { deleteOnA = hook.act("task-a", "delete"); });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/scheduled-tasks/task-a");

    // 切到 B。
    await render("/project-b");
    assert.equal(hook.actionError, null, "换项目先清掉上一个项目的提示");

    // B 的删除失败。
    let deleteOnB = null;
    deleteOnB = hook.act("task-b", "delete");
    await act(async () => {});
    const postOnB = posts.at(-1);
    assert.equal(postOnB.url, "/api/scheduled-tasks/task-b");
    await act(async () => {
      postOnB.respond(false, { error: "任务不存在" });
      await deleteOnB;
    });
    assert.equal(hook.actionError, "任务不存在");

    // 现在 A 的删除成功了。它属于旧项目，不能动 B 的提示。
    await act(async () => {
      posts[0].respond(true, { ok: true });
      await deleteOnA;
    });
    assert.equal(hook.actionError, "任务不存在", "旧项目成功收尾不得抹掉当前项目的失败提示");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
