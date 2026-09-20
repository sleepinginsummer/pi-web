import { NextResponse } from "next/server";
import {
  readSidebarPreferences,
  SidebarPreferencesConflictError,
  updateSidebarPreferences,
  type SidebarPreferenceAction,
} from "@/lib/sidebar-preferences";

export const dynamic = "force-dynamic";

const MAX_IDENTIFIERS = 20_000;
const MAX_PROJECT_LENGTH = 4_096;
const MAX_SESSION_ID_LENGTH = 512;

function validString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function stringArray(value: unknown, maxLength: number): string[] | null {
  return Array.isArray(value)
    && value.length <= MAX_IDENTIFIERS
    && value.every((item) => validString(item, maxLength))
    ? value
    : null;
}

function parseAction(value: unknown): SidebarPreferenceAction | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  switch (body.type) {
    case "move_project": {
      const visibleIds = stringArray(body.visibleIds, MAX_PROJECT_LENGTH);
      return validString(body.source, MAX_PROJECT_LENGTH) && validString(body.target, MAX_PROJECT_LENGTH) && visibleIds
        ? { type: body.type, source: body.source, target: body.target, visibleIds }
        : null;
    }
    case "set_project_pinned":
      return validString(body.project, MAX_PROJECT_LENGTH) && typeof body.pinned === "boolean"
        ? { type: body.type, project: body.project, pinned: body.pinned }
        : null;
    case "move_session": {
      const visibleIds = stringArray(body.visibleIds, MAX_SESSION_ID_LENGTH);
      return validString(body.source, MAX_SESSION_ID_LENGTH) && validString(body.target, MAX_SESSION_ID_LENGTH) && visibleIds
        ? { type: body.type, source: body.source, target: body.target, visibleIds }
        : null;
    }
    case "set_session_pinned":
      return validString(body.sessionId, MAX_SESSION_ID_LENGTH) && typeof body.pinned === "boolean"
        ? { type: body.type, sessionId: body.sessionId, pinned: body.pinned }
        : null;
    case "remove_projects": {
      const ids = stringArray(body.ids, MAX_PROJECT_LENGTH);
      return ids ? { type: body.type, ids } : null;
    }
    case "remove_sessions": {
      const ids = stringArray(body.ids, MAX_SESSION_ID_LENGTH);
      return ids ? { type: body.type, ids } : null;
    }
    case "merge_legacy": {
      const sessionOrder = stringArray(body.sessionOrder, MAX_SESSION_ID_LENGTH);
      const pinnedSessionIds = stringArray(body.pinnedSessionIds, MAX_SESSION_ID_LENGTH);
      return sessionOrder && pinnedSessionIds
        ? { type: body.type, sessionOrder, pinnedSessionIds }
        : null;
    }
    default:
      return null;
  }
}

export async function GET() {
  return NextResponse.json({ preferences: readSidebarPreferences() });
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { expectedRevision?: unknown; action?: unknown };
    const action = parseAction(body.action);
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 || !action) {
      return NextResponse.json({ error: "valid expectedRevision and action are required" }, { status: 400 });
    }
    const preferences = await updateSidebarPreferences(body.expectedRevision as number, action);
    return NextResponse.json({ preferences });
  } catch (error) {
    if (error instanceof SidebarPreferencesConflictError) {
      return NextResponse.json({ error: error.message, preferences: error.current }, { status: 409 });
    }
    console.error("[pi-web] 更新侧边栏偏好失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
