import { NextResponse } from "next/server";
import { getAwaitingInputRpcSessionIds, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { disbandTeamWithCleanup, rebuildTeamWithCleanup } from "@/lib/team-runtime";
import { getTeam, TeamEditConflictError, updateTeam } from "@/lib/teams";
import { isThinkingLevel } from "@/lib/thinking-levels";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const team = getTeam(id);
    if (!team) return NextResponse.json({ error: "团队不存在" }, { status: 404 });
    const running = getRunningRpcSessionIds();
    const awaiting = getAwaitingInputRpcSessionIds();
    const memberSessionIds = new Set(team.members.map((member) => member.sessionId));
    return NextResponse.json({
      team,
      runningSessionIds: [...running].filter((sessionId) => memberSessionIds.has(sessionId)),
      awaitingInputSessionIds: [...awaiting].filter((sessionId) => memberSessionIds.has(sessionId)),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json() as { name?: unknown; prompt?: unknown };
    const team = await updateTeam(id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
    });
    return NextResponse.json({ team });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}

/** 重建需要显式确认与版本基线，避免迟到的编辑清空新加入的成员。 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json();
    if (!body || body.confirmRebuild !== true || !Number.isSafeInteger(body.expectedUpdatedAt)) {
      return NextResponse.json({ error: "请确认清空成员并提供编辑时的团队版本" }, { status: 400 });
    }
    if (typeof body.name !== "string" || !body.name.trim() || typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "团队名与工作目录不能为空" }, { status: 400 });
    }
    for (const field of ["prompt", "leaderName", "leaderTitle", "leaderPrompt"]) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
        return NextResponse.json({ error: field + " 必须是字符串" }, { status: 400 });
      }
    }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (Boolean(provider) !== Boolean(modelId)) {
      return NextResponse.json({ error: "provider 和 modelId 必须同时提供" }, { status: 400 });
    }
    if (body.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
      return NextResponse.json({ error: "无效的思考强度" }, { status: 400 });
    }
    const team = await rebuildTeamWithCleanup(id, {
      name: body.name,
      cwd: body.cwd,
      prompt: body.prompt ?? "",
      leaderName: body.leaderName ?? undefined,
      leaderTitle: body.leaderTitle ?? undefined,
      leaderPrompt: body.leaderPrompt ?? "",
      expectedUpdatedAt: body.expectedUpdatedAt,
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
      ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
    });
    return NextResponse.json({ team });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: error instanceof TeamEditConflictError ? 409 : message.includes("不存在") ? 404 : 400 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const removed = await disbandTeamWithCleanup(id);
    if (!removed) return NextResponse.json({ error: "团队不存在" }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
