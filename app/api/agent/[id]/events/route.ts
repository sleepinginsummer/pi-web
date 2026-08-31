import { resolveSessionPath, invalidateSessionListCache } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { createAgentEventStream } from "@/lib/agent-event-stream";
import type { AgentEventLike } from "@/lib/agent-event-wire";

export const dynamic = "force-dynamic";

// RPC 包装层会在首条用户 message_end 转发前创建新会话文件；其余 entry 仍由 SDK
// 按 flushed 机制追加。/api/sessions 有 30s 列表缓存，这些持久化边界必须失效缓存，
// 才能让下一次列表拉取立即读取最新会话及消息统计。
function isSessionFlushBoundaryEvent(event: { type?: string; message?: { role?: string } }): boolean {
  if (event.type === "message_end") {
    // 用户消息转发前已确保文件存在，assistant/toolResult 则由 SDK 正常追加。
    return true;
  }
  return event.type === "tool_execution_end" || event.type === "agent_end";
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fast path: already-running session. The cold start remains a promise so
  // the SSE transport can flush headers and heartbeat before SDK startup.
  const existingSession = getRpcSession(id);
  let sessionPromise: Promise<{
    isStreaming: boolean;
    streamingMessage: unknown;
    onEvent(listener: (event: AgentEventLike) => void): () => void;
  }>;
  if (existingSession?.isAlive()) {
    sessionPromise = Promise.resolve(existingSession);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    sessionPromise = startRpcSession(id, filePath, undefined).then(({ session: started }) => started);
  }

  const stream = createAgentEventStream(req, id, sessionPromise, {
    onEvent: (event) => {
      // 新会话文件落盘后立即失效列表缓存（见 isSessionFlushBoundaryEvent 注释）
      if (isSessionFlushBoundaryEvent(event)) invalidateSessionListCache();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
