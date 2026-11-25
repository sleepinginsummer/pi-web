"use client";

import { missingCwdFromBody } from "@/lib/missing-cwd";
import { useCallback, useMemo, useReducer, useRef } from "react";
import { parseModelsData } from "@/lib/model-data-schema";
import { registerModelDisplayNames } from "@/lib/model-brand-icon-store";
import type { SelectedModel } from "@/lib/model-types";
import type { ModelSelectionState } from "@/lib/model-selection-types";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { fetchPreferredThinkingLevel, fetchThinkingLevelRecommendation } from "@/lib/thinking-level-preference-client";
import { parseThinkingLevelOption, resolveDisplayedThinkingLevel, resolvePreferredThinkingLevel, type ThinkingLevel, type ThinkingLevelOption } from "@/lib/thinking-levels";

interface ModelsLoadedPayload {
  state: Pick<ModelSelectionState, "names" | "list" | "error" | "missingCwd" | "isScoped" | "scopeWarnings" | "dataDiagnostics" | "thinkingLevels" | "thinkingLevelMaps" | "thinkingLevelPins">;
  defaultModel?: SelectedModel | null;
  defaultThinkingLevel?: ThinkingLevel | null;
  pinnedThinkingLevel?: ThinkingLevel;
}

export const MODEL_LOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

/** 读取模型接口，并尽量保留服务端返回的具体错误。 */
export async function fetchModelsData(cwd: string, signal?: AbortSignal): Promise<unknown> {
  const url = cwd ? `/api/models?cwd=${encodeURIComponent(cwd)}` : "/api/models";
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    let detail = "";
    let missingCwd: string | null = null;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        detail = body.error;
      }
      missingCwd = missingCwdFromBody(body);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    throw Object.assign(new Error(detail || `Failed to load models (HTTP ${response.status})`), { missingCwd });
  }
  const data: unknown = await response.json();
  signal?.throwIfAborted();
  return data;
}

/** 对临时模型列表故障进行有限重试，取消后立即停止。 */
export async function retryModelLoad(
  load: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await load(signal);
      return;
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (attempt >= MODEL_LOAD_RETRY_DELAYS_MS.length) return;
      await wait(MODEL_LOAD_RETRY_DELAYS_MS[attempt]);
      if (signal.aborted) return;
    }
  }
}

/** 切模解析档位的结果：谁也没抢走才算 applied，被后来的选择取代时交给调用方决定怎么提交。 */
export type ThinkingSwitchOutcome =
  | { status: "applied"; preferredThinking: ThinkingLevel | undefined }
  | { status: "preserved" }
  | { status: "manual" }
  | { status: "superseded" };

export type ModelSelectionAction =
  | { type: "modelsLoaded"; payload: ModelsLoadedPayload; applyNewSessionDefaults: boolean; applyPinnedThinking: boolean }
  | { type: "applyPreferredThinking"; level: ThinkingLevel }
  | { type: "selectNewSessionModel"; model: SelectedModel; thinkingLevel?: ThinkingLevel }
  | { type: "setNewSessionDefaultModel"; model: SelectedModel | null }
  | { type: "modelsLoadFailed"; error: string | null; missingCwd: string | null }
  | { type: "mergeCatalog"; names: Record<string, string>; thinkingLevels: ModelSelectionState["thinkingLevels"]; thinkingLevelMaps: ModelSelectionState["thinkingLevelMaps"] }
  | { type: "setThinkingLevel"; level: ThinkingLevelOption };

export const initialModelSelectionState: ModelSelectionState = {
  names: {},
  list: [],
  error: null,
  missingCwd: null,
  isScoped: false,
  scopeWarnings: [],
  dataDiagnostics: [],
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  newSessionModel: null,
  newSessionDefaultModel: null,
  newSessionDefaultThinkingLevel: null,
  thinkingLevel: "auto",
};

