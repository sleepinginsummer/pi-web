import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendTitleRequestToTrailingUser,
  buildSessionTitleAgentOptions,
  generateSessionTitle,
  limitTitleMessages,
  parseGeneratedSessionTitle,
  prepareTitleMessages,
  sanitizeTitleMessages,
} = await jiti.import("./session-title.ts");

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("cleans common session title response wrappers", () => {
  assert.equal(parseGeneratedSessionTitle("标题：修复 SSE 重连。"), "修复 SSE 重连");
  assert.equal(parseGeneratedSessionTitle('```json\n{"title":"整理 Session 文件夹"}\n```'), "整理 Session 文件夹");
  assert.equal(parseGeneratedSessionTitle('"Improve worktree session grouping"'), "Improve worktree session grouping");
});

test("rejects responses without a usable title", () => {
  assert.throws(() => parseGeneratedSessionTitle("```\n---\n```"), /usable session title/);
});

test("folds the title request into a trailing user message without mutating the source", () => {
  const source = [
    { role: "assistant", content: [], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "Fix the running-session race" }], timestamp: 2 },
  ];

  const prepared = appendTitleRequestToTrailingUser(source);

  assert.deepEqual(prepared.map((message) => message.role), ["assistant", "user"]);
  assert.match(prepared[1].content.at(-1).text, /Create a concise title/);
  assert.equal(source[1].content.length, 1);
  assert.notEqual(prepared[1], source[1]);
});

test("leaves a completed conversation unchanged before adding the title turn", () => {
  const source = [
    { role: "user", content: "Fix it", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
  ];

  assert.equal(appendTitleRequestToTrailingUser(source), source);
});

test("waits for the source reply before sending the title prompt", async () => {
  let sourceReplyFinished = false;
  let providerRoles;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "Implement auto name", timestamp: 1 }],
    },
    waitForIdle: async () => {
      sourceAgent.state.messages.push(assistantMessage("The implementation is complete"));
      sourceReplyFinished = true;
    },
    convertToLlm: (messages) => messages,
    streamFunction: (_model, context) => {
      assert.equal(sourceReplyFinished, true);
      providerRoles = context.messages.map((message) => message.role);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Wait for Complete Agent Reply"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Wait for Complete Agent Reply");
  assert.deepEqual(providerRoles, ["user", "assistant", "user"]);
});

test("generates a title when compaction removed all literal user messages", async () => {
  let providerMessages;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [
        {
          role: "compactionSummary",
          summary: "The user asked to fix title generation after compaction.",
          tokensBefore: 100_000,
          timestamp: 1,
        },
        assistantMessage("The implementation is complete"),
      ],
    },
    waitForIdle: async () => {},
    convertToLlm,
    streamFunction: (_model, context) => {
      providerMessages = context.messages;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Title Generation After Compaction"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Title Generation After Compaction");
  assert.deepEqual(providerMessages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.match(providerMessages[0].content[0].text, /fix title generation after compaction/);
});

test("temporary title agent preserves the provider-facing prefix", async () => {
  const model = { provider: "test", id: "cached-model" };
  const messages = [{ role: "user", content: [{ type: "text", text: "Fix it" }] }];
  const originalExecute = async () => ({ content: [], details: {} });
  const tools = [{
    name: "read",
    label: "read",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
    execute: originalExecute,
  }];
  const convertToLlm = (value) => value;
  const transformContext = async (value) => value;
  const streamFunction = () => { throw new Error("not called"); };
  const source = {
    state: {
      systemPrompt: "cached system prompt",
      model,
      thinkingLevel: "high",
      tools,
      messages,
    },
    convertToLlm,
    transformContext,
    streamFunction,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionId: "source-session-id",
    transport: "sse",
    toolExecution: "parallel",
  };

  const options = buildSessionTitleAgentOptions(source);

  assert.equal(options.initialState.systemPrompt, source.state.systemPrompt);
  assert.equal(options.initialState.model, model);
  assert.equal(options.initialState.thinkingLevel, "high");
  assert.equal(options.initialState.messages, messages);
  assert.equal(options.convertToLlm, convertToLlm);
  assert.equal(options.transformContext, transformContext);
  assert.equal(options.streamFn, streamFunction);
  assert.equal(options.sessionId, "source-session-id");
  const withoutExecute = (tool) => Object.fromEntries(
    Object.entries(tool).filter(([key]) => key !== "execute"),
  );
  assert.deepEqual(
    options.initialState.tools.map(withoutExecute),
    tools.map(withoutExecute),
  );
  assert.notEqual(options.initialState.tools[0].execute, originalExecute);
  await assert.rejects(
    options.initialState.tools[0].execute("call", {}, undefined, undefined),
    /cannot be executed/,
  );
});

