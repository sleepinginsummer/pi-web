import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { sideChatNameFromText } from "@/lib/session-family";
import { createSideSession, SessionForkError } from "@/lib/session-fork";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionInfo,
  resolveSessionPath,
} from "@/lib/session-reader";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

// 侧聊（ADR 0007）：把会话当前分支复制成隐藏的新会话文件。文件级操作，不启动、不提示也不关闭
// AgentSession，运行中的来源会话不受影响。fork 的普通分叉走 AgentSessionWrapper 的 fork 命令，
// 这里只接受 side 请求。

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

// POST /api/sessions/[id]/fork - body { side: true, name? }; answers with the new session.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");
  const { id } = await params;

  try {
    const body = await req.json().catch(() => null) as { side?: unknown; name?: unknown } | null;
    if (body?.side !== true) return refusal(400, "invalid", "Only side chats are created here");
    const sideName = typeof body.name === "string" ? sideChatNameFromText(body.name) ?? undefined : undefined;
    const wrapper = getRpcSession(id);
    const alive = wrapper?.isAlive() === true;
    const sourcePath = (alive ? wrapper.sessionFile : "") || await resolveSessionPath(id);
    if (!sourcePath) {
      invalidateSessionListCache();
      return refusal(404, "not_found", "Session not found");
    }
    // No await from here until the copy exists: pi appends finished entries synchronously in this
    // process, so the leaf read here and the file read by the copy see the same entries.
    const liveLeafId = alive ? wrapper.inner.sessionManager.getLeafId() : undefined;
    const fork = createSideSession(sourcePath, liveLeafId, sideName);
    cacheSessionPath(fork.sessionId, fork.path);
    invalidateSessionListCache();

    const info = await readSessionInfo(fork.path);
    if (!info) throw new Error("The side chat could not be read");
    const session: SessionInfo = {
      ...info,
      parentSessionId: id,
      relation: { kind: "side", parentSessionId: id },
    };
    return NextResponse.json({ sessionId: fork.sessionId, session }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SessionForkError) {
      if (error.code === "not_found") {
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
        return refusal(404, error.code, error.message);
      }
      return refusal(409, error.code, error.message);
    }
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
