import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./thinking-levels";

export type { ThinkingLevelMap };

export interface SelectedModel {
  provider: string;
  modelId: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}


export type ModelsDataDiagnostic =
  | { code: "unknown-level"; modelKey: string; level: string }
  | { code: "unknown-map-level"; modelKey: string; level: string }
  | { code: "unknown-pin"; modelKey: string; level: string };
/** GET /api/models、缓存和客户端共同使用的模型契约。 */
export interface ModelsData {
  models: Record<string, string>;
  modelList: ModelEntry[];
  defaultModel: SelectedModel | null;
  thinkingLevels: Record<string, ThinkingLevel[]>;
  thinkingLevelMaps: Record<string, ThinkingLevelMap>;
  /** `provider/modelId` → enabledModels `:level` 后缀固定的思考等级。 */
  thinkingLevelPins: Record<string, ThinkingLevel>;
  modelError?: string;
  modelScopeWarnings?: string[];
}
