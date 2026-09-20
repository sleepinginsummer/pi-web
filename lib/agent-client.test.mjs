import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});

test("submit commands bind the request to the target session", async (t) => {
  const originalFetch = globalThis.fetch;
  let submitted;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    submitted = JSON.parse(init.body);
    return Response.json({ success: true, data: { accepted: true, mode: "prompt" } });
  };

  await sendAgentCommand("session-a", { type: "prompt", message: "hello" });

  assert.equal(submitted.clientSessionId, "session-a");
  assert.equal(typeof submitted.requestId, "string");
  assert.ok(submitted.requestId.length > 0);
});

test("rejects oversized prompt bodies before fetch so the draft can be restored", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    fetched = true;
    return new Response();
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "x".repeat(20 * 1024 * 1024) }),
    (error) => {
      assert.equal(isPromptRejectedError(error), true);
      assert.equal(error.status, 413);
      assert.match(error.message, /20MB/);
      return true;
    },
  );
  assert.equal(fetched, false);
});
