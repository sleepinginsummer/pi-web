import { NextResponse } from "next/server";
import { generateTitleForSessionFile } from "@/lib/session-file-title";
import {
  isValidSessionTitleOperationId,
  type SessionTitleOperationEvent,
} from "@/lib/session-title-events";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAutoNameTask(
  sessionId: string,
  filePath: string,
  session: AgentSessionWrapper,
  operationId: string,
): Promise<void> {
  try {
    // 文件级生成器拥有独立 services/transport，可与主会话安全并行。
    const title = await generateTitleForSessionFile(filePath, { overwrite: true });
    if (!title) {
      throw new Error("The session has no user messages to name or is no longer available");
    }

    invalidateSessionListCache();
    const event: SessionTitleOperationEvent = {
      type: "session_title_updated",
      sessionId,
      operationId,
      title,
    };
    session.emitEvent(event);
  } catch (error) {
    console.error(`[pi-web] failed to generate title for session ${sessionId}:`, errorMessage(error));
    const event: SessionTitleOperationEvent = {
      type: "session_title_error",
      sessionId,
      operationId,
      error: errorMessage(error),
    };
    session.emitEvent(event);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await req.json().catch(() => null) as { operationId?: unknown } | null;
    if (!isValidSessionTitleOperationId(body?.operationId)) {
      return NextResponse.json({ error: "Valid operationId is required" }, { status: 400 });
    }
    const operationId = body.operationId;

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    void runAutoNameTask(id, filePath, session, operationId);
    return NextResponse.json({ status: "accepted", operationId }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
