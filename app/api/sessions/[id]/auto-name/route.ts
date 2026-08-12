import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

type AutoNameTaskRegistry = Map<string, Promise<void>>;

const globalRegistry = globalThis as typeof globalThis & {
  __piAutoNameTasks?: AutoNameTaskRegistry;
};
const autoNameTasks = globalRegistry.__piAutoNameTasks ??= new Map();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAutoNameTask(sessionId: string, session: AgentSessionWrapper): Promise<void> {
  // 主会话一旦开始新的运行，立即中止标题生成：标题 agent 与主 agent 复用同一
  // transport/streamFunction，并行运行会相互干扰（可能中断主 agent 的工具循环）。
  const abortController = new AbortController();
  const unsubscribe = session.onEvent((event) => {
    if (event.type === "agent_start") abortController.abort();
  });
  try {
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(
      session.inner as unknown as AgentSession,
      abortController.signal,
    );

    if (abortController.signal.aborted || !session.isAlive()) {
      throw new Error("The session was closed while its title was being generated. Please try again.");
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    session.emitEvent({
      type: "session_title_updated",
      sessionId,
      title: result.title,
      usage: result.usage ?? null,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      // 主会话重新开始运行：标题生成主动让路，不算错误，下次空闲时再触发。
      session.emitEvent({ type: "session_title_skipped", sessionId });
      return;
    }
    console.error(`[pi-web] failed to generate title for session ${sessionId}:`, errorMessage(error));
    session.emitEvent({
      type: "session_title_error",
      sessionId,
      error: errorMessage(error),
    });
  } finally {
    unsubscribe();
    autoNameTasks.delete(sessionId);
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    if (autoNameTasks.has(id)) {
      return NextResponse.json({ status: "running" }, { status: 202 });
    }
    // 会话正在运行时不能生成标题：标题 agent 与主 agent 复用同一 transport，
    // 并行会相互干扰。立即返回 409 明确提示，避免前端空等 15 秒超时。
    if (session.isRunning()) {
      return NextResponse.json(
        { error: "会话正在运行，请等待当前任务结束后再生成标题" },
        { status: 409 },
      );
    }
    const task = runAutoNameTask(id, session);
    autoNameTasks.set(id, task);
    return NextResponse.json({ status: "accepted" }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
