import { NextResponse } from "next/server";
import {
  deleteTeamRolePreset,
  listTeamRolePresets,
  TeamRolePresetConflictError,
  updateTeamRolePreset,
} from "@/lib/team-role-presets";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json() as { name?: unknown; prompt?: unknown; expectedUpdatedAt?: unknown };
    const preset = await updateTeamRolePreset(
      id,
      {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.expectedUpdatedAt === "number" ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
      },
      undefined,
      undefined,
      { matchBy: "id" },
    );
    return NextResponse.json({ preset, presets: listTeamRolePresets() });
  } catch (error) {
    if (error instanceof TeamRolePresetConflictError) {
      return NextResponse.json(
        { error: error.message, conflict: true, preset: error.preset, presets: listTeamRolePresets() },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("不存在") ? 404 : 400 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    let expectedUpdatedAt: number | undefined;
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.has("expectedUpdatedAt")) {
      const rawQuery = searchParams.get("expectedUpdatedAt")?.trim() ?? "";
      const parsed = rawQuery === "" ? Number.NaN : Number(rawQuery);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json({ error: "无效的 expectedUpdatedAt 参数" }, { status: 400 });
      }
      expectedUpdatedAt = parsed;
    } else {
      const rawBody = await req.text();
      if (rawBody.trim() !== "") {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          return NextResponse.json({ error: "请求体不是有效的 JSON" }, { status: 400 });
        }
        if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) && "expectedUpdatedAt" in parsedBody) {
          const val = (parsedBody as { expectedUpdatedAt?: unknown }).expectedUpdatedAt;
          if (val !== undefined) {
            if (typeof val !== "number" || !Number.isFinite(val)) {
              return NextResponse.json({ error: "无效的 expectedUpdatedAt 参数" }, { status: 400 });
            }
            expectedUpdatedAt = val;
          }
        }
      }
    }
    const removed = await deleteTeamRolePreset(id, undefined, undefined, {
      matchBy: "id",
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
    });
    if (!removed) return NextResponse.json({ error: "角色预设不存在" }, { status: 404 });
    return NextResponse.json({ deleted: true, id: removed.id, presets: listTeamRolePresets() });
  } catch (error) {
    if (error instanceof TeamRolePresetConflictError) {
      return NextResponse.json(
        { error: error.message, conflict: true, preset: error.preset, presets: listTeamRolePresets() },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
