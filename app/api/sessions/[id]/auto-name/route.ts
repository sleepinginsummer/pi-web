import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

type AutoNameTaskRegistry = Map<string, Promise<void>>;

const globalRegistry = globalThis as typeof globalThis & {
  __piAutoNameTasks?: AutoNameTaskRegistry;
};
const autoNameTasks = globalRegistry.__piAutoNameTasks ??= new Map();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAutoNameTask(sessionId: string, session: AgentSessionWrapper): Promise<void> {
  try {
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      throw new Error("The session was closed while its title was being generated. Please try again.");
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    session.emitEvent({
      type: "session_title_updated",
      sessionId,
      title: result.title,
      usage: result.usage ?? null,
    });
  } catch (error) {
    console.error(`[pi-web] failed to generate title for session ${sessionId}:`, errorMessage(error));
    session.emitEvent({
      type: "session_title_error",
      sessionId,
      error: errorMessage(error),
    });
  } finally {
    autoNameTasks.delete(sessionId);
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    if (autoNameTasks.has(id)) {
      return NextResponse.json({ status: "running" }, { status: 202 });
    }

    const task = runAutoNameTask(id, session);
    autoNameTasks.set(id, task);
    return NextResponse.json({ status: "accepted" }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
