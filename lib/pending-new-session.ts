import type { SelectedModel } from "@/lib/model-types";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";

export type PendingNewSessionSettings = {
  model: SelectedModel | null;
  thinkingLevel: ThinkingLevelOption;
};

type PendingNewSessionSettingsState = PendingNewSessionSettings & { shadowMindEnabled: boolean };

export type PendingNewSessionControl =
  | ({ kind: "staged" } & PendingNewSessionSettingsState)
  | ({ kind: "materializing" } & PendingNewSessionSettingsState)
  | ({ kind: "recovering"; sessionId: string } & PendingNewSessionSettingsState)
  | { kind: "materialized"; sessionId: string }
  | { kind: "initialization-failed"; shadowMindEnabled: false; sessionId: string; error: string }
  | ({ kind: "materialization-failed"; sessionId: string; error: string } & PendingNewSessionSettingsState);

export type PendingNewSessionEvent =
  | { type: "SET_SHADOW"; enabled: boolean }
  | { type: "SET_MODEL"; model: SelectedModel }
  | { type: "SET_THINKING_LEVEL"; level: ThinkingLevelOption }
  | { type: "START" }
  | { type: "RETRY" }
  | { type: "READY"; sessionId: string }
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
};

export function selectPendingNewSession(state: PendingNewSessionControl): PendingNewSessionView {
  switch (state.kind) {
    case "staged":
      return { busy: false, shadowPending: false, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: null, shadowMode: "staged" };
    case "materializing":
      return { busy: true, shadowPending: true, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: null, shadowMode: "staged" };
    case "recovering":
      return { busy: true, shadowPending: true, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: state.sessionId, shadowMode: "staged" };
    case "materialized":
      return { busy: false, shadowPending: false, desiredShadowMindEnabled: true, transportSessionId: state.sessionId, shadowMode: "runtime" };
    case "initialization-failed":
      return { busy: true, shadowPending: false, desiredShadowMindEnabled: false, transportSessionId: state.sessionId, shadowMode: "staged" };
    case "materialization-failed":
      return { busy: true, shadowPending: false, desiredShadowMindEnabled: state.shadowMindEnabled, transportSessionId: state.sessionId, shadowMode: "runtime" };
    default:
      return unreachable(state);
  }
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
    case "READY":
      return state.kind === "materializing" || state.kind === "recovering"
        ? { kind: "materialized", sessionId: event.sessionId }
        : state;
    case "INIT_FAIL":
      return state.kind === "materializing" || state.kind === "recovering"
        ? { kind: "initialization-failed", shadowMindEnabled: false, sessionId: event.sessionId, error: event.error }
        : state;
    case "POST_START_FAIL":
      return state.kind === "materializing" || state.kind === "recovering"
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
