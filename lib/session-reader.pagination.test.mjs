// Pagination at the data boundary: a linear session (no branching) degrades into
// a single chain whose depth equals its entry count. The old full-forest read
// transferred the full history and was the trigger for #509 (Maximum call stack
// size exceeded) and #555. Slicing normally stays near O(tail), but preserves a
// complete current turn when one turn itself exceeds the requested page size.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sliceActiveBranch, buildSessionContext } = await jiti.import("./session-reader.ts");
const { computeSessionStats } = await jiti.import("./session-stats.ts");

// Build a linear chain of n entries: e0 -> e1 -> ... -> e(n-1).
function linearChain(n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message",
      timestamp: new Date(1000 + i * 1000).toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` },
    });
  }
  return entries;
}

function userEntry(id, parentId, content) {
  return {
    id,
    parentId,
    type: "message",
    timestamp: new Date(1_000).toISOString(),
    message: { role: "user", content },
  };
}

function assistantEntry(id, parentId, text) {
  return {
    id,
    parentId,
    type: "message",
    timestamp: new Date(2_000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("sliceActiveBranch returns the most-recent `tail` ancestors, in time order", () => {
  const entries = linearChain(100);
  const sliced = sliceActiveBranch(entries, "e99", 50);
  assert.equal(sliced.length, 50);
  assert.equal(sliced[0].id, "e50");
  assert.equal(sliced[sliced.length - 1].id, "e99");
});

test("sliceActiveBranch keeps the requested hard record limit inside a turn", () => {
  const entries = linearChain(10);
  const sliced = sliceActiveBranch(entries, "e5", 3);
  assert.deepEqual(sliced.map((e) => e.id), ["e3", "e4", "e5"]);
});

test("tail pagination bounds a long tool-calling turn", () => {
  const entries = [
    userEntry("old-user", null, "old request"),
    assistantEntry("old-answer", "old-user", "old answer"),
    userEntry("current-user", "old-answer", "current request"),
  ];
  let parentId = "current-user";
  for (let index = 0; index < 80; index++) {
    const assistantId = `assistant-${index}`;
    const resultId = `result-${index}`;
    entries.push({
      id: assistantId,
      parentId,
      type: "message",
      timestamp: new Date(10_000 + index * 2_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: {} }],
      },
    });
    entries.push({
      id: resultId,
      parentId: assistantId,
      type: "message",
      timestamp: new Date(11_000 + index * 2_000).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
      },
    });
    parentId = resultId;
  }
  entries.push(assistantEntry("final-answer", parentId, "done"));

  const context = buildSessionContext(entries, "final-answer", { tail: 50 });

  // tail 是可见消息预算；工具结果不计入，但原始记录仍受每页上限约束。
  assert.ok(context.entryIds.length <= 300);
  assert.notEqual(context.entryIds[0], "current-user");
  assert.equal(context.entryIds.at(-1), "final-answer");
  assert.equal(context.hasMore, true);
});

test("sliceActiveBranch defaults to the last entry when leafId is null", () => {
  const entries = linearChain(7);
  const sliced = sliceActiveBranch(entries, null, 3);
  assert.deepEqual(sliced.map((e) => e.id), ["e4", "e5", "e6"]);
});

test("deep linear chain (5000 entries) slices without overflowing the stack", () => {
  const entries = linearChain(5000);
  // The recursion that #509 hit lived in any path-walk over the full chain.
  // An iterative slice over 5000 entries must not throw Maximum call stack size.
  const sliced = sliceActiveBranch(entries, "e4999", 50);
  assert.equal(sliced.length, 50);
  assert.equal(sliced[sliced.length - 1].id, "e4999");
});

test("buildSessionContext with tail returns the bounded window when it starts at an anchor", () => {
  const entries = linearChain(300);
  const ctx = buildSessionContext(entries, "e299", { tail: 50 });
  assert.equal(ctx.messages.length, 50);
  assert.equal(ctx.entryIds.length, 50);
  assert.equal(ctx.entryIds[0], "e250");
  assert.equal(ctx.entryIds[ctx.entryIds.length - 1], "e299");
  assert.equal(ctx.hasMore, true);
});

test("buildSessionContext without tail still returns the full chain", () => {
  const entries = linearChain(20);
  const ctx = buildSessionContext(entries, "e19");
  assert.equal(ctx.messages.length, 20);
});

test("historical large fields become indexed lazy previews", () => {
  const large = "x".repeat(80 * 1024);
  const entries = [
    {
      id: "large",
      parentId: null,
      type: "message",
      timestamp: new Date(1000).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: large },
          { type: "toolCall", id: "call", name: "bash", arguments: { command: large } },
        ],
      },
    },
  ];
  const context = buildSessionContext(entries, "large", { tail: 50, deferToolResultImages: true, sessionId: "session" });
  const message = context.messages[0];
  assert.equal(message.role, "assistant");
  assert.ok(message.content[0].text.length < large.length);
  assert.match(message.content[0].deferredUrl, /resource=text/);
  assert.match(message.content[1].deferredUrl, /resource=tool-input/);
  assert.ok(JSON.stringify(context).length < 30 * 1024);
});

test("buildSessionContext excludeLeaf pages upward without duplicating `before`", () => {
  // User path: client has [e48..e52], requests the page before e48 (older).
  // excludeLeaf must start from e47's parent so e48 is NOT re-fetched.
  const entries = linearChain(100);
  const page1 = buildSessionContext(entries, "e52", { tail: 5 }).entryIds;
  assert.deepEqual(page1, ["e48", "e49", "e50", "e51", "e52"]);
  const oldest = page1[0]; // e48
  const page2 = buildSessionContext(entries, oldest, { tail: 5, excludeLeaf: true }).entryIds;
  assert.equal(page2[page2.length - 1], "e47");
  assert.ok(!page2.includes(oldest), "page2 must not duplicate the `before` boundary");
  // Adjacent pages share no id -> prepending never double-renders.
  assert.ok(page1.every((id) => !page2.includes(id)));
});

test("pagination stops before the root instead of returning it again", () => {
  const entries = linearChain(3);
  const page = buildSessionContext(entries, "e0", { tail: 5, excludeLeaf: true });
  assert.deepEqual(page.entryIds, []);
  assert.equal(page.hasMore, false);
});

test("pagination cursor follows the raw page boundary across compaction", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: "old" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "t2", message: { role: "assistant", content: "answer" } },
    { id: "u2", parentId: "a1", type: "message", timestamp: "t3", message: { role: "user", content: "kept" } },
    { id: "compact", parentId: "u2", type: "compaction", timestamp: "t4", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
    { id: "u3", parentId: "compact", type: "message", timestamp: "t5", message: { role: "user", content: "new" } },
  ];
  const page1 = buildSessionContext(entries, "u3", { tail: 3 });
  assert.deepEqual(page1.entryIds, ["compact", "u2", "u3"]);
  assert.equal(page1.oldestEntryId, "u2");
  const page2 = buildSessionContext(entries, page1.oldestEntryId, { tail: 3, excludeLeaf: true });
  assert.deepEqual(page2.entryIds, ["u1", "a1"]);
  assert.ok(page2.entryIds.every((id) => !page1.entryIds.includes(id)));
});

test("pagination cursor does not skip a raw entry filtered at a compaction boundary", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: "old" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "t2", message: { role: "assistant", content: "old answer" } },
    { id: "u2", parentId: "a1", type: "message", timestamp: "t3", message: { role: "user", content: "kept" } },
    { id: "compact", parentId: "u2", type: "compaction", timestamp: "t4", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 },
    { id: "u3", parentId: "compact", type: "message", timestamp: "t5", message: { role: "user", content: "new" } },
    { id: "a3", parentId: "u3", type: "message", timestamp: "t6", message: { role: "assistant", content: "new answer" } },
    { id: "u4", parentId: "a3", type: "message", timestamp: "t7", message: { role: "user", content: "latest" } },
  ];
  const page1 = buildSessionContext(entries, "u4", { tail: 3 });
  const page2 = buildSessionContext(entries, page1.oldestEntryId, { tail: 3, excludeLeaf: true });
  const page3 = buildSessionContext(entries, page2.oldestEntryId, { tail: 3, excludeLeaf: true });

  assert.deepEqual(page1.entryIds, ["u3", "a3", "u4"]);
  assert.deepEqual(page2.entryIds, ["compact", "u2"]);
  assert.equal(page2.oldestEntryId, "u2");
  assert.deepEqual(page3.entryIds, ["u1", "a1"]);
});

test("tail pagination preserves settings from earlier entries", () => {
  const entries = linearChain(60);
  entries[0].parentId = "model";
  entries.unshift(
    { id: "thinking", parentId: null, type: "thinking_level_change", timestamp: new Date(0).toISOString(), thinkingLevel: "high" },
    { id: "model", parentId: "thinking", type: "model_change", timestamp: new Date(1).toISOString(), provider: "test", modelId: "full-context-model" },
  );
  const context = buildSessionContext(entries, "e59", { tail: 50 });
  assert.equal(context.thinkingLevel, "high");
  assert.deepEqual(context.model, { provider: "test", modelId: "full-context-model" });
});

test("buildSessionContext accepts a large tail and returns the whole chain", () => {
  const entries = linearChain(5000);
  const ctx = buildSessionContext(entries, "e4999", { tail: 5000 });
  assert.equal(ctx.messages.length, 5000);
  // NOTE: the 1000 cap is enforced at the route layer (Math.min(rawTail, 1000)),
  // see app/api/sessions/[id]/{route,context/route}.test.mjs.
});

test("real sessions may store assistant content as a string (deferThinking guard)", () => {
  // Regression for the long-session 500: entryToUiMessage calls content.map in
  // the deferThinking branch, but real assistant content can be a plain string.
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "hi" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: new Date(2).toISOString(),
      message: { role: "assistant", content: "a string reply, not a block array" } },
  ];
  const ctx = buildSessionContext(entries, "a1", { deferThinking: true, tail: 50 });
  assert.equal(ctx.messages.length, 2);
  assert.deepEqual(ctx.messages[1].content, [{ type: "text", text: "a string reply, not a block array" }]);
});

test("session stats cover the full file independently of the displayed tail", () => {
  const entries = linearChain(100);
  entries[1].message.content = [{ type: "toolCall" }];
  entries[1].message.usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cost: { total: 0.5 },
  };
  entries.push({
    id: "compact",
    parentId: "e99",
    type: "compaction",
    timestamp: new Date(200000).toISOString(),
    summary: "summary",
    firstKeptEntryId: "e90",
    tokensBefore: 10,
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cost: { total: 1.5 },
    },
  });

  assert.deepEqual(computeSessionStats(entries), {
    userMessages: 50,
    assistantMessages: 50,
    toolCalls: 1,
    toolResults: 0,
    totalMessages: 100,
    tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
    cost: 2,
  });
});

// ── 2026-09-03: tail counts VISIBLE messages, not raw entries ──────────────
// Agent-heavy sessions: 1 user question → dozens of assistant+toolResult
// entries. Old raw-entry counting pushed user questions out of the window
// (real case: 15 user / 562 entries, only 1 user visible in a 50-entry page).

function agentHeavyChain(turns) {
  // Per turn: user → assistant(tool_call) → toolResult → assistant(final)
  const entries = [];
  let i = 0;
  const push = (type, message) => {
    entries.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type,
      timestamp: new Date(1000 + i * 1000).toISOString(),
      ...(message !== undefined ? { message } : {}),
    });
    i++;
  };
  for (let t = 0; t < turns; t++) {
    push("message", { role: "user", content: `q${t}` });
    push("message", { role: "assistant", content: [{ type: "tool_call", id: `tc${t}`, name: "bash", arguments: {} }] });
    push("message", { role: "toolResult", content: [{ type: "tool_result", toolUseId: `tc${t}`, output: "ok" }] });
    push("message", { role: "assistant", content: `a${t}` });
  }
  return entries;
}

test("sliceActiveBranch: tail counts visible messages — toolResults ride along free", () => {
  const entries = agentHeavyChain(30); // 120 raw entries, 30 user + 60 assistant visible
  const sliced = sliceActiveBranch(entries, entries[entries.length - 1].id, 10);
  const visible = sliced.filter(
    (e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
  );
  assert.equal(visible.length, 10);
  // Window must end at the newest entry and include the newest user question…
  assert.equal(sliced[sliced.length - 1].id, entries[entries.length - 1].id);
  const users = sliced.filter((e) => e.type === "message" && e.message.role === "user");
  assert.equal(users.length, 3); // 10 visible = 2.5 turns → 3 user questions in window
  // …while raw-entry counting would have shown 50 entries ≈ 1 user question.
});

test("sliceActiveBranch: compaction divider counts as visible, custom/meta do not", () => {
  const entries = [
    { id: "e0", parentId: null, type: "session", timestamp: new Date(0).toISOString() },
    { id: "e1", parentId: "e0", type: "compaction", timestamp: new Date(1).toISOString() },
    { id: "e2", parentId: "e1", type: "custom", timestamp: new Date(2).toISOString() },
    { id: "e3", parentId: "e2", type: "message", timestamp: new Date(3).toISOString(), message: { role: "user", content: "q" } },
    { id: "e4", parentId: "e3", type: "message", timestamp: new Date(4).toISOString(), message: { role: "assistant", content: "a" } },
    { id: "e5", parentId: "e4", type: "message", timestamp: new Date(5).toISOString(), message: { role: "toolResult", content: [] } },
    { id: "e6", parentId: "e5", type: "message", timestamp: new Date(6).toISOString(), message: { role: "assistant", content: "a2" } },
  ];
  const sliced = sliceActiveBranch(entries, "e6", 3);
  // 3 visible = assistant(a2) + assistant(a) + user(q); toolResult e5 rides free.
  assert.deepEqual(sliced.map((e) => e.id), ["e3", "e4", "e5", "e6"]);
  // tail=2 reaches back across the compaction divider instead of stopping at raw count.
  const sliced2 = sliceActiveBranch(entries, "e6", 4);
  assert.deepEqual(sliced2.map((e) => e.id), ["e1", "e2", "e3", "e4", "e5", "e6"]);
});

test("sliceActiveBranch: a span of tool traffic with no visible anchors hits the raw cap", () => {
  // One visible assistant message at the leaf, preceded by 1000 toolResult-only entries.
  const entries = [];
  for (let i = 0; i < 1001; i++) {
    entries.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message",
      timestamp: new Date(1000 + i).toISOString(),
      message: i === 1000 ? { role: "assistant", content: "done" } : { role: "toolResult", content: [] },
    });
  }
  const sliced = sliceActiveBranch(entries, "e1000", 50);
  // tail=50 → raw cap max(200, 300) = 300; the page must not return all 1001 entries.
  assert.equal(sliced.length, 300);
  assert.equal(sliced[sliced.length - 1].id, "e1000");
});

test("buildSessionContext hasMore stays true when the visible window truncates", () => {
  const entries = agentHeavyChain(30);
  const ctx = buildSessionContext(entries, entries[entries.length - 1].id, { tail: 10 });
  assert.equal(ctx.hasMore, true);
  // Second page from the oldest loaded entry (excludeLeaf semantics) must not
  // duplicate it and must surface the next-older user question.
  const oldest = ctx.entryIds[0];
  const page2 = buildSessionContext(entries, oldest, { tail: 10, excludeLeaf: true });
  assert.ok(!page2.entryIds.includes(oldest));
  const users2 = page2.messages.filter((m) => m.role === "user");
  assert.ok(users2.length >= 2);
});
