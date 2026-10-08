import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { writeDefaultPreferences, type DefaultPreferencesEdit } from "./default-preferences";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * 仅持久化浏览器显式选择，避免再次调用会话 setter 产生重复事件和条目。
 * 默认配置的落盘及 SDK 错误检查统一交给 writeDefaultPreferences。
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  const edit: DefaultPreferencesEdit = {};
  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    edit.model = effective.model;
  }

  if (
    explicit.thinkingLevel
    && (effective.supportsThinking || effective.thinkingLevel !== "off")
  ) {
    edit.thinkingLevel = effective.thinkingLevel;
  }

  await writeDefaultPreferences(settingsManager, edit);
  return { modelDefaultChanged: edit.model !== undefined };
}
