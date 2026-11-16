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
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SecretVaultConfig } = await jiti.import("./SecretVaultConfig.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
afterEach(cleanup);

function mount() {
  return render(React.createElement(I18nProvider, null, React.createElement(SecretVaultConfig, { onClose() {} })));
}

test("按需查看、复制、隐藏密钥，切换记录和重新打开时清除原文", async (t) => {
  const rows = ["latest", "earlier"].map((name) => ({ name, length: 20, addedAt: 1000 }));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/secret-vault") return Response.json({ secrets: rows });
    const { name } = JSON.parse(init.body);
    return Response.json({ value: `fixture-${name}-value` });
  });
  const copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => { copied.push(value); } },
  });
  const view = mount();
  await waitFor(() => assert.equal(view.getAllByRole("button", { name: "View" }).length, 2));
  assert.equal(calls.length, 1);
  assert.equal(view.queryByRole("textbox", { name: "Value" }), null);
  fireEvent.click(view.getAllByRole("button", { name: "View" })[0]);
  await waitFor(() => assert.equal(view.getByRole("textbox", { name: "Value" }).value, "fixture-latest-value"));
  assert.equal(calls[1].init.method, "POST");
  fireEvent.click(view.getByRole("button", { name: "Copy", exact: true }));
  await waitFor(() => assert.deepEqual(copied, ["fixture-latest-value"]));
  assert.ok(view.getByRole("button", { name: "Copied", exact: true }));
  fireEvent.click(view.getByRole("button", { name: "View" }));
  await waitFor(() => assert.equal(view.getByRole("textbox", { name: "Value" }).value, "fixture-earlier-value"));
  assert.equal(view.getAllByRole("textbox", { name: "Value" }).length, 1);
  fireEvent.click(view.getByRole("button", { name: "Hide" }));
  assert.equal(view.queryByRole("textbox", { name: "Value" }), null);
  fireEvent.click(view.getAllByRole("button", { name: "View" })[0]);
  await waitFor(() => assert.ok(view.getByRole("textbox", { name: "Value" })));
  view.unmount();
  const reopened = mount();
  await waitFor(() => assert.equal(reopened.getAllByRole("button", { name: "View" }).length, 2));
  assert.equal(reopened.queryByRole("textbox", { name: "Value" }), null);
});
