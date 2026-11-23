import { NextResponse } from "next/server";
import { removeTeamMemberWithCleanup, updateTeamMemberWithPrompt } from "@/lib/team-runtime";
import { getTeam } from "@/lib/teams";

export async function PATCH(req: Request, context: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await context.params;
    const body = await req.json() as { name?: unknown; title?: unknown; prompt?: unknown };
    const member = await updateTeamMemberWithPrompt(id, memberId, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
    });
    return NextResponse.json({ member, team: getTeam(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await context.params;
    const removed = await removeTeamMemberWithCleanup(id, memberId);
    return NextResponse.json({ removed, team: getTeam(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}
