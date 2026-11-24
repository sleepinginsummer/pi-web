import type { SelectedModel } from "@/lib/model-types";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
import type { ToolPreset } from "@/lib/tool-presets";

/**
 * 档位是谁定的：`manual` = 用户在选择器里挑的，`auto` = 切模型时按 pin/众数/兜底解析出来的。
 * 草稿切走后重新挂载要据此决定填回哪个 ref——否则自动推荐档会变成"用户显式选的档"。
 */
export type ThinkingLevelSource = "auto" | "manual";

/** 草稿选中的工具档位：创建入口按它取名单，浏览器偏好只负责初始化。 */
export type PendingNewSessionTools = { preset: ToolPreset; custom: string[] | null };

export type PendingNewSessionSettings = {
  model: SelectedModel | null;
  thinkingLevel: ThinkingLevelOption;
  thinkingLevelSource: ThinkingLevelSource;
  /**
   * 用户手动改过几次档位（自动推荐不计）。切模的档位是异步解析的，解析期间用户可能切走再
   * 回来、在另一个实例里手动改档：提交时带上发起时的修订号，对不上就只提交模型、保留这次手改。
   */
  levelRevision?: number;
  /** 自动推荐适用的模型；默认模型刷新后不能把旧模型的档位交给新模型。 */
  recommendationModel?: SelectedModel | null;
  /**
   * 工具档位。必须存在草稿里而不是只写浏览器偏好：偏好是整台浏览器共用的一份，别的标签页
   * 改它会让当前输入框显示的档位和创建请求用的名单分叉；写入失败（隐私模式、配额）时更是
   * 界面已经变了、创建还按旧名单。
   */
  tools?: PendingNewSessionTools | null;
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
  // 模型与解析后的档位一起提交：只更新模型会留下一段「新模型 + 旧档位」的窗口，
  // 用户正好在窗口里切走再回来，重建的组件就会把旧档位套到新模型上。
  | {
      type: "SET_MODEL";
      model: SelectedModel;
      thinkingLevel?: ThinkingLevelOption;
      thinkingLevelSource?: ThinkingLevelSource;
      /** 发起这次切换时的 `levelRevision`：期间用户手动改过档就只提交模型。 */
      levelRevisionAtStart?: number;
    }
  | { type: "SET_THINKING_LEVEL"; level: ThinkingLevelOption; source?: ThinkingLevelSource; recommendationModel?: SelectedModel | null }
  | { type: "SET_TOOLS"; tools: PendingNewSessionTools }
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
  // 新会话默认关闭 Shadow：绑定后由 wrapper 恢复为关闭，只有用户显式打开才发送开启请求。
  shadowMindEnabled: false,
  model: null,
  thinkingLevel: "auto",
  thinkingLevelSource: "auto",
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
    case "SET_MODEL": {
      if (state.kind !== "staged") return state;
      // 切模期间用户手动改过档位：这次推荐已经过时，只提交模型、保留用户刚选的那一档。
      // 改档可能发生在另一个实例里（切走再回来重建的那个），所以比的是草稿自己的修订号。
      const keepLevel = event.levelRevisionAtStart !== undefined
        && (state.levelRevision ?? 0) !== event.levelRevisionAtStart;
      return {
        ...state,
        model: event.model,
        ...(state.recommendationModel ? { recommendationModel: null } : {}),
        ...(event.thinkingLevel && !keepLevel
          ? { thinkingLevel: event.thinkingLevel, thinkingLevelSource: event.thinkingLevelSource ?? "auto" }
          : {}),
      };
    }
    case "SET_THINKING_LEVEL": {
      if (state.kind !== "staged") return state;
      // 只有用户自己挑的档位推进修订号：目录刷新带来的自动推荐不该否决还在路上的切模结果。
      // 没推进就不落这个字段，草稿形状对没改过档的会话保持原样。
      const source = event.source ?? "manual";
      const bumped = source === "manual";
      return {
        ...state,
        thinkingLevel: event.level,
        thinkingLevelSource: source,
        ...(bumped ? { levelRevision: (state.levelRevision ?? 0) + 1 } : {}),
        ...(event.recommendationModel !== undefined || state.recommendationModel
          ? { recommendationModel: source === "auto" ? event.recommendationModel ?? null : null }
          : {}),
      };
    }
    case "SET_TOOLS":
      return state.kind === "staged" ? { ...state, tools: event.tools } : state;
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
            thinkingLevelSource: state.thinkingLevelSource,
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
              thinkingLevelSource: state.thinkingLevelSource,
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
