import { NextResponse } from "next/server";
import { isThinkingLevel } from "@/lib/thinking-levels";
import {
  readThinkingLevelRecommendation,
  recordThinkingLevelUsage,
} from "@/lib/thinking-level-preferences";

export async function GET(req: Request) {
  const modelId = new URL(req.url).searchParams.get("modelId")?.trim();
  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }
  return NextResponse.json({ thinkingLevel: readThinkingLevelRecommendation(modelId) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { modelId?: unknown; thinkingLevel?: unknown };
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId || !isThinkingLevel(body.thinkingLevel)) {
      return NextResponse.json({ error: "valid modelId and thinkingLevel are required" }, { status: 400 });
    }
    await recordThinkingLevelUsage({ modelId, thinkingLevel: body.thinkingLevel });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[pi-web] 记录思考强度偏好失败:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