export function modelSelectionReducer(state: ModelSelectionState, action: ModelSelectionAction): ModelSelectionState {
  switch (action.type) {
    case "modelsLoaded":
      return {
        ...state,
        ...action.payload.state,
        ...(action.applyNewSessionDefaults
          ? {
              newSessionDefaultModel: action.payload.defaultModel ?? null,
              newSessionDefaultThinkingLevel: action.payload.defaultThinkingLevel ?? null,
            }
          : {}),
        ...(action.applyNewSessionDefaults && action.applyPinnedThinking && action.payload.pinnedThinkingLevel
          ? { thinkingLevel: action.payload.pinnedThinkingLevel }
          : {}),
      };
    case "applyPreferredThinking":
      return { ...state, thinkingLevel: action.level };
    case "selectNewSessionModel":
      return {
        ...state,
        newSessionModel: action.model,
        ...(action.thinkingLevel ? { thinkingLevel: action.thinkingLevel } : {}),
      };
    case "setNewSessionDefaultModel":
      return { ...state, newSessionDefaultModel: action.model };
    case "mergeCatalog":
      // Models outside `enabledModels` join the maps; what the scope already says wins.
      return {
        ...state,
        names: { ...action.names, ...state.names },
        thinkingLevels: { ...action.thinkingLevels, ...state.thinkingLevels },
        thinkingLevelMaps: { ...action.thinkingLevelMaps, ...state.thinkingLevelMaps },
      };
    case "modelsLoadFailed":
      return {
        ...state,
        names: {},
        list: [],
        error: action.error,
        missingCwd: action.missingCwd,
        scopeWarnings: [],
        dataDiagnostics: [],
        thinkingLevels: {},
        thinkingLevelMaps: {},
        thinkingLevelPins: {},
      };
    case "setThinkingLevel":
      return { ...state, thinkingLevel: action.level };
  }
}

