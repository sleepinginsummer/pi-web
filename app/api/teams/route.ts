import { NextResponse } from "next/server";
import { provisionTeam } from "@/lib/team-runtime";
import { listTeams } from "@/lib/teams";
import { isThinkingLevel } from "@/lib/thinking-levels";

export async function GET() {
  try {
    return NextResponse.json({ teams: listTeams() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      name?: unknown;
      prompt?: unknown;
      cwd?: unknown;
      leaderName?: unknown;
      leaderTitle?: unknown;
      leaderPrompt?: unknown;
      provider?: unknown;
      modelId?: unknown;
      thinkingLevel?: unknown;
    };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "团队名不能为空" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "工作目录不能为空" }, { status: 400 });
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

    const team = await provisionTeam({
      name: body.name,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      cwd: body.cwd,
      leaderName: typeof body.leaderName === "string" ? body.leaderName : undefined,
      leaderTitle: typeof body.leaderTitle === "string" ? body.leaderTitle : undefined,
      leaderPrompt: typeof body.leaderPrompt === "string" ? body.leaderPrompt : undefined,
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return NextResponse.json({ team }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
