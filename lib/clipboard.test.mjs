import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { copyText } = await jiti.import("./clipboard.ts");

test("falls back to execCommand when Clipboard API rejects", async () => {
  const calls = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text) {
        calls.push(["clipboard", text]);
        throw new Error("permission denied");
      },
    },
  });
  document.execCommand = (command) => {
    calls.push(["execCommand", command, document.querySelector("textarea")?.value]);
    return true;
  };

  await copyText("complete diagnostic text");

  assert.deepEqual(calls, [
    ["clipboard", "complete diagnostic text"],
    ["execCommand", "copy", "complete diagnostic text"],
  ]);
  assert.equal(document.querySelector("textarea"), null);
});

test("rejects when both clipboard paths fail and still removes the textarea", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("permission denied"); } },
  });
  document.execCommand = () => false;

  await assert.rejects(copyText("diagnostic text"), /Copy command was rejected/);
  assert.equal(document.querySelector("textarea"), null);
});
