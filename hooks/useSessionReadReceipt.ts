import { useEffect, useRef } from "react";
import { isMarkRead, needsRead } from "@/lib/unread-markers";
import { isPageAttended, subscribePageAttention } from "@/lib/user-attention";

interface ReadRequest {
  completion: number;
  modified: string | undefined;
  readAt?: number;
}

export function useSessionReadReceipt(
  sessionId: string | null,
  running: boolean,
  modified: string | undefined,
  readAt: number | undefined,
  markedAt: number | undefined,
): void {
  const viewRef = useRef<{
    sessionId: string;
    running: boolean;
    completion: number;
    lastRequest?: ReadRequest;
  } | null>(null);

  useEffect(() => {
    if (!sessionId) {
      viewRef.current = null;
      return;
    }
    if (viewRef.current?.sessionId !== sessionId) {
      viewRef.current = { sessionId, running, completion: 0 };
    }
    const view = viewRef.current;
    // 选中时的 modified 可能一直没变。每次观察到这一会话跑完都需要一条新的已读记录。
    if (view.running && !running) view.completion += 1;
    view.running = running;

    const sendRead = () => {
      if (view.running || !isPageAttended()) return;
      const completion = view.completion;
      const last = view.lastRequest;
      const known = last?.readAt === undefined ? readAt : Math.max(readAt ?? 0, last.readAt);
      const marked = markedAt !== undefined && !isMarkRead(markedAt, known);
      const pending = completion > 0 && last?.completion !== completion;
      if (last?.completion === completion && last.readAt === undefined) return;
      if (last?.completion === completion && last.modified === modified && !marked) return;
      if (!needsRead({ readAt: known, modifiedMs: modified ? Date.parse(modified) : undefined, marked, pending })) return;

      const request: ReadRequest = { completion, modified };
      view.lastRequest = request;
      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/read`, { method: "POST" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const receipt = await response.json() as { readAt: number };
          request.readAt = receipt.readAt;
        })
        .catch((error) => {
          if (view.lastRequest === request) view.lastRequest = last;
          console.error("[pi-web] 更新会话已读失败", error);
        });
    };
    const unsubscribe = subscribePageAttention(sendRead);
    sendRead();
    return unsubscribe;
  }, [markedAt, modified, readAt, running, sessionId]);
}
