import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isThinkingLevel, type ThinkingLevel } from "./thinking-levels";

const HISTORY_LIMIT = 50;
const FILE_NAME = "pi-web-thinking-level-preferences.json";

export interface ThinkingLevelUsage {
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

interface PreferenceFile {
  version: 1;
  models: Record<string, ThinkingLevel[]>;
}

function parsePreferenceFile(value: unknown): PreferenceFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { version: 1, models: {} };
  }
  const rawModels = (value as { models?: unknown }).models;
  if (typeof rawModels !== "object" || rawModels === null || Array.isArray(rawModels)) {
    return { version: 1, models: {} };
  }

  const models: Record<string, ThinkingLevel[]> = {};
  for (const [modelId, levels] of Object.entries(rawModels)) {
    if (!modelId || !Array.isArray(levels)) continue;
    models[modelId] = levels.filter(isThinkingLevel).slice(-HISTORY_LIMIT);
  }
  return { version: 1, models };
}

export function recommendThinkingLevel(
  usages: readonly ThinkingLevelUsage[],
  modelId: string,
): ThinkingLevel | null {
  const recent = usages.filter((usage) => usage.modelId === modelId).slice(-HISTORY_LIMIT);
  if (recent.length === 0) return null;

  const counts = new Map<ThinkingLevel, number>();
  for (const usage of recent) {
    counts.set(usage.thinkingLevel, (counts.get(usage.thinkingLevel) ?? 0) + 1);
  }
  const highest = Math.max(...counts.values());
  // 从后向前查找，使并列时采用最近实际使用的等级。
  return [...recent].reverse().find((usage) => counts.get(usage.thinkingLevel) === highest)?.thinkingLevel ?? null;
}

export function readThinkingLevelRecommendation(
  modelId: string,
  filePath = join(getAgentDir(), FILE_NAME),
): ThinkingLevel | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parsePreferenceFile(JSON.parse(readFileSync(filePath, "utf8")));
    const levels = parsed.models[modelId] ?? [];
    return recommendThinkingLevel(
      levels.map((thinkingLevel) => ({ modelId, thinkingLevel })),
      modelId,
    );
  } catch (error) {
    console.error("[pi-web] 读取思考强度偏好失败:", error);
    return null;
  }
}

export async function recordThinkingLevelUsage(
  usage: ThinkingLevelUsage,
  filePath = join(getAgentDir(), FILE_NAME),
): Promise<void> {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const release = await lockfile.lock(filePath, {
    realpath: false,
    retries: { retries: 60, factor: 1, minTimeout: 10, maxTimeout: 50 },
    stale: 30_000,
  });
  try {
    let current: PreferenceFile;
    try {
      current = existsSync(filePath)
        ? parsePreferenceFile(JSON.parse(readFileSync(filePath, "utf8")))
        : { version: 1, models: {} };
    } catch (error) {
      console.error("[pi-web] 思考强度偏好文件已损坏，将重建:", error);
      current = { version: 1, models: {} };
    }
    const levels = current.models[usage.modelId] ?? [];
    current.models[usage.modelId] = [...levels, usage.thinkingLevel].slice(-HISTORY_LIMIT);
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
  } finally {
    await release();
  }
}
