import type { SelectedModel } from "@/lib/model-types";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";

export type PendingNewSessionSettings = {
  model: SelectedModel | null;
  thinkingLevel: ThinkingLevelOption;
};

type PendingNewSessionSettingsState = PendingNewSessionSettings & { shadowMindEnabled: boolean };

/**
 * finalize（第二阶段）仍在进行时可能先收到绑定完成事件。
 * 两个事实必须都满足才允许进入 materialized：只记住绑定已完成，别提前解锁发送。
 */
type PendingNewSessionBindingProgress = { bindingDone?: boolean };

export type PendingNewSessionControl =
  | ({ kind: "staged" } & PendingNewSessionSettingsState)
  | ({ kind: "materializing" } & PendingNewSessionSettingsState & PendingNewSessionBindingProgress)
  | ({ kind: "initializing"; sessionId: string } & PendingNewSessionSettingsState & PendingNewSessionBindingProgress)
  | ({ kind: "recovering"; sessionId: string } & PendingNewSessionSettingsState & PendingNewSessionBindingProgress)
  // runtime 已就绪、扩展 session_start 尚未完成：可以展示会话，但还不能发送。
  | ({ kind: "extensions-binding"; sessionId: string } & PendingNewSessionSettingsState)
  | { kind: "materialized"; sessionId: string }
  | { kind: "initialization-failed"; shadowMindEnabled: false; sessionId: string; error: string }
  | ({ kind: "materialization-failed"; sessionId: string; error: string } & PendingNewSessionSettingsState);

export type PendingNewSessionEvent =
  | { type: "SET_SHADOW"; enabled: boolean }
  | { type: "SET_MODEL"; model: SelectedModel }
  | { type: "SET_THINKING_LEVEL"; level: ThinkingLevelOption }
  | { type: "START" }
  | { type: "RUNTIME_CREATED"; sessionId: string }
  | { type: "RETRY" }
  | { type: "READY"; sessionId: string }
  | { type: "EXTENSIONS_PENDING"; sessionId: string }
  | { type: "EXTENSIONS_READY"; sessionId: string }
  | { type: "INIT_FAIL"; sessionId: string; error: string }
  | { type: "POST_START_FAIL"; sessionId: string; error: string }
  | { type: "REQUEST_FAIL"; error: string }
  | { type: "DISCARD" };

export const DEFAULT_PENDING_NEW_SESSION_CONTROL: PendingNewSessionControl = Object.freeze({
  kind: "staged",
  shadowMindEnabled: true,
  model: null,
  thinkingLevel: "auto",
});

export type PendingNewSessionView = {
  busy: boolean;
  shadowPending: boolean;
  desiredShadowMindEnabled: boolean;
  transportSessionId: string | null;
  shadowMode: "staged" | "runtime";
  /** runtime 已就绪但扩展仍在绑定；此时发送会被服务端阻塞等待，UI 应显式等待而不是静默。 */
  extensionsPending: boolean;
  /** 挂载时是否还要继续第二阶段（create 或 finalize）：只有 staged/materializing 之外的在途态为 true。 */
  resumingInitialization: boolean;
  /** runtime 已就绪（含仍在绑定扩展）时可挂载控制的会话身份；初始化未完成或请求失败时为 null。 */
  runtimeSessionId: string | null;
};

export function selectPendingNewSession(state: PendingNewSessionControl): PendingNewSessionView {
  switch (state.kind) {
    case "staged":
      return { busy: false, shadowPending: false, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: null, shadowMode: "staged", extensionsPending: false, resumingInitialization: false, runtimeSessionId: null };
    case "materializing":
      return { busy: true, shadowPending: true, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: null, shadowMode: "staged", extensionsPending: false, resumingInitialization: true, runtimeSessionId: null };
    case "recovering":
    case "initializing":
      return { busy: true, shadowPending: true, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: state.sessionId, shadowMode: "staged", extensionsPending: false, resumingInitialization: true, runtimeSessionId: null };
    case "extensions-binding":
      // 第二阶段已应用 Shadow 预设，运行时状态从此为准；只差扩展绑定完成。
      // 挂载时直接接管这个 runtime（不再走第二阶段），并允许顶部 Shadow 开关指向它。
      return { busy: true, shadowPending: false, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: state.sessionId, shadowMode: "runtime", extensionsPending: true, resumingInitialization: false, runtimeSessionId: state.sessionId };
    case "materialized":
      return { busy: false, shadowPending: false, desiredShadowMindEnabled: true, transportSessionId: state.sessionId, shadowMode: "runtime", extensionsPending: false, resumingInitialization: false, runtimeSessionId: state.sessionId };
    case "initialization-failed":
      return { busy: true, shadowPending: false, desiredShadowMindEnabled: false, transportSessionId: state.sessionId, shadowMode: "staged", extensionsPending: false, resumingInitialization: false, runtimeSessionId: state.sessionId };
    case "materialization-failed":
      // 失败态保留身份但**不自动重试**：挂载只接管 SSE 与快照，重新发起初始化要等显式 RETRY
      // （否则切走再切回会不断重启等待与总期限，错误也留不到用户手里）。
      return { busy: true, shadowPending: false, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: state.sessionId, shadowMode: "runtime", extensionsPending: false, resumingInitialization: false, runtimeSessionId: null };
    default:
      return unreachable(state);
  }
}

