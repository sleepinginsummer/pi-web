import { NextResponse } from "next/server";
import { jsonError, readMutationBody } from "@/lib/dev-server-api";
import { readReviewToolSettings, REVIEW_TOOL_ID, writeReviewToolSettings } from "@/lib/tool-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Extension tools that read a config of their own. Today only pi-session-review: `/review` uses
// `<agentDir>/pi-session-review/config.json`, so the dialog edits that file instead of keeping a
// second preference the extension would never see.

export async function GET() {
  try {
    return NextResponse.json({ review: readReviewToolSettings() });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

export async function PUT(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (body.tool !== REVIEW_TOOL_ID) return jsonError(400, `tool must be "${REVIEW_TOOL_ID}"`);
  try {
    const review = await writeReviewToolSettings({
      model: body.model ?? null,
      thinkingLevel: body.thinkingLevel,
    });
    return NextResponse.json({ review });
  } catch (error) {
    // 校验失败与文件问题都是 400：请求本身没被接受，界面原样保留用户的选择。
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }
}
