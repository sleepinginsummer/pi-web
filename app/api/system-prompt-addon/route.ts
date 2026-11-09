import { NextResponse } from "next/server";
import { jsonError, readMutationBody } from "@/lib/dev-server-api";
import {
  readDefaultSystemPromptAddonText,
  updateSessionSystemPromptAddon,
  viewSessionSystemPromptAddon,
  writeDefaultSystemPromptAddonText,
  type SessionSystemPromptAddon,
} from "@/lib/system-prompt-addon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  return jsonError(error instanceof RangeError ? 400 : 500, error instanceof Error ? error.message : String(error));
}

/** 带 sessionId 读该会话的快照；不带读新会话的默认内容。 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  try {
    return NextResponse.json(sessionId
      ? viewSessionSystemPromptAddon(sessionId)
      : { enabled: false, text: readDefaultSystemPromptAddonText() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 带 sessionId 只改该会话；不带只改默认内容，已开始的会话不受影响。 */
export async function PUT(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  if (body.text !== undefined && typeof body.text !== "string") return jsonError(400, "text must be a string");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return jsonError(400, "enabled must be a boolean");
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !body.sessionId)) {
    return jsonError(400, "sessionId must be a non-empty string");
  }
  try {
    if (typeof body.sessionId === "string") {
      const patch: Partial<SessionSystemPromptAddon> = {
        ...(body.text !== undefined ? { text: body.text as string } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      };
      return NextResponse.json(updateSessionSystemPromptAddon(body.sessionId, patch));
    }
    if (typeof body.text !== "string") return jsonError(400, "text is required without sessionId");
    return NextResponse.json({ enabled: false, text: writeDefaultSystemPromptAddonText(body.text) });
  } catch (error) {
    return errorResponse(error);
  }
}
