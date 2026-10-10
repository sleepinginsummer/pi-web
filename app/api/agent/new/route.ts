import { NextResponse } from "next/server";
import type { NewSessionMaterializationResult, NewSessionRuntimeCreated } from "@/lib/new-session-protocol";
import type { AgentRuntimeState } from "@/lib/agent-state";
import { isThinkingLevel, type ThinkingLevel } from "@/lib/thinking-levels";
import { existsSync, realpathSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { getNewSessionOperationRegistry } from "@/lib/new-session-operation-registry";

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

type MaterializationSession = Awaited<ReturnType<typeof startRpcSession>>["session"];

/**
 * 三个响应分支共用的运行时状态投影。新增字段只改这里，
 * 免得 initialization-failed / ensure_session / 首条命令三条返回路径状态不一致。
 */
function materializationRuntimeState(session: MaterializationSession, state: AgentRuntimeState) {
  return {
    model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
    thinkingLevel: state.thinkingLevel,
    shadowMindEnabled: state.shadowMindEnabled,
    shadowMindAvailable: state.shadowMindAvailable,
    extensionsInitializing: session.extensionsInitializing,
    extensionsError: session.extensionsError,
  };
}

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// ensure_session 的 create 阶段仅交付 runtime 身份，供前端接通审批事件；
// finalize-existing 完成初始化后返回模型/思考状态。其它调用继续派发首条命令。
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { operation = "create", sessionId, operationId, provider, modelId, toolNames, thinkingLevel, fastEnabled, shadowMindEnabled, ...promptCommand } = command as { operation?: unknown; sessionId?: unknown; operationId?: unknown; provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; fastEnabled?: unknown; shadowMindEnabled?: unknown; [key: string]: unknown };
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
    if (fastEnabled !== undefined && typeof fastEnabled !== "boolean") {
      throw new Error("fastEnabled must be a boolean");
    }
    if (shadowMindEnabled !== undefined && typeof shadowMindEnabled !== "boolean") {
      throw new Error("shadowMindEnabled must be a boolean");
    }

    const startOptions: MaterializationStartOptions = {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(typeof fastEnabled === "boolean" ? { fastEnabled } : {}),
    };
    const requestedSessionId = typeof sessionId === "string" ? sessionId : undefined;
    const requestedOperationId = typeof operationId === "string" && operationId !== "" ? operationId : undefined;

    // 创建幂等：响应可能因超时/断连丢失，客户端用同一个 operationId 重试时必须拿回同一 runtime。
    // 在途创建也由注册表拥有，并发请求不会并行建出两个 runtime。
    const createsNewSession = operation === "create" && promptCommand.type === "ensure_session";
    if (createsNewSession && requestedOperationId) {
      const registry = getNewSessionOperationRegistry();
      const delivered = registry.peekDelivered(requestedOperationId, cwd);
      if (delivered && getRpcSession(delivered)?.isAlive()) {
        console.info("[pi-web] 复用同一创建意图已交付的 runtime", { sessionId: delivered, cwd });
        return NextResponse.json({
          success: true,
          kind: "runtime-created",
          sessionId: delivered,
        } satisfies NewSessionRuntimeCreated);
      }
      // 已交付但 wrapper 已死（例如被空闲回收）时先清条目，否则重试会拿回失效身份。
      registry.forgetIfUnusable(requestedOperationId, cwd, (sessionId) => getRpcSession(sessionId)?.isAlive() === true);
      const sessionId = await registry.getOrCreate(requestedOperationId, cwd, async () => {
        const created = await resolveMaterializationSession(operation, requestedSessionId, cwd, startOptions);
        allowFileRoot(cwd);
        invalidateSessionListCache();
        console.info("[pi-web] 新会话 runtime 已创建，等待前端接管初始化", { sessionId: created.realSessionId, cwd });
        return created.realSessionId;
      });
      return NextResponse.json({
        success: true,
        kind: "runtime-created",
        sessionId,
      } satisfies NewSessionRuntimeCreated);
    }

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

    // 扩展 session_start 可以等待审批；先交付身份，让前端连接 SSE 并响应，
    // 再通过 finalize-existing 应用 Shadow 预设和等待完整状态，避免循环等待。
    if (operation === "create" && promptCommand.type === "ensure_session") {
      allowFileRoot(cwd);
      invalidateSessionListCache();
      console.info("[pi-web] 新会话 runtime 已创建，等待前端接管初始化", { sessionId: realSessionId, cwd });
      return NextResponse.json({
        success: true,
        kind: "runtime-created",
        sessionId: realSessionId,
      } satisfies NewSessionRuntimeCreated);
    }

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

    const runtimeState = materializationRuntimeState(session, state);

    if (initializationError) {
      const response = {
        success: false,
        kind: "initialization-failed",
        sessionId: realSessionId,
        error: initializationError,
        ...runtimeState,
      } satisfies NewSessionMaterializationResult;
      return NextResponse.json(response, { status: 409 });
    }
    if (promptCommand.type === "ensure_session") {
      const response = {
        success: true,
        kind: "ready",
        sessionId: realSessionId,
        data: null,
        ...runtimeState,
      } satisfies NewSessionMaterializationResult;
      return NextResponse.json(response);
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    const response = {
      success: true,
      kind: "ready",
      sessionId: realSessionId,
      data: result,
      ...runtimeState,
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
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
