import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");
const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

test("折叠的过程详情不构造子节点，展开或需要露出时才构造", () => {
  let built = 0;
  const renderChildren = () => {
    built += 1;
    return React.createElement("span", null, "child");
  };

  const collapsed = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    messageCount: 3, toolCallCount: 2, t, renderChildren,
  }));
  assert.equal(built, 0, "折叠时不构造，所以 ChatWindow 可以把 JSX 推迟到回调里");
  assert.doesNotMatch(collapsed, /child/);

  const revealed = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    messageCount: 3, toolCallCount: 2, t, reveal: true, renderChildren,
  }));
  assert.equal(built, 1);
  assert.match(revealed, /child/);
});
