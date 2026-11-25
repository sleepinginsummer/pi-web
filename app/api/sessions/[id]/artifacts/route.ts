import { NextRequest, NextResponse } from "next/server";
import { listSessionArtifacts } from "@/lib/session-artifacts-server";
import { isValidSessionId } from "@/lib/session-file-references-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 返回当前会话活动分支上的完整产物列表（含所有历史分页）与磁盘仍存在的本地路径集合。 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!isValidSessionId(id)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  const result = await listSessionArtifacts(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { artifacts: result.artifacts, existingPaths: result.existingPaths },
    { headers: { "Cache-Control": "no-store" } },
  );
}
