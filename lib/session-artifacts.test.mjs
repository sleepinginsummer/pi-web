import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { collectSessionArtifacts, countSessionFileMutations } = await jiti.import("./session-artifacts.ts");

test("collects write outputs in reverse chronological order and skips failed calls", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 1000,
      content: [
        { type: "toolCall", toolCallId: "t1", toolName: "write", input: { path: "docs/plan.md" } },
        { type: "toolCall", toolCallId: "t2", toolName: "write", input: { path: "docs/failed.md" } },
        { type: "toolCall", toolCallId: "t3", toolName: "edit", input: { path: "src/index.ts" } },
      ],
    },
    {
      role: "assistant",
      timestamp: 2000,
      content: [
        { type: "toolCall", toolCallId: "t4", toolName: "write", input: { path: "/tmp/preview.png" } },
        { type: "toolCall", toolCallId: "t5", toolName: "write", input: { path: "docs/plan.md" } },
      ],
    },
  ];
  const toolResults = new Map([
    ["t1", { role: "toolResult", toolCallId: "t1", toolName: "write", content: [], isError: false, timestamp: 1100 }],
    ["t2", { role: "toolResult", toolCallId: "t2", toolName: "write", content: [], isError: true, timestamp: 1200 }],
    ["t3", { role: "toolResult", toolCallId: "t3", toolName: "edit", content: [], isError: false, timestamp: 1300 }],
    ["t4", { role: "toolResult", toolCallId: "t4", toolName: "write", content: [], isError: false, timestamp: 2100 }],
    ["t5", { role: "toolResult", toolCallId: "t5", toolName: "write", content: [], isError: false, timestamp: 2200 }],
  ]);

  const artifacts = collectSessionArtifacts(messages, toolResults, "/repo");
  assert.equal(artifacts.length, 2);
  // docs/plan.md 第二次写入时间最新，排第一位
  assert.equal(artifacts[0].path, "/repo/docs/plan.md");
  assert.equal(artifacts[0].kind, "doc");
  assert.equal(artifacts[1].path, "/tmp/preview.png");
  assert.equal(artifacts[1].kind, "image");
});

test("merges repeated magpie-artifacts publish calls by artifactId and respects hiddenIds", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 1000,
      content: [
        {
          type: "toolCall",
          toolCallId: "p1",
          toolName: "mcp",
          input: {
            tool: "magpie-artifacts_publish_artifact",
            args: { title: "HUD Demo", file_path: "/tmp/demo.html" },
          },
        },
        {
          type: "toolCall",
          toolCallId: "p2",
          toolName: "mcp",
          input: {
            tool: "magpie-artifacts_publish_artifact",
            args: { id: "abc123", version: 1, title: "HUD Demo", file_path: "/tmp/demo.html" },
          },
        },
      ],
    },
  ];
  const toolResults = new Map([
    [
      "p1",
      {
        role: "toolResult",
        toolCallId: "p1",
        toolName: "mcp",
        isError: false,
        content: [{ type: "text", text: 'Published "HUD Demo": http://127.0.0.1:3425/a/abc123/\nid: abc123, version 1.' }],
      },
    ],
    [
      "p2",
      {
        role: "toolResult",
        toolCallId: "p2",
        toolName: "mcp",
        isError: false,
        content: [{ type: "text", text: 'Published version 2 of "HUD Demo": http://127.0.0.1:3425/a/abc123/\nid: abc123, version 2.' }],
      },
    ],
  ]);

  const artifacts = collectSessionArtifacts(messages, toolResults, "/repo");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "web");
  assert.equal(artifacts[0].name, "HUD Demo (v2)");
  assert.equal(artifacts[0].version, 2);
  assert.equal(artifacts[0].path, "http://127.0.0.1:3425/a/abc123/");
  assert.equal(artifacts[0].sourcePath, "/tmp/demo.html");

  const hidden = collectSessionArtifacts(messages, toolResults, "/repo", new Set(["web:abc123"]));
  assert.equal(hidden.length, 0);
});

test("collects codemode nested write calls", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 3000,
      content: [
        { type: "toolCall", toolCallId: "c1", toolName: "codemode", input: { code: "..." } },
      ],
    },
  ];
  const toolResults = new Map([
    [
      "c1",
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "codemode",
        isError: false,
        content: [],
        nestedCalls: {
          calls: [
            { id: "n1", name: "write", arguments: { path: "out/report.html" }, status: "ok" },
            { id: "n2", name: "write", arguments: { path: "out/bad.html" }, status: "error", error: "EACCES" },
            { id: "n3", name: "write", arguments: { path: "out/partial.html" }, status: "unfinished" },
          ],
        },
      },
    ],
  ]);

  const artifacts = collectSessionArtifacts(messages, toolResults, "/repo");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].path, "/repo/out/report.html");
  assert.equal(artifacts[0].kind, "html");
});


test("countSessionFileMutations counts successful direct and nested file edits while ignoring read/failed calls", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 4000,
      content: [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
        { type: "toolCall", toolCallId: "e1", toolName: "replace", input: { remove_from: "aaaaa", remove_to: "aaaaa", text: "x" } },
        { type: "toolCall", toolCallId: "e2", toolName: "edit", input: { path: "b.ts" } },
        { type: "toolCall", toolCallId: "c1", toolName: "codemode", input: { code: "..." } },
      ],
    },
  ];
  const toolResults = new Map([
    ["r1", { role: "toolResult", toolCallId: "r1", toolName: "read", isError: false, content: [] }],
    ["e1", { role: "toolResult", toolCallId: "e1", toolName: "replace", isError: false, content: [] }],
    ["e2", { role: "toolResult", toolCallId: "e2", toolName: "edit", isError: true, content: [] }],
    [
      "c1",
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "codemode",
        isError: false,
        content: [],
        nestedCalls: {
          calls: [
            { id: "n1", name: "replace_match", arguments: {}, status: "ok" },
            { id: "n2", name: "edit", arguments: {}, status: "error", error: "fail" },
            { id: "n3", name: "read", arguments: {}, status: "ok" },
          ],
        },
      },
    ],
  ]);

  assert.equal(countSessionFileMutations(messages, toolResults), 2);
});


test("countSessionFileMutations still counts nested status=ok edits when outer codemode fails with isError=true", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 5000,
      content: [
        { type: "toolCall", toolCallId: "cm-err", toolName: "codemode", input: { code: "..." } },
      ],
    },
  ];
  const toolResults = new Map([
    [
      "cm-err",
      {
        role: "toolResult",
        toolCallId: "cm-err",
        toolName: "codemode",
        isError: true,
        content: [{ type: "text", text: "Error: script failed after replace" }],
        nestedCalls: {
          calls: [
            { id: "n1", name: "replace", arguments: { remove_from: "aaaaa", remove_to: "aaaaa", text: "x" }, status: "ok" },
            { id: "n2", name: "edit", arguments: { path: "b.ts" }, status: "error", error: "boom" },
            { id: "n3", name: "write", arguments: { path: "c.ts" }, status: "unfinished" },
            { id: "n4", name: "read", arguments: { path: "a.ts" }, status: "ok" },
          ],
        },
      },
    ],
  ]);

  assert.equal(countSessionFileMutations(messages, toolResults), 1);
});
