import { subscribeAttentionEvents } from "@/lib/attention-events";

export const dynamic = "force-dynamic";

/** 全局交互事件流不依赖当前打开的 ChatWindow，因此后台会话也能立即通知。 */
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      encode({ type: "connected" });

      const unsubscribe = subscribeAttentionEvents((event) => {
        try {
          encode(event);
        } catch {
          // 客户端断开后由 abort 清理订阅。
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // 客户端断开后由 abort 清理定时器。
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* 已关闭 */ }
      };
      req.signal.addEventListener("abort", cleanup, { once: true });
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
