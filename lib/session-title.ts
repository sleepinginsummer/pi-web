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
 * 标题上下文限制：剥离图片并限制消息体积，避免超大会话（如含 base64 截图）
 * 触发模型请求 payload 超限（413）。只在完整轮次边界截断，保证
 * toolCall/toolResult 配对不因截断而残缺；标题主要依据开头消息，保留开头即可。
 */
const MAX_TITLE_CONTEXT_BYTES = 256 * 1024;
const MAX_TITLE_CONTEXT_MESSAGES = 60;
function limitTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  const stripped = messages.map((message) => {
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

  let total = 0;
  const kept: AgentMessage[] = [];
  for (const message of stripped) {
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    const overBudget = total + size > MAX_TITLE_CONTEXT_BYTES || kept.length >= MAX_TITLE_CONTEXT_MESSAGES;
    // 只在 user 消息边界截断：该消息不加入，保留内容轮次完整
    if (overBudget && kept.length > 0 && message.role === "user") break;
    kept.push(message);
    total += size;
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
  // 剥离图片并按体积/条数截断，避免超大会话触发模型 payload 超限
  const limitedMessages = limitTitleMessages(sanitizedMessages);
  const historyLength = limitedMessages.length;
  if (!limitedMessages.some((message) => message.role === "user")) {
    throw new Error("The session has no user messages to name");
  }


  const options = buildSessionTitleAgentOptions(sourceAgent);
  options.initialState!.messages = limitedMessages;
  const continuesFromTrailingUser = limitedMessages.at(-1)?.role === "user";
  if (continuesFromTrailingUser) {
    options.initialState!.messages = appendTitleRequestToTrailingUser(limitedMessages);
  }

  const temporaryAgent = new Agent(options);
  const runPromise = continuesFromTrailingUser
    ? temporaryAgent.continue()
    : temporaryAgent.prompt(TITLE_PROMPT);
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
