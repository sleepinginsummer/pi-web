import type { ThinkingLevel } from "./thinking-levels";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "./types";

/** RPC AgentSession 暴露给客户端的完整运行状态。 */
export interface AgentRuntimeState {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  model?: { id: string; provider: string };
  messageCount: number;
  pendingMessageCount: number;
  queuedMessages: { steering: string[]; followUp: string[] };
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  fastEnabled: boolean;
  fastAvailable: boolean;
  shadowMindEnabled: boolean;
  shadowMindAvailable: boolean;
  extensionStatuses: ExtensionStatusItem[];
  extensionWidgets: ExtensionWidgetItem[];
}

/**
 * 会话运行快照的统一契约：alive 仅表示 RPC wrapper 存活，busy 才表示会话正在执行。
 * UI 不得使用 alive 推断发送/停止状态。
 */
export interface AgentRuntimeSnapshot {
  alive: boolean;
  busy: boolean;
  state?: AgentRuntimeState;
}

export interface AgentSubmitAcknowledgement {
  accepted: true;
  mode: "prompt" | "steer" | "followUp";
}