test("keeps only tool calls with adjacent matching results", () => {
  const messages = [
    { role: "user", content: "inspect both files", timestamp: 1 },
    {
      ...assistantMessage("Inspecting files"),
      content: [
        { type: "text", text: "Inspecting files" },
        { type: "toolCall", id: "call-complete", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "call-incomplete", name: "read", arguments: { path: "b.txt" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-complete",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 2,
    },
  ];

  const sanitized = sanitizeTitleMessages(messages);

  assert.deepEqual(
    sanitized[1].content.filter((block) => block.type === "toolCall").map((block) => block.id),
    ["call-complete"],
  );
  assert.equal(sanitized[2], messages[2]);
  assert.equal(messages[1].content.length, 3);
});

test("压缩会话首个 user 超出消息预算时从该 user 开始保留", () => {
  const restoredPrefix = Array.from({ length: 70 }, (_, index) => assistantMessage(`恢复前缀 ${index}`));
  const user = { role: "user", content: "检查项目中还有没有其他 bug", timestamp: 2 };
  const reply = assistantMessage("继续检查");

  const limited = limitTitleMessages([...restoredPrefix, user, reply]);

  assert.deepEqual(limited[0], user);
  assert.equal(limited.some((message) => message.role === "user"), true);
  assert.equal(limited.at(-1), reply);
});

test("前缀低于字节预算但加首个 user 后超限时仍保留 user", () => {
  const prefix = [assistantMessage("a".repeat(110 * 1024)), assistantMessage("b".repeat(110 * 1024))];
  const user = { role: "user", content: "目标".repeat(30 * 1024), timestamp: 2 };

  const limited = limitTitleMessages([...prefix, user, assistantMessage("完成")]);

  assert.equal(limited[0].role, "user");
  assert.equal(limited.some((message) => message.role === "user"), true);
});

test("无后续 user 的超大 assistant/tool 链只保留首轮 user", () => {
  const user = { role: "user", content: "修复标题生成", timestamp: 1 };
  const assistant = assistantMessage("响应".repeat(100 * 1024));
  const toolResult = {
    role: "toolResult",
    toolCallId: "large-call",
    toolName: "read",
    content: [{ type: "text", text: "结果".repeat(100 * 1024) }],
    isError: false,
    timestamp: 2,
  };

  const limited = limitTitleMessages([user, assistant, toolResult]);

  assert.deepEqual(limited, [user]);
  assert.ok(Buffer.byteLength(JSON.stringify(limited), "utf8") < 256 * 1024);
});

test("单条超大 user 会按 Unicode 字符截断且追加标题指令后不超预算", () => {
  const user = { role: "user", content: "😀目标".repeat(90 * 1024), timestamp: 1 };

  const limited = limitTitleMessages([user]);
  const prepared = prepareTitleMessages(limited);

  assert.equal(prepared.at(-1).role, "user");
  assert.equal(prepared.length, limited.length);
  assert.ok(limited[0].content.length < user.content.length);
  assert.ok(!limited[0].content.endsWith("\uFFFD"));
  assert.ok(Buffer.byteLength(JSON.stringify(prepared), "utf8") <= 256 * 1024);
});

test("尾部 assistant 路径按实际新增标题 user 后的序列执行预算", () => {
  const user = { role: "user", content: "接近预算".repeat(10 * 1024), timestamp: 1 };
  const assistant = assistantMessage("完成".repeat(10 * 1024));

  const limited = limitTitleMessages([user, assistant]);
  const prepared = prepareTitleMessages(limited);

  assert.equal(limited.at(-1).role, "assistant");
  assert.equal(prepared.at(-1).role, "user");
  assert.equal(prepared.length, limited.length + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared), "utf8") <= 256 * 1024);
});

test("removes incomplete tool calls before invoking the title provider", async () => {
  let providerMessages;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [
        { role: "user", content: "run a command", timestamp: 1 },
        {
          ...assistantMessage(""),
          content: [{
            type: "toolCall",
            id: "call-incomplete",
            name: "bash",
            arguments: { command: "sleep 10" },
          }],
          stopReason: "toolUse",
        },
      ],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: (_model, context) => {
      providerMessages = context.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Sanitized Tool Call History"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Sanitized Tool Call History");
  assert.deepEqual(providerMessages.map((message) => message.role), ["user"]);
  assert.match(providerMessages[0].content, /Create a concise title/);
});

test("aborts title generation when the caller signal fires", async () => {
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "abort me", timestamp: 1 }],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: () => {
      throw new Error("streamFunction must not be called after abort");
    },
    sessionId: "source-session-id",
  };

  // 信号已中止：标题生成立即拒绝，不会构造临时 agent 或调用 streamFunction
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateSessionTitle({ agent: sourceAgent }, controller.signal),
    (error) => error instanceof Error && error.name === "AbortError" && /aborted/i.test(error.message),
  );
});

test("aborts an in-flight title generation mid-run", async () => {
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "run title", timestamp: 1 }],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: (_model, context, options) => {
      // 永不结束的流：只有外部 abort 才能终止这次生成
      const stream = createAssistantMessageEventStream();
      if (options?.signal?.aborted) {
        // abort 可能先于 streamFunction 被调用：立即结束流，避免 runPromise 永久挂起
        stream.push({ type: "done", reason: "aborted", message: assistantMessage("") });
      } else {
        options?.signal?.addEventListener("abort", () => {
          stream.push({ type: "done", reason: "aborted", message: assistantMessage("") });
        }, { once: true });
      }
      return stream;
    },
    sessionId: "source-session-id",
  };

  const controller = new AbortController();
  const pending = generateSessionTitle({ agent: sourceAgent }, controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof Error && error.name === "AbortError"
  );
});
