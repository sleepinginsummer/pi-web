import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("does not render completed todo-only assistant messages", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "toolCall", toolCallId: "call-todo", toolName: "todo", input: {} }],
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  });

  assert.equal(html, "");
});

test("does not render completed whitespace-only assistant messages", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: " \n " }],
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  });

  assert.equal(html, "");
});

test("renders image-only assistant messages", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{
      type: "image",
      source: { type: "url", url: "https://example.com/generated.png" },
    }],
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  });

  assert.match(html, /<img/);
  assert.match(html, /src="https:\/\/example\.com\/generated\.png"/);
});

test("does not render image-only assistant messages without a usable source", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "image", source: { type: "url", url: "" } }],
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  });

  assert.equal(html, "");
});

test("does not render image-only user messages without a usable source", () => {
  const html = renderMessage({
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }],
  });

  assert.equal(html, "");
});

test("用户与已完成助手消息都显示新会话动作", () => {
  const onFork = () => {};
  const userHtml = renderMessage(
    { role: "user", content: "问题" },
    { entryId: "user-1", onFork },
  );
  const assistantHtml = renderMessage(
    { role: "assistant", provider: "openai", model: "test", content: [{ type: "text", text: "回答" }] },
    { entryId: "assistant-1", onFork },
  );

  assert.match(userHtml, />New session</);
  assert.match(assistantHtml, />New session</);
  assert.doesNotMatch(userHtml, /Edit from here/);
});

test("流式或工具调用未完成的助手消息不显示新会话动作", () => {
  const message = {
    role: "assistant",
    provider: "openai",
    model: "test",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: {} }],
  };

  const streamingHtml = renderMessage(message, { entryId: "assistant-1", onFork: () => {}, isStreaming: true });
  const unfinishedHtml = renderMessage(message, { entryId: "assistant-1", onFork: () => {}, toolResults: new Map() });

  assert.doesNotMatch(streamingHtml, />New session</);
  assert.doesNotMatch(unfinishedHtml, />New session</);
});

test("guards oversized assistant markdown behind plain-text reveal", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "test",
    content: [{ type: "text", text: "x".repeat(100_001) }],
  });
  assert.match(html, /Message content is very large/);
  assert.doesNotMatch(html, /<p>x{100}/);
});

test("shows streamed tool input state and keeps raw input available", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "test",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "write", input: {}, rawInput: '{"path":' }],
  }, { isStreaming: true });
  assert.match(html, /Generating parameters/);
  assert.match(source, /const inputStr = block\.rawInput \?\?/);
});

test("connects written files, tool-result images, previews, and CJK token estimates", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "test",
    content: [{ type: "text", text: "完成" }],
  }, { writtenFiles: [{ filePath: "/repo/output.txt" }] });
  assert.match(html, /output\.txt/);
  assert.match(source, /const resultImages = getMessageImages\(result\?\.content \?\? \[\]\)/);
  assert.match(source, /CJK_PATTERN/);
  assert.match(source, /estimateUpdatedTokens/);
});

test("运行态处理窗口从渲染前裁掉较早内容块", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "test",
    content: [
      { type: "text", text: "较早处理" },
      { type: "text", text: "最近处理一" },
      { type: "text", text: "最近处理二" },
    ],
  }, { visibleBlockOffset: 1 });

  assert.doesNotMatch(html, /较早处理/);
  assert.match(html, /最近处理一/);
  assert.match(html, /最近处理二/);
  assert.match(source, /prev\.visibleBlockOffset === next\.visibleBlockOffset/);
});
