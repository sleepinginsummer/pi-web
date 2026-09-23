import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { canRunWithExternalSessionChange } from "@/lib/session-write-policy";
import {
  getRpcSession,
  SessionFileConflictError,
  getRpcSessionSnapshot,
  isShadowSettingCommandResult,
  setRpcSessionTools,
  startRpcSession,
} from "@/lib/rpc-manager";

/**
 * 会话列表只依赖会话文件中的持久化数据。查询类命令不需要淘汰缓存，
 * 其余命令可能追加消息、修改名称或改变分支，应在命令完成后立即刷新列表。
 */
function shouldInvalidateSessionList(commandType: string): boolean {
  return !new Set([
    "get_state",
    "get_tools",
    "get_commands",
    "get_session_stats",
  ]).has(commandType);
}


type SubmitMode = "prompt" | "steer" | "followUp";

function getSubmitMode(commandType: string): SubmitMode | null {
  if (commandType === "prompt") return "prompt";
  if (commandType === "steer") return "steer";
  if (commandType === "follow_up") return "followUp";
  return null;
}

function submitFingerprint(body: Record<string, unknown>): { messageHash: string; messageLength: number } {
  const message = typeof body.message === "string" ? body.message : "";
  return {
    messageHash: createHash("sha256").update(message).digest("hex").slice(0, 16),
    messageLength: message.length,
  };
}

function submitIdentityError(
  routeSessionId: string,
  body: Record<string, unknown>,
  runtimeSessionId?: string,
): Response | null {
  const clientSessionId = typeof body.clientSessionId === "string" ? body.clientSessionId : null;
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  if (clientSessionId === routeSessionId && (!runtimeSessionId || runtimeSessionId === routeSessionId)) return null;

  console.error("[pi-web] 拒绝会话身份不一致的消息提交", {
    requestId,
    clientSessionId,
    routeSessionId,
    runtimeSessionId,
    ...submitFingerprint(body),
  });
  return NextResponse.json({
    error: "会话已切换，消息未发送",
    code: "session_identity_mismatch",
    accepted: false,
  }, { status: 409 });
}
// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = body.type;

    const identityMode = getSubmitMode(body.type);
    if (identityMode) {
      const identityError = submitIdentityError(id, body);
      if (identityError) return identityError;
    }

    // 运行中仍允许 Stop 和只读状态命令；不可确认完整性的文件禁止再写入。
    const current = getRpcSession(id);
    if (current?.isAlive() && current.diskFreshness() !== "current") {
      if (!current.isRunning() && current.evictIfDiskAhead()) {
        // 空闲 wrapper 已淘汰，后续从最新磁盘状态启动。
      } else if (!canRunWithExternalSessionChange(body.type)) {
        console.warn("[pi-web] 会话文件外部修改，拒绝写入命令", { sessionId: id, commandType: body.type });
        return NextResponse.json({ error: "会话文件已被外部修改，请等待写入完成后刷新", code: "session_external_write", accepted: false }, { status: 409 });
      }
    }

    if (body.type === "set_tools") {
      const existing = getRpcSession(id);
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, body.toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }

    let session = getRpcSession(id);
    if (!session?.isAlive()) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      ({ session } = await startRpcSession(id, filePath, undefined));
    }

    if (identityMode) {
      const identityError = submitIdentityError(id, body, session.sessionId);
      if (identityError) return identityError;
    }

    const result = await session.send(body);
    if (shouldInvalidateSessionList(body.type)) invalidateSessionListCache();
    if (isShadowSettingCommandResult(result)) {
      return NextResponse.json({ success: true, data: { enabled: result.enabled } });
    }
    const mode = getSubmitMode(body.type);
    if (mode) {
      console.info("[pi-web] 会话消息提交已接受", {
        requestId: typeof body.requestId === "string" ? body.requestId : undefined,
        clientSessionId: body.clientSessionId,
        routeSessionId: id,
        runtimeSessionId: session.sessionId,
        mode,
        ...submitFingerprint(body),
      });
      return NextResponse.json({ success: true, data: { accepted: true, mode } });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SessionFileConflictError) {
      return NextResponse.json({ error: error.message, code: "session_external_write", accepted: false }, { status: 409 });
    }
    return NextResponse.json({
      error: String(error),
      ...(commandType === "prompt"
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    return NextResponse.json(await getRpcSessionSnapshot(id));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
