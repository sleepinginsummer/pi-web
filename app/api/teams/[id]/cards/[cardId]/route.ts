import { NextResponse } from "next/server";
import { notifyCardReviewer } from "@/lib/team-runtime";
import type { TeamCardStatus } from "@/lib/team-types";
import { deleteTeamCard, getTeam, TeamCardConflictError, updateTeamCard } from "@/lib/teams";

export async function PATCH(req: Request, context: { params: Promise<{ id: string; cardId: string }> }) {
  try {
    const { id, cardId } = await context.params;
    const body = await req.json() as {
      title?: unknown;
      description?: unknown;
      status?: unknown;
      note?: unknown;
      assignee?: unknown;
      reviewer?: unknown;
      expectedUpdatedAt?: unknown;
    };
    const { card, previousStatus } = await updateTeamCard(id, cardId, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.status === "string" ? { status: body.status as TeamCardStatus } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(body.assignee === null || typeof body.assignee === "string" ? { assignee: body.assignee } : {}),
      ...(body.reviewer === null || typeof body.reviewer === "string" ? { reviewer: body.reviewer } : {}),
      ...(typeof body.expectedUpdatedAt === "number" ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
    }, "user");
    let team = getTeam(id);
    let reviewNotification: { notified: boolean; reviewerName?: string; error?: string } | undefined;
    if (team && card.status === "review" && previousStatus !== "review" && card.reviewerId) {
      reviewNotification = await notifyCardReviewer({
        team,
        card,
        actorName: "用户",
        note: typeof body.note === "string" ? body.note : undefined,
      });
      team = getTeam(id) ?? team;
    }
    return NextResponse.json({ card, team, reviewNotification });
  } catch (error) {
    if (error instanceof TeamCardConflictError) {
      const { id } = await context.params;
      return NextResponse.json(
        { error: error.message, conflict: true, card: error.card, team: getTeam(id) },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string; cardId: string }> }) {
  try {
    const { id, cardId } = await context.params;
    await deleteTeamCard(id, cardId);
    return NextResponse.json({ deleted: true, team: getTeam(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}
