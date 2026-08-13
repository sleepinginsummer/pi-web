import { resolveSessionPath, invalidateSessionListCache } from "@/lib/session-reader";
import { getRpcSession, startRpcSession, type AgentEvent } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_execution_update"]);

function toClientEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const clientEvent = { ...event };
    delete clientEvent.assistantMessageEvent;
    return clientEvent;
  }
  if (event.type === "agent_end") {
    // 保留权威消息数（不携带完整消息数组以省带宽），供客户端判断
    // 流式是否完整、能否跳过 agent_end 后的全量 context 重载。
    return {
      type: "agent_end",
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
    };
  }
  return event;
}

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

  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    try {
      ({ session } = await startRpcSession(id, filePath, undefined));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      const unsubscribe = session.onEvent((event) => {
        // 新会话文件落盘后立即失效列表缓存（见 isSessionFlushBoundaryEvent 注释）
        if (isSessionFlushBoundaryEvent(event as { type?: string; message?: { role?: string } })) {
          invalidateSessionListCache();
        }
        const clientEvent = toClientEvent(event);
        if (clientEvent) encode(clientEvent);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
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
