import { NextResponse } from "next/server";
import { createTeamRolePreset, listTeamRolePresets } from "@/lib/team-role-presets";

export async function GET() {
  try {
    return NextResponse.json({ presets: listTeamRolePresets() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { name?: unknown; prompt?: unknown };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "角色名称不能为空" }, { status: 400 });
    }
    const preset = await createTeamRolePreset({
      name: body.name,
      prompt: typeof body.prompt === "string" ? body.prompt : "",
    });
    return NextResponse.json({ preset, presets: listTeamRolePresets() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
