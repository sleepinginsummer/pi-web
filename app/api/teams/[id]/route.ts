import { NextResponse } from "next/server";
import { getAwaitingInputRpcSessionIds, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { disbandTeamWithCleanup } from "@/lib/team-runtime";
import { getTeam, updateTeam } from "@/lib/teams";

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
