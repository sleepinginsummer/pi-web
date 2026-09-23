"use client";

import { useCallback, useMemo, useReducer, useRef } from "react";
import { parseModelsData } from "@/lib/model-data-schema";
import type { SelectedModel } from "@/lib/model-types";
import type { ModelSelectionState } from "@/lib/model-selection-types";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { fetchThinkingLevelRecommendation } from "@/lib/thinking-level-preference-client";
import { parseThinkingLevelOption, type ThinkingLevel, type ThinkingLevelOption } from "@/lib/thinking-levels";

interface ModelsLoadedPayload {
  state: Pick<ModelSelectionState, "names" | "list" | "error" | "scopeWarnings" | "dataDiagnostics" | "thinkingLevels" | "thinkingLevelMaps" | "thinkingLevelPins">;
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
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        detail = body.error;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    throw new Error(detail || `Failed to load models (HTTP ${response.status})`);
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

export type ModelSelectionAction =
  | { type: "modelsLoaded"; payload: ModelsLoadedPayload; applyNewSessionDefaults: boolean; applyPinnedThinking: boolean }
  | { type: "applyPreferredThinking"; level: ThinkingLevel }
  | { type: "selectNewSessionModel"; model: SelectedModel; thinkingLevel?: ThinkingLevel }
  | { type: "setNewSessionDefaultModel"; model: SelectedModel | null }
  | { type: "modelsLoadFailed"; error: string }
  | { type: "setThinkingLevel"; level: ThinkingLevelOption };

export const initialModelSelectionState: ModelSelectionState = {
  names: {},
  list: [],
  error: null,
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
    case "modelsLoadFailed":
      return {
        ...state,
        names: {},
        list: [],
        error: action.error,
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
}
export function useModelSelection() {
  const [state, dispatch] = useReducer(modelSelectionReducer, initialModelSelectionState);
  const loadGateRef = useRef(new LatestRequestGate());
  const thinkingLevelPinsRef = useRef(state.thinkingLevelPins);
  thinkingLevelPinsRef.current = state.thinkingLevelPins;

  const load = useCallback(async ({ cwd, initializeNewSession, applyPinnedThinking, signal }: LoadModelsOptions) => {
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
      dispatch({
        type: "modelsLoaded",
        applyNewSessionDefaults: initializeNewSession,
        applyPinnedThinking: false,
        payload: {
          state: {
            names: data.models,
            list,
            error: data.modelError ?? null,
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
      const pinned = data.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      const preferred = pinned ?? (await fetchThinkingLevelRecommendation(displayModel.id, signal) ?? undefined);
      if (!preferred || !loadGateRef.current.isLatest("thinking-default", defaultGeneration)) return undefined;
      dispatch({ type: "applyPreferredThinking", level: preferred });
      return preferred;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return undefined;
      if (!loadGateRef.current.isLatest("models", modelsGeneration)) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "modelsLoadFailed", error: message });
      throw error;
    } finally {
      loadGateRef.current.finish("models");
      loadGateRef.current.finish("thinking-default");
    }
  }, []);

  const selectNewSessionModel = useCallback(async (
    model: SelectedModel,
    applyDefaultThinking: boolean,
  ) => {
    loadGateRef.current.invalidate("thinking-default");
    dispatch({ type: "selectNewSessionModel", model });
    if (!applyDefaultThinking) return { committed: true, preferredThinking: undefined };

    const generation = loadGateRef.current.begin("thinking-default");
    try {
      const pinned = thinkingLevelPinsRef.current[`${model.provider}/${model.modelId}`];
      const preferredThinking = pinned ?? (await fetchThinkingLevelRecommendation(model.modelId) ?? undefined);
      if (!loadGateRef.current.isLatest("thinking-default", generation)) {
        return { committed: false, preferredThinking: undefined };
      }
      if (preferredThinking) dispatch({ type: "applyPreferredThinking", level: preferredThinking });
      return { committed: true, preferredThinking };
    } finally {
      loadGateRef.current.finish("thinking-default");
    }
  }, []);

  const setThinkingLevel = useCallback((level: unknown) => {
    loadGateRef.current.invalidate("thinking-default");
    dispatch({ type: "setThinkingLevel", level: parseThinkingLevelOption(level) });
  }, []);

  const actions = useMemo(() => ({
    load,
    selectNewSessionModel,
    setNewSessionDefaultModel: (model: SelectedModel | null) => dispatch({ type: "setNewSessionDefaultModel", model }),
    setThinkingLevel,
  }), [load, selectNewSessionModel, setThinkingLevel]);

  return { modelState: state, modelActions: actions };
}

export type ModelSelectionActions = ReturnType<typeof useModelSelection>["modelActions"];
