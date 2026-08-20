import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const IDLE_TIMEOUT_MS = 15_000;
const TITLE_TIMEOUT_MS = 90_000;
const MAX_TITLE_LENGTH = 80;

function createAbortError(): Error {
  const error = new Error("Session title generation aborted");
  error.name = "AbortError";
  return error;
}
const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

export interface GeneratedSessionTitle {
  title: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function createShadowTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async () => {
      throw new Error("Tools cannot be executed while generating a session title");
    },
  }));
}

/**
 * Build a temporary Agent configuration whose provider-facing prefix matches
 * the source Agent. Tool implementations are replaced without changing their
 * names, descriptions, or schemas, so a naming run cannot mutate the project.
 */
export function buildSessionTitleAgentOptions(source: Agent): AgentOptions {
  const state = source.state;
  return {
    initialState: {
      systemPrompt: state.systemPrompt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      tools: createShadowTools(state.tools),
      messages: state.messages,
    },
    convertToLlm: source.convertToLlm,
    transformContext: source.transformContext,
    streamFn: source.streamFunction,
    getApiKey: source.getApiKey,
    onPayload: source.onPayload,
    onResponse: source.onResponse,
    steeringMode: source.steeringMode,
    followUpMode: source.followUpMode,
    sessionId: source.sessionId,
    thinkingBudgets: source.thinkingBudgets,
    transport: source.transport,
    maxRetryDelayMs: source.maxRetryDelayMs,
    toolExecution: source.toolExecution,
  };
}

/**
 * A running source session usually ends in the user message currently being
 * answered. Fold the title request into a copy of that message so the title
 * request does not send two consecutive user messages to the provider.
 */
export function appendTitleRequestToTrailingUser(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return messages;

  const content = typeof lastMessage.content === "string"
    ? `${lastMessage.content}\n\n${TITLE_PROMPT}`
    : [...lastMessage.content, { type: "text" as const, text: TITLE_PROMPT }];

  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

/** 构造标题 Agent 实际接收的最终消息序列，供预算检查和执行共用。 */
export function prepareTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.at(-1)?.role === "user"
    ? appendTitleRequestToTrailingUser(messages)
    : [...messages, { role: "user", content: TITLE_PROMPT, timestamp: 0 }];
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

function getAssistantResult(agent: Agent, historyLength: number): GeneratedSessionTitle {
  const generatedMessages = agent.state.messages.slice(historyLength);
  for (let i = generatedMessages.length - 1; i >= 0; i--) {
    const message = generatedMessages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The title model request failed");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return {
      title: parseGeneratedSessionTitle(text),
      ...(message.usage ? {
        usage: {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          total: message.usage.totalTokens,
        },
      } : {}),
    };
  }
  throw new Error("The model did not return a session title");
}

export function sanitizeTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  const sanitized: AgentMessage[] = [];
  let expectedToolResultIds: Set<string> | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === "assistant") {
      const followingToolResultIds = new Set<string>();
      for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
        const resultMessage = messages[resultIndex];
        if (resultMessage.role !== "toolResult") break;
        followingToolResultIds.add(resultMessage.toolCallId);
      }

      expectedToolResultIds = new Set<string>();
      const content = message.content.filter((block) => {
        if (block.type !== "toolCall") return true;
        if (!followingToolResultIds.has(block.id)) return false;
        expectedToolResultIds!.add(block.id);
        return true;
      });

      if (content.length > 0) {
        sanitized.push({ ...message, content });
      }
      continue;
    }

    if (message.role === "toolResult") {
      if (expectedToolResultIds?.delete(message.toolCallId)) {
        sanitized.push(message);
      }
      continue;
    }

    expectedToolResultIds = undefined;
    sanitized.push(message);
  }

  return sanitized;
}

/**
 * 标题消息预算：剥离图片并限制 AgentMessage 序列体积。该预算不包含 provider 转换后
 * 的 system prompt、tool schema 等固定前缀，不能视为最终请求 payload 的硬上限。
 */
const MAX_TITLE_MESSAGE_BYTES = 256 * 1024;
const MAX_TITLE_MESSAGES = 60;

function stripTitleImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "user") {
      const content = Array.isArray(message.content)
        ? message.content.filter((block) => block.type !== "image")
        : message.content;
      return { ...message, content };
    }
    if (message.role === "toolResult") {
      return { ...message, content: message.content.filter((block) => block.type !== "image") };
    }
    return message;
  });
}

function groupTitleTurns(messages: AgentMessage[]): { prefix: AgentMessage[]; turns: AgentMessage[][] } {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) return { prefix: [], turns: [] };
  const turns: AgentMessage[][] = [];
  for (const message of messages.slice(firstUserIndex)) {
    if (message.role === "user") turns.push([message]);
    else turns.at(-1)?.push(message);
  }
  return { prefix: messages.slice(0, firstUserIndex), turns };
}

function fitsPreparedTitleBudget(messages: AgentMessage[]): boolean {
  const prepared = prepareTitleMessages(messages);
  return prepared.length <= MAX_TITLE_MESSAGES
    && Buffer.byteLength(JSON.stringify(prepared), "utf8") <= MAX_TITLE_MESSAGE_BYTES;
}

function truncateTitleUserToBudget(message: AgentMessage): AgentMessage {
  if (message.role !== "user") return message;
  const sourceText = typeof message.content === "string"
    ? message.content
    : message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  const characters = Array.from(sourceText);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...message, content: characters.slice(0, middle).join("") };
    if (fitsPreparedTitleBudget([candidate])) low = middle;
    else high = middle - 1;
  }
  return { ...message, content: characters.slice(0, low).join("") };
}

/** 按完整 user turn 限制标题上下文，首轮超限时至少保留经截断的 user 目标。 */
export function limitTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  const { prefix, turns } = groupTitleTurns(stripTitleImages(messages));
  const firstTurn = turns[0];
  if (!firstTurn) return [];

  const withPrefix = [...prefix, ...firstTurn];
  let kept = fitsPreparedTitleBudget(withPrefix)
    ? withPrefix
    : fitsPreparedTitleBudget(firstTurn)
      ? [...firstTurn]
      : [truncateTitleUserToBudget(firstTurn[0])];

  for (const turn of turns.slice(1)) {
    const candidate = [...kept, ...turn];
    if (!fitsPreparedTitleBudget(candidate)) break;
    kept = candidate;
  }
  return kept;
}

export async function generateSessionTitle(source: AgentSession, signal?: AbortSignal): Promise<GeneratedSessionTitle> {
  const sourceAgent = source.agent;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  // 主会话开始新的运行时（auto-name 路由通过 agent_start 触发），立即中止本次标题生成，
  // 避免标题 agent 与主 agent 并行复用同一 transport/streamFunction 相互干扰。
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(createAbortError()), { once: true });
  });
  try {
    await Promise.race([
      sourceAgent.waitForIdle(),
      new Promise<never>((_, reject) => {
        idleTimeout = setTimeout(() => {
          reject(new Error("The session is still running; wait for it to finish before generating a title"));
        }, IDLE_TIMEOUT_MS);
      }),
      aborted,
    ]);
  } finally {
    if (idleTimeout) clearTimeout(idleTimeout);
  }
  const sanitizedMessages = sanitizeTitleMessages(sourceAgent.state.messages);
  // 剥离图片并限制标题消息序列；provider 固定前缀不属于此预算。
  const limitedMessages = limitTitleMessages(sanitizedMessages);
  if (!limitedMessages.some((message) => message.role === "user")) {
    throw new Error("The session has no user messages to name");
  }


  const options = buildSessionTitleAgentOptions(sourceAgent);
  const prepared = prepareTitleMessages(limitedMessages);
  const historyLength = prepared.length;
  options.initialState!.messages = prepared;

  const temporaryAgent = new Agent(options);
  // prepareTitleMessages 保证最终序列以 user 结束，两条路径都直接继续生成。
  const runPromise = temporaryAgent.continue();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error("Session title generation timed out"));
        }, TITLE_TIMEOUT_MS);
      }),
      aborted,
    ]);
  } catch (error) {
    temporaryAgent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return getAssistantResult(temporaryAgent, historyLength);
}