export interface LoadModelsOptions {
  cwd: string;
  initializeNewSession: boolean;
  applyPinnedThinking: boolean;
  signal?: AbortSignal;
  onPreferredThinking?: (model: SelectedModel, level: ThinkingLevel | null) => void;
}
export function useModelSelection() {
  const [state, dispatch] = useReducer(modelSelectionReducer, initialModelSelectionState);
  const loadGateRef = useRef(new LatestRequestGate());
  const thinkingLevelPinsRef = useRef(state.thinkingLevelPins);
  thinkingLevelPinsRef.current = state.thinkingLevelPins;
  // 切换模型要读当前模型的档位与它支持的列表，但动作本身必须保持稳定依赖（[]），
  // 否则每次 state 变化都会重建回调、取消还在路上的档位推荐请求。
  const thinkingLevelsRef = useRef(state.thinkingLevels);
  thinkingLevelsRef.current = state.thinkingLevels;
  const thinkingLevelRef = useRef(state.thinkingLevel);
  thinkingLevelRef.current = state.thinkingLevel;
  // 内部 `auto` 表示"用户没显式选"，界面上此时显示 settings 的默认档位；切模型要拿显示值当兜底。
  const newSessionDefaultThinkingLevelRef = useRef(state.newSessionDefaultThinkingLevel);
  newSessionDefaultThinkingLevelRef.current = state.newSessionDefaultThinkingLevel;
  // 界面显示的是 `newSessionModel ?? newSessionDefaultModel`；切模型时要拿它的支持档位去限幅兜底值。
  const newSessionModelRef = useRef(state.newSessionModel);
  newSessionModelRef.current = state.newSessionModel;
  const newSessionDefaultModelRef = useRef(state.newSessionDefaultModel);
  newSessionDefaultModelRef.current = state.newSessionDefaultModel;
  // 用户（或另一份已采纳的结果）改过档位的次数：切模推荐回来时据此判断这次结果还算不算数。
  // 目录刷新不算——它只关心自己的默认推荐，不能把在途的切模结果作废。
  const thinkingChoiceRevisionRef = useRef(0);

  const load = useCallback(async ({ cwd, initializeNewSession, applyPinnedThinking, signal, onPreferredThinking }: LoadModelsOptions) => {
    const modelsGeneration = loadGateRef.current.begin("models");
    const defaultGeneration = loadGateRef.current.begin("thinking-default");
    try {
      const parsed = parseModelsData(await fetchModelsData(cwd, signal));
      const data = parsed.data;
      const list = data.modelList ?? [];
      const match = data.defaultModel
        ? list.find((model) => model.id === data.defaultModel?.modelId && model.provider === data.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? list[0];
      const defaultModel = displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null;

      if (!loadGateRef.current.isLatest("models", modelsGeneration)) return undefined;
      registerModelDisplayNames(data.models);
      dispatch({
        type: "modelsLoaded",
        applyNewSessionDefaults: initializeNewSession,
        applyPinnedThinking: false,
        payload: {
          state: {
            names: data.models,
            list,
            error: data.modelError ?? null,
            missingCwd: null,
            isScoped: data.isScoped === true,
            scopeWarnings: data.modelScopeWarnings ?? [],
            dataDiagnostics: parsed.diagnostics,
            thinkingLevels: data.thinkingLevels ?? {},
            thinkingLevelMaps: data.thinkingLevelMaps ?? {},
            thinkingLevelPins: data.thinkingLevelPins ?? {},
          },
          defaultModel,
          defaultThinkingLevel: data.defaultThinkingLevel,
        },
      });

      if (!displayModel || !initializeNewSession || !applyPinnedThinking) return undefined;
      // 默认模型的推荐按它自己的 id 查历史得来，草稿选了别的模型时不能套过去：
      // 那会把默认模型的档位（可能还是目标模型不支持的）写到它的首发请求上。此时让服务端按
      // settings.json 的按模型档位 / 默认值决定，界面继续显示草稿已提交的那一档。
      const draftModelMatches = () => {
        const draftModel = newSessionModelRef.current;
        return !draftModel || (draftModel.provider === displayModel.provider && draftModel.modelId === displayModel.id);
      };
      if (!draftModelMatches()) return undefined;
      // 新会话默认档位：pin → 最近的众数，再限幅到该模型支持的档位（模型的默认值不保证它支持）。
      // 两种键格式不能混：pin 来自 `enabledModels` 的 `provider/modelId`，支持档位表由 API 按
      // `provider:modelId` 写出，用斜杠键去查支持列表永远是 undefined，限幅就等于没做。
      const pinKey = `${displayModel.provider}/${displayModel.id}`;
      const supportKey = `${displayModel.provider}:${displayModel.id}`;
      const pin = data.thinkingLevelPins?.[pinKey] ?? null;
      const preferred = resolvePreferredThinkingLevel({
        pin,
        recommendation: pin ? null : (await fetchThinkingLevelRecommendation(displayModel.id, signal) ?? null),
        supported: data.thinkingLevels?.[supportKey] ?? null,
      });
      // `undefined` = 这次加载不适用/已被取代；`null` = 适用，但当前没有推荐值（调用方要据此
      // 作废旧推荐，否则默认模型换了之后旧模型的推荐还留在草稿里）。
      if (!loadGateRef.current.isLatest("thinking-default", defaultGeneration)) return undefined;
      // 取推荐期间草稿可能已经切到别的模型：这份默认推荐不再适用，交给切模自己的结果。
      if (!draftModelMatches()) return undefined;
      onPreferredThinking?.({ provider: displayModel.provider, modelId: displayModel.id }, preferred);
      if (!preferred) {
        dispatch({ type: "setThinkingLevel", level: "auto" });
        return null;
      }
      dispatch({ type: "applyPreferredThinking", level: preferred });
      return preferred;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return undefined;
      if (!loadGateRef.current.isLatest("models", modelsGeneration)) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      // A moved or deleted project folder is not a model problem (#1422).
      const missingCwd = (error as { missingCwd?: string | null }).missingCwd ?? null;
      dispatch({ type: "modelsLoadFailed", error: missingCwd ? null : message, missingCwd });
      throw error;
    } finally {
      loadGateRef.current.finish("models");
      loadGateRef.current.finish("thinking-default");
    }
  }, []);

  /**
   * 选模型：切到别的模型时档位换成它的常用档位（pin → 最近用过的众数 → 旧档位限幅），
   * 重选同一个模型（例如为了应用 models.json 的修改）保持用户刚选的档位。
   */
  const selectNewSessionModel = useCallback(async (
    model: SelectedModel,
    options: { preserveLevel?: boolean } = {},
  ): Promise<ThinkingSwitchOutcome> => {
    // 手动选档算这一次切换期间的干扰：推荐回来时若已经改过档，结果就不再代表用户意图。
    const manualRevision = thinkingChoiceRevisionRef.current;
    loadGateRef.current.invalidate("thinking-default");
    // 兜底值必须是"切之前界面显示的那个档位"：它按切之前的模型限幅（默认 max、模型最高只到 high
    // 时界面显示 high）。直接拿未限幅的原始默认值，切到支持 max 的模型后就会选出一个界面从没
    // 显示过的档位。必须在 dispatch/await 之前取，之后 state 已经是新模型了。
    const previousModel = newSessionModelRef.current ?? newSessionDefaultModelRef.current;
    const previousDisplayedLevel = thinkingLevelRef.current === "auto"
      ? resolveDisplayedThinkingLevel({
          level: "auto",
          fallback: newSessionDefaultThinkingLevelRef.current,
          supported: previousModel
            ? (thinkingLevelsRef.current[`${previousModel.provider}:${previousModel.modelId}`] ?? null)
            : null,
        })
      : thinkingLevelRef.current;
    dispatch({ type: "selectNewSessionModel", model });
    if (options.preserveLevel) return { status: "preserved" };

    // 走自己的 gate 通道：目录刷新（load）重新开始 "thinking-default" 时只作废它自己的默认推荐，
    // 不能把这次切模的推荐也一起废掉，否则切模会退回用上一个模型的档位提交。
    const generation = loadGateRef.current.begin("thinking-switch");
    try {
      const preferred = await fetchPreferredThinkingLevel({
        model,
        pins: thinkingLevelPinsRef.current,
        supported: thinkingLevelsRef.current[`${model.provider}:${model.modelId}`] ?? null,
        // 兜底（没有 pin、也没有历史众数时）用切之前界面显示的档位，这里再按目标模型限幅一次。
        current: previousDisplayedLevel,
      });
      // 用户在这次切换期间手动选了档：结果作废，模型仍要由调用方提交，档位用用户刚选的那个。
      if (thinkingChoiceRevisionRef.current !== manualRevision) {
        return { status: "manual" };
      }
      if (!loadGateRef.current.isLatest("thinking-switch", generation)) {
        return { status: "superseded" };
      }
      if (preferred && preferred !== thinkingLevelRef.current) {
        dispatch({ type: "applyPreferredThinking", level: preferred });
      }
      return { status: "applied", preferredThinking: preferred ?? undefined };
    } finally {
      loadGateRef.current.finish("thinking-switch");
    }
  }, []);

  const setThinkingLevel = useCallback((level: unknown) => {
    loadGateRef.current.invalidate("thinking-default");
    thinkingChoiceRevisionRef.current += 1;
    dispatch({ type: "setThinkingLevel", level: parseThinkingLevelOption(level) });
  }, []);

  const actions = useMemo(() => ({
    mergeCatalog: (catalog: { names: Record<string, string>; thinkingLevels: ModelSelectionState["thinkingLevels"]; thinkingLevelMaps: ModelSelectionState["thinkingLevelMaps"] }) => {
      dispatch({ type: "mergeCatalog", ...catalog });
    },
    load,
    selectNewSessionModel,
    setNewSessionDefaultModel: (model: SelectedModel | null) => dispatch({ type: "setNewSessionDefaultModel", model }),
    setThinkingLevel,
  }), [load, selectNewSessionModel, setThinkingLevel]);

  return { modelState: state, modelActions: actions };
}

export type ModelSelectionActions = ReturnType<typeof useModelSelection>["modelActions"];
