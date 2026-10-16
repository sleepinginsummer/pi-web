import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelEntry, ModelsData, SelectedModel, ThinkingLevelMap } from "@/lib/model-types";
import { loadModelsWithCache, withModelRuntimeError, withSafeModelLoadFailure } from "@/lib/models-cache";
import type { ThinkingLevel } from "@/lib/thinking-levels";
import {
  orderSelectorModels,
  resolveVisibleModels,
  restrictVisibleModelsToConfiguredCatalog,
  selectInitialModelScope,
} from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { isFastModeAvailable } from "@/lib/fast-mode";
import { readModelsConfigSnapshot } from "@/lib/models-config-commit";
import { rememberProviderModels, withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { inferRemovedWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";

async function loadModels(
  cwd: string,
  modelsConfig: Record<string, unknown>,
  fastModels: ReadonlySet<string>,
): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: ModelEntry[] = [];
  let defaultModel: SelectedModel | null = null;
  const thinkingLevels: Record<string, ThinkingLevel[]> = {};
  const thinkingLevelMaps: Record<string, ThinkingLevelMap> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  await rememberProviderModels(services.modelRuntime);
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = restrictVisibleModelsToConfiguredCatalog(
    await resolveVisibleModels(
      withDeferredProviderModels(services.modelRuntime),
      settings.getEnabledModels(),
    ),
    modelsConfig,
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = orderSelectorModels(scope).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    fastAvailable: isFastModeAvailable(m, fastModels),
    input: m.input,
  }));
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

async function loadModelsConsistently(cwd: string): Promise<ModelsData> {
  const before = await readModelsConfigSnapshot();
  const result = await loadModels(cwd, before.modelsConfig, before.fastModels);
  const after = await readModelsConfigSnapshot();
  if (before.generation === after.generation) return result;
  throw new Error("模型配置在目录加载期间发生变化，请重试");
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  const requestedCwd = resolve(new URL(req.url).searchParams.get("cwd") || process.cwd());
  // A subagent run isolated in a worktree has that worktree removed when the run
  // finishes, yet its session file still records the worktree as its cwd. Fall back
  // to the main repo it branched from, so opening a finished subagent resolves the
  // same models a non-isolated one would. The roots check below runs on the folder
  // actually answered from, so the fallback reaches no project that was not allowed
  // by name already.
  const cwd = existsSync(requestedCwd)
    ? requestedCwd
    : inferRemovedWorktree(requestedCwd)?.projectRoot ?? requestedCwd;

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModelsConsistently(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
