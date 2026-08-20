import type { ModelEntry, ModelsDataDiagnostic, SelectedModel, ThinkingLevelMap } from "./model-types";
import type { ThinkingLevel, ThinkingLevelOption } from "./thinking-levels";

/** 模型目录、新会话偏好与思考等级的领域状态。活动会话模型不在此处存储。 */
export interface ModelSelectionState {
  names: Record<string, string>;
  list: ModelEntry[];
  error: string | null;
  scopeWarnings: string[];
  dataDiagnostics: ModelsDataDiagnostic[];
  thinkingLevels: Record<string, ThinkingLevel[]>;
  thinkingLevelMaps: Record<string, ThinkingLevelMap>;
  thinkingLevelPins: Record<string, ThinkingLevel>;
  newSessionModel: SelectedModel | null;
  newSessionDefaultModel: SelectedModel | null;
  thinkingLevel: ThinkingLevelOption;
}

/** ChatInput 消费的只读模型投影；model 由会话运行态单向组合，不写回领域状态。 */
export interface ModelSelectionViewState {
  names: Record<string, string>;
  list: ModelEntry[];
  error: string | null;
  scopeWarnings: string[];
  dataDiagnostics: ModelsDataDiagnostic[];
  thinkingLevel: ThinkingLevelOption;
  model: SelectedModel | null;
  isAutoModelSelection: boolean;
  availableThinkingLevels: readonly ThinkingLevel[] | null;
  thinkingLevelMap: ThinkingLevelMap | null;
}

export interface ModelSelectionViewActions {
  changeModel?: (provider: string, modelId: string) => void;
  changeThinkingLevel?: (level: ThinkingLevelOption) => void;
}