/**
 * 创建请求的身份投影：只要状态机已经持有 sessionId，就只能 finalize 同一个 runtime，
 * 只有从未拿到身份的 staged/materializing 才允许 create。
 * 调用方不得再自己枚举 kind——新增等待态漏掉一处就会多建一个 runtime。
 */
export function selectNewSessionRequest(
  view: PendingNewSessionView,
): { operation: "create" } | { operation: "finalize-existing"; sessionId: string } {
  return view.transportSessionId
    ? { operation: "finalize-existing", sessionId: view.transportSessionId }
    : { operation: "create" };
}
function unreachable(value: never): never {
  throw new Error(`未知待创建会话事件：${JSON.stringify(value)}`);
}

/** 未发送会话的唯一状态迁移入口。非法或过期事件保持当前状态。 */
export function reducePendingNewSession(
  state: PendingNewSessionControl,
  event: PendingNewSessionEvent,
): PendingNewSessionControl {
  switch (event.type) {
    case "SET_SHADOW":
      if (state.kind === "staged") return { ...state, shadowMindEnabled: event.enabled };
      if (state.kind === "initialization-failed" && event.enabled) {
        return { kind: "materialized", sessionId: state.sessionId };
      }
      return state;
    case "SET_MODEL":
      return state.kind === "staged" ? { ...state, model: event.model } : state;
    case "SET_THINKING_LEVEL":
      return state.kind === "staged" ? { ...state, thinkingLevel: event.level } : state;
    case "START":
      return state.kind === "staged"
        ? { ...state, kind: "materializing" }
        : state;
    case "RETRY":
      return state.kind === "materialization-failed"
        ? { ...state, kind: "recovering" }
        : state;
    case "RUNTIME_CREATED":
      return state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing"
        ? {
            kind: "initializing",
            sessionId: event.sessionId,
            shadowMindEnabled: state.shadowMindEnabled,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
          }
        : state;
    case "READY":
      return state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing"
        ? { kind: "materialized", sessionId: event.sessionId }
        : state;
    case "EXTENSIONS_PENDING":
      return state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing"
        ? state.bindingDone
          // 绑定已经完成：两个事实都满足，第二阶段读到的“仍在初始化”是旧快照。
          ? { kind: "materialized", sessionId: event.sessionId }
          : {
              kind: "extensions-binding",
              sessionId: event.sessionId,
              shadowMindEnabled: state.shadowMindEnabled,
              model: state.model,
              thinkingLevel: state.thinkingLevel,
            }
        : state;
    // 绑定完成事件可能先于第二阶段响应到达（get_state 读到的是绑定前的快照），
    // 绑定可能先于第二阶段响应完成（get_state 读到的是绑定前的快照）：
    // 此时只记下这个事实并保持等待态，绝不解锁发送，后续 INIT_FAIL/POST_START_FAIL 仍能收敛。
    case "EXTENSIONS_READY":
      if (state.kind === "extensions-binding") return { kind: "materialized", sessionId: event.sessionId };
      if (state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing") {
        return { ...state, bindingDone: true };
      }
      return state;
    case "INIT_FAIL":
      return state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing"
        ? { kind: "initialization-failed", shadowMindEnabled: false, sessionId: event.sessionId, error: event.error }
        : state;
    case "POST_START_FAIL":
      return state.kind === "materializing" || state.kind === "recovering" || state.kind === "initializing" || state.kind === "extensions-binding"
        ? { ...state, kind: "materialization-failed", sessionId: event.sessionId, error: event.error }
        : state;
    case "REQUEST_FAIL":
      if (state.kind === "materializing") {
        return { ...state, kind: "staged" };
      }
      if (state.kind === "recovering") {
        return { ...state, kind: "materialization-failed", error: event.error };
      }
      return state;
    case "DISCARD":
      return DEFAULT_PENDING_NEW_SESSION_CONTROL;
    default:
      return unreachable(event);
  }
}
