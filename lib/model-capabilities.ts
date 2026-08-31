import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getFastModelKey } from "./fast-mode";

const FAST_MODEL_CAPABILITIES_FILE = "pi-web-model-capabilities.json";

interface ModelCapabilityConfig {
  fastModels: string[];
}


export function getModelCapabilitiesPath(): string {
  return join(getAgentDir(), FAST_MODEL_CAPABILITIES_FILE);
}

export function readFastModelCapabilities(
  path = getModelCapabilitiesPath(),
): ReadonlySet<string> {
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelCapabilityConfig>;
    return new Set(Array.isArray(data.fastModels)
      ? data.fastModels.filter((key): key is string => typeof key === "string")
      : []);
  } catch {
    return new Set();
  }
}

export function writeFastModelCapabilities(
  fastModels: Iterable<string>,
  path = getModelCapabilitiesPath(),
): void {
  const data: ModelCapabilityConfig = {
    fastModels: [...new Set(fastModels)].sort(),
  };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将 sidecar 能力合并为仅供 pi-web 模型表单使用的临时字段。 */
export function mergeFastModelCapabilities(
  modelsConfig: Record<string, unknown>,
  fastModels: ReadonlySet<string>,
): Record<string, unknown> {
  const merged = structuredClone(modelsConfig);
  if (!isRecord(merged.providers)) return merged;
  for (const [providerId, provider] of Object.entries(merged.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== "string") continue;
      if (fastModels.has(getFastModelKey(providerId, model.id))) model.fast = true;
    }
  }
  return merged;
}

/** 剥离 UI 临时字段，并以当前模型快照重建能力键，自动清理删除或重命名后的残留。 */
export function extractFastModelCapabilities(
  modelsConfig: Record<string, unknown>,
): { modelsConfig: Record<string, unknown>; fastModels: ReadonlySet<string> } {
  const cleaned = structuredClone(modelsConfig);
  const fastModels = new Set<string>();
  if (!isRecord(cleaned.providers)) return { modelsConfig: cleaned, fastModels };
  for (const [providerId, provider] of Object.entries(cleaned.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model)) continue;
      if (model.fast === true && typeof model.id === "string") {
        fastModels.add(getFastModelKey(providerId, model.id));
      }
      delete model.fast;
    }
  }
  return { modelsConfig: cleaned, fastModels };
}
