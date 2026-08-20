import { NextResponse } from "next/server";
import type { NewSessionMaterializationResult } from "@/lib/new-session-protocol";
import type { AgentRuntimeState } from "@/lib/agent-state";
import { isThinkingLevel, type ThinkingLevel } from "@/lib/thinking-levels";
import { existsSync, realpathSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (isThinkingLevel(value)) return value;
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

type MaterializationStartOptions = NonNullable<Parameters<typeof startRpcSession>[3]>;

async function resolveMaterializationSession(
  operation: "create" | "finalize-existing",
  requestedSessionId: string | undefined,
  cwd: string,
  options: MaterializationStartOptions,
): Promise<Awaited<ReturnType<typeof startRpcSession>>> {
  if (operation === "create") {
    return startRpcSession(`__new__${randomUUID()}`, "", cwd, options);
  }
  if (!requestedSessionId) throw new Error("sessionId is required for finalize-existing");
  let wrapper = getRpcSession(requestedSessionId);
  if (!wrapper?.isAlive()) {
    const filePath = await resolveSessionPath(requestedSessionId);
    if (!filePath) throw new Error("Session not found");
    const header = readSessionHeader(filePath);
    if (
      !header
      || header.id !== requestedSessionId
      || realpathSync(header.cwd) !== realpathSync(cwd)
    ) throw new Error("Session identity does not match cwd");
    ({ session: wrapper } = await startRpcSession(requestedSessionId, filePath, undefined));
  }
  if (wrapper.sessionId !== requestedSessionId || realpathSync(wrapper.cwd) !== realpathSync(cwd)) {
    throw new Error("Session identity does not match cwd");
  }
  return { session: wrapper, realSessionId: requestedSessionId };
}

function materializationFailed(sessionId: string, error: unknown): NewSessionMaterializationResult {
  return {
    success: false,
    kind: "materialization-failed",
    sessionId,
    error: error instanceof Error ? error.message : String(error),
  };
}

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { operation = "create", sessionId, provider, modelId, toolNames, thinkingLevel, shadowMindEnabled, ...promptCommand } = command as { operation?: unknown; sessionId?: unknown; provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; shadowMindEnabled?: unknown; [key: string]: unknown };
    if (operation !== "create" && operation !== "finalize-existing") {
      throw new Error(`Invalid new-session operation: ${String(operation)}`);
    }
    if (operation === "finalize-existing" && typeof sessionId !== "string") {
      throw new Error("sessionId is required for finalize-existing");
    }
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    if (shadowMindEnabled !== undefined && typeof shadowMindEnabled !== "boolean") {
      throw new Error("shadowMindEnabled must be a boolean");
    }

    const startOptions: MaterializationStartOptions = {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    };
    const requestedSessionId = typeof sessionId === "string" ? sessionId : undefined;
    let materialization: Awaited<ReturnType<typeof startRpcSession>>;
    try {
      materialization = await resolveMaterializationSession(operation, requestedSessionId, cwd, startOptions);
    } catch (error) {
      if (operation === "finalize-existing" && requestedSessionId) {
        return NextResponse.json(materializationFailed(requestedSessionId, error), { status: 500 });
      }
      throw error;
    }
    const { session, realSessionId } = materialization;

    try {
      if (operation === "finalize-existing" && toolNames) {
        await session.send({ type: "set_tools", toolNames });
      }
      // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    // 默认开启无需调用可选扩展；显式关闭失败时保留并返回同一个 real session，供客户端接管重试。
    let initializationError: string | undefined;
    if (shadowMindEnabled === false) {
      try {
        await session.send({ type: "set_shadow_mind_enabled", enabled: false });
      } catch (error) {
        initializationError = error instanceof Error ? error.message : String(error);
      }
    }
    const state = await session.send({ type: "get_state" }) as AgentRuntimeState;

    if (initializationError) {
      const response = {
        success: false,
        kind: "initialization-failed",
        sessionId: realSessionId,
        error: initializationError,
        model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
        thinkingLevel: state.thinkingLevel,
        shadowMindEnabled: state.shadowMindEnabled,
        shadowMindAvailable: state.shadowMindAvailable,
      } satisfies NewSessionMaterializationResult;
      return NextResponse.json(response, { status: 409 });
    }
    if (promptCommand.type === "ensure_session") {
      const response = {
        success: true,
        kind: "ready",
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        shadowMindEnabled: state.shadowMindEnabled,
        shadowMindAvailable: state.shadowMindAvailable,
      } satisfies NewSessionMaterializationResult;
      return NextResponse.json(response);
    }

    const result = await session.send(promptCommand);

    const response = {
      success: true,
      kind: "ready",
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      shadowMindEnabled: state.shadowMindEnabled,
      shadowMindAvailable: state.shadowMindAvailable,
    } satisfies NewSessionMaterializationResult;
    return NextResponse.json(response);
    } catch (error) {
      const response = {
        success: false,
        kind: "materialization-failed",
        sessionId: realSessionId,
        error: error instanceof Error ? error.message : String(error),
      } satisfies NewSessionMaterializationResult;
      return NextResponse.json(response, { status: 500 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
