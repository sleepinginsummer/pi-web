import { NextResponse } from "next/server";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, getRpcSessionSnapshot, isShadowSettingCommandResult, startRpcSession } from "@/lib/rpc-manager";

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
// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    let session = getRpcSession(id);
    if (!session?.isAlive()) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      ({ session } = await startRpcSession(id, filePath, undefined));
    }

    const result = await session.send(body);
    if (shouldInvalidateSessionList(body.type)) invalidateSessionListCache();
    if (isShadowSettingCommandResult(result)) {
      return NextResponse.json({ success: true, data: { enabled: result.enabled } });
    }
    const mode = getSubmitMode(body.type);
    if (mode) {
      return NextResponse.json({ success: true, data: { accepted: true, mode } });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
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
