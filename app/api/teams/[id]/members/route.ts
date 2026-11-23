import { NextResponse } from "next/server";
import { provisionTeamMember } from "@/lib/team-runtime";
import { getTeam } from "@/lib/teams";
import { isThinkingLevel } from "@/lib/thinking-levels";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json() as {
      name?: unknown;
      title?: unknown;
      prompt?: unknown;
      cwd?: unknown;
      provider?: unknown;
      modelId?: unknown;
      thinkingLevel?: unknown;
    };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "成员名不能为空" }, { status: 400 });
    }
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined;
    const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : undefined;
    if ((provider && !modelId) || (!provider && modelId)) {
      return NextResponse.json({ error: "provider 和 modelId 必须同时提供" }, { status: 400 });
    }
    const thinkingLevel = body.thinkingLevel !== undefined && body.thinkingLevel !== "" && body.thinkingLevel !== "auto"
      ? (isThinkingLevel(body.thinkingLevel) ? body.thinkingLevel : null)
      : undefined;
    if (thinkingLevel === null) {
      return NextResponse.json({ error: `无效的思考强度: ${String(body.thinkingLevel)}` }, { status: 400 });
    }

    const member = await provisionTeamMember({
      teamId: id,
      name: body.name,
      title: typeof body.title === "string" ? body.title : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined,
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return NextResponse.json({ member, team: getTeam(id) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}
