import { NextResponse } from "next/server";
import { notifyCardReviewer } from "@/lib/team-runtime";
import type { TeamCardStatus } from "@/lib/team-types";
import { createTeamCard, getTeam } from "@/lib/teams";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json() as {
      title?: unknown;
      description?: unknown;
      status?: unknown;
      assignee?: unknown;
      reviewer?: unknown;
    };
    if (typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    }
    const card = await createTeamCard(id, {
      title: body.title,
      description: typeof body.description === "string" ? body.description : undefined,
      status: typeof body.status === "string" ? (body.status as TeamCardStatus) : undefined,
      assignee: typeof body.assignee === "string" && body.assignee.trim() ? body.assignee : undefined,
      reviewer: typeof body.reviewer === "string" && body.reviewer.trim() ? body.reviewer : undefined,
    }, "user");
    let team = getTeam(id);
    let reviewNotification: { notified: boolean; reviewerName?: string; error?: string } | undefined;
    if (team && card.status === "review" && card.reviewerId) {
      reviewNotification = await notifyCardReviewer({ team, card, actorName: "用户" });
      team = getTeam(id) ?? team;
    }
    return NextResponse.json({ card, team, reviewNotification }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}
