import type { ModelEntry, ModelsData, ModelsDataDiagnostic, SelectedModel, ThinkingLevelMap } from "./model-types";
import { isThinkingLevel, type ThinkingLevel } from "./thinking-levels";

export interface ModelsDataParseResult {
  data: ModelsData;
  diagnostics: ModelsDataDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid models response: ${field} must be an object`);
  return value;
}

function parseModels(value: unknown): Record<string, string> {
  const models: Record<string, string> = {};
  for (const [key, name] of Object.entries(requireRecord(value, "models"))) {
    if (typeof name !== "string") throw new Error(`Invalid models response: models.${key} must be a string`);
    models[key] = name;
  }
  return models;
}

function parseModelList(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid models response: modelList must be an array");
  return value.map((item, index) => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || typeof item.name !== "string"
      || typeof item.provider !== "string"
      || typeof item.fastAvailable !== "boolean"
    ) {
      throw new Error(`Invalid models response: modelList[${index}] is malformed`);
    }
    return { id: item.id, name: item.name, provider: item.provider, fastAvailable: item.fastAvailable };
  });
}

function parseDefaultModel(value: unknown): SelectedModel | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") {
    throw new Error("Invalid models response: defaultModel is malformed");
  }
  return { provider: value.provider, modelId: value.modelId };
}

function parseThinkingLevels(value: unknown, diagnostics: ModelsDataDiagnostic[]): Record<string, ThinkingLevel[]> {
  const result: Record<string, ThinkingLevel[]> = {};
  for (const [modelKey, rawLevels] of Object.entries(requireRecord(value, "thinkingLevels"))) {
    if (!Array.isArray(rawLevels)) throw new Error(`Invalid models response: thinkingLevels.${modelKey} must be an array`);
    result[modelKey] = rawLevels.filter((level): level is ThinkingLevel => {
      if (isThinkingLevel(level)) return true;
      diagnostics.push({ code: "unknown-level", modelKey, level: String(level) });
      return false;
    });
  }
  return result;
}

function parseThinkingMaps(value: unknown, diagnostics: ModelsDataDiagnostic[]): Record<string, ThinkingLevelMap> {
  const result: Record<string, ThinkingLevelMap> = {};
  for (const [modelKey, rawMap] of Object.entries(requireRecord(value, "thinkingLevelMaps"))) {
    const parsed: ThinkingLevelMap = {};
    for (const [level, mapped] of Object.entries(requireRecord(rawMap, `thinkingLevelMaps.${modelKey}`))) {
      if (!isThinkingLevel(level)) {
        diagnostics.push({ code: "unknown-map-level", modelKey, level });
        continue;
      }
      if (typeof mapped !== "string" && mapped !== null) {
        throw new Error(`Invalid models response: thinkingLevelMaps.${modelKey}.${level} must be string or null`);
      }
      parsed[level] = mapped;
    }
    result[modelKey] = parsed;
  }
  return result;
}

function parsePins(value: unknown, diagnostics: ModelsDataDiagnostic[]): Record<string, ThinkingLevel> {
  const result: Record<string, ThinkingLevel> = {};
  for (const [modelKey, level] of Object.entries(requireRecord(value, "thinkingLevelPins"))) {
    if (!isThinkingLevel(level)) {
      diagnostics.push({ code: "unknown-pin", modelKey, level: String(level) });
      continue;
    }
    result[modelKey] = level;
  }
  return result;
}

/** 严格校验必需 DTO 字段；未知等级被过滤并返回结构化诊断。 */
export function parseModelsData(value: unknown): ModelsDataParseResult {
  if (!isRecord(value)) throw new Error("Invalid models response: root must be an object");
  const diagnostics: ModelsDataDiagnostic[] = [];
  return {
    data: {
      models: parseModels(value.models),
      modelList: parseModelList(value.modelList),
      defaultModel: parseDefaultModel(value.defaultModel),
      thinkingLevels: parseThinkingLevels(value.thinkingLevels, diagnostics),
      thinkingLevelMaps: parseThinkingMaps(value.thinkingLevelMaps, diagnostics),
      thinkingLevelPins: parsePins(value.thinkingLevelPins, diagnostics),
      ...(typeof value.modelError === "string" ? { modelError: value.modelError } : {}),
      ...(Array.isArray(value.modelScopeWarnings)
        ? { modelScopeWarnings: value.modelScopeWarnings.filter((item): item is string => typeof item === "string") }
        : {}),
    },
    diagnostics,
  };
}
