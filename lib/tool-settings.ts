import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./thinking-levels";

/**
 * 扩展工具的设置，存在扩展自己的配置里——`/review` 由 pi-session-review 直接读取
 * `<agentDir>/pi-session-review/config.json`，所以界面改的必须是那份文件，保存后下一次
 * `/review` 才生效。任意未知字段（`system_prompt` 等）原样保留。
 */

export const REVIEW_TOOL_ID = "review";

/** 扩展自带模板目录名与包名，模板用来在还没有用户配置时补齐 `system_prompt`。 */
const REVIEW_PACKAGE_NAME = "pi-session-review";
const REVIEW_TEMPLATE_FILE = "config.example.json";

/** 用户配置缺失时界面显示、保存时作为默认值的思考强度。 */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export interface ToolModelSelection {
  provider: string;
  modelId: string;
}

export interface ReviewToolSettings {
  /** 扩展是否已安装：没装时界面只提示，不能新建配置。 */
  installed: boolean;
  /** 用户配置文件位置，界面显示出来方便手动编辑。 */
  configPath: string;
  /** 用户配置是否已存在；不存在时保存会以当前生效的配置（扩展自带的 config.json 或模板）为底稿。 */
  configured: boolean;
  /** 扩展此刻实际读取的文件：用户配置优先，其次是包自带的 config.json；都没有时为 null。 */
  effectiveConfigPath: string | null;
  /** null = 跟随当前会话模型（扩展里存空字符串）。 */
  model: ToolModelSelection | null;
  thinkingLevel: ThinkingLevel;
}

export function reviewConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, REVIEW_PACKAGE_NAME, "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`扩展配置无法解析：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!isRecord(parsed)) throw new Error(`扩展配置必须是 JSON 对象：${path}`);
  return parsed;
}

function subdirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // 目录不存在或不可读：没有候选，不算错误。
    return [];
  }
}

/** pi 认为不以这些前缀开头的来源都是本地路径（见 isLocalPath）。 */
const PACKAGE_SOURCE_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

/** 本地源的解析规则与 pi 一致：`~` 按家目录展开，绝对路径原样，其余相对 agentDir。 */
export function resolveLocalPackageSource(source: string, agentDir = getAgentDir()): string | null {
  const trimmed = source.trim();
  if (!trimmed || PACKAGE_SOURCE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  const home = homedir();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  return resolve(agentDir, trimmed);
}

/** settings.json 里以路径形式安装的本地扩展目录。 */
function localPackageDirs(agentDir: string): string[] {
  let packages: unknown;
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown };
    packages = settings.packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  return packages
    .map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown })?.source))
    .filter((source): source is string => typeof source === "string")
    .map((source) => resolveLocalPackageSource(source, agentDir))
    .filter((dir): dir is string => dir !== null);
}

/**
 * 已安装扩展里带配置模板的那个包目录。三种装法都要覆盖：git 包在
 * `<agentDir>/git/<host>/<owner>/<repo>`，npm 包在 `<agentDir>/npm/node_modules/<name>`，
 * 本地路径包（settings.json 里写成 `../../x`）按 agentDir 解析。都按包名匹配；
 * 找不到返回 null（此时不能从模板新建配置）。
 */
export function findReviewPackageDir(agentDir = getAgentDir()): string | null {
  const candidates: string[] = [];
  const gitRoot = join(agentDir, "git");
  for (const host of subdirectories(gitRoot)) {
    for (const owner of subdirectories(join(gitRoot, host))) {
      for (const repo of subdirectories(join(gitRoot, host, owner))) {
        candidates.push(join(gitRoot, host, owner, repo));
      }
    }
  }
  candidates.push(join(agentDir, "npm", "node_modules", REVIEW_PACKAGE_NAME));
  candidates.push(join(agentDir, "node_modules", REVIEW_PACKAGE_NAME));
  candidates.push(...localPackageDirs(agentDir));
  for (const dir of candidates) {
    if (!existsSync(join(dir, REVIEW_TEMPLATE_FILE))) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === REVIEW_PACKAGE_NAME) return dir;
    } catch {
      // 不是包目录（或 package.json 损坏）：继续找下一个。
    }
  }
  return null;
}

/** `provider/modelId` 的解析规则与扩展的 `parseConfig` 一致；空值表示跟随当前会话模型。 */
export function parseToolModel(value: unknown): ToolModelSelection | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function validateModel(model: unknown): ToolModelSelection | null {
  if (model === null || model === undefined) return null;
  if (!isRecord(model) || typeof model.provider !== "string" || typeof model.modelId !== "string") {
    throw new Error("model 必须是 { provider, modelId } 或 null");
  }
  const provider = model.provider.trim();
  const modelId = model.modelId.trim();
  // 与扩展 parseConfig 同一条规则：拼成 provider/modelId 后必须含 "/"，且不以 "/" 开头或结尾。
  const fullId = `${provider}/${modelId}`;
  // 三条都按扩展的规则：拼出来的 provider/modelId 不能被它按 "/" 切错或拒绝。
  // provider 里带 "/" 会让扩展切成另一个模型，modelId 以 "/" 结尾则是它明确拒绝的值。
  if (!provider || !modelId || provider.includes("/") || modelId.startsWith("/") || modelId.endsWith("/")
    || !fullId.includes("/") || fullId.startsWith("/") || fullId.endsWith("/")) {
    throw new Error("model 必须是 provider/modelId，例如 anthropic/claude-sonnet-4");
  }
  return { provider, modelId };
}

/**
 * 扩展此刻实际读取的配置文件：`resolveConfigPath` 先看用户配置，没有就用包目录里的
 * `config.json`；两个都没有时返回 null（保存会用 `config.example.json` 作底稿）。
 */
export function effectiveReviewConfigPath(agentDir = getAgentDir()): string | null {
  const userPath = reviewConfigPath(agentDir);
  if (existsSync(userPath)) return userPath;
  const packageDir = findReviewPackageDir(agentDir);
  const packaged = packageDir ? join(packageDir, "config.json") : null;
  return packaged && existsSync(packaged) ? packaged : null;
}

/**
 * 读**当前生效**的配置（用户配置 → 包自带 config.json），界面显示的模型与强度就是
 * `/review` 下一次会用到的值，而不是一份空默认。损坏则报错而不是静默覆盖。
 */
export function readReviewToolSettings(agentDir = getAgentDir()): ReviewToolSettings {
  const configPath = reviewConfigPath(agentDir);
  const effectiveConfigPath = effectiveReviewConfigPath(agentDir);
  const stored = effectiveConfigPath ? readJsonObject(effectiveConfigPath) : null;
  return {
    installed: findReviewPackageDir(agentDir) !== null,
    configPath,
    configured: existsSync(configPath),
    effectiveConfigPath,
    model: parseToolModel(stored?.run_with_model),
    thinkingLevel: isThinkingLevel(stored?.thinking_level) ? stored.thinking_level : DEFAULT_THINKING_LEVEL,
  };
}

/**
 * 只改 `run_with_model` 与 `thinking_level`：其余键（包含 `system_prompt`）原样写回。
 * 底稿顺序与扩展的读取顺序一致：用户配置 → 包内置的 `config.json` → `config.example.json`。
 * 用户配置还不存在时用后两者之一，绝不拿一份空配置覆盖正在生效的自定义提示词。
 */
export async function writeReviewToolSettings(
  input: { model: unknown; thinkingLevel: unknown },
  agentDir = getAgentDir(),
): Promise<ReviewToolSettings> {
  const model = validateModel(input.model);
  if (!isThinkingLevel(input.thinkingLevel)) {
    throw new Error(`thinkingLevel 必须是 ${THINKING_LEVELS.join(" | ")}`);
  }
  const thinkingLevel = input.thinkingLevel;
  const configPath = reviewConfigPath(agentDir);
  await withPrivateFileLock(configPath, () => {
    const packageDir = findReviewPackageDir(agentDir);
    const existing = readJsonObject(configPath);
    const effective = effectiveReviewConfigPath(agentDir);
    const base = existing
      ?? (effective && effective !== configPath ? readJsonObject(effective) : null)
      ?? (packageDir ? readJsonObject(join(packageDir, REVIEW_TEMPLATE_FILE)) : null);
    if (!base) throw new Error("找不到 pi-session-review 的配置模板，请先安装或重新安装该扩展");
    // 底稿缺少系统提示词时扩展会拒绝整份配置，宁可报错也不写一份跑不起来的文件。
    if (typeof base.system_prompt !== "string" || !base.system_prompt.trim()) {
      throw new Error("扩展配置缺少 system_prompt，请先补全或从扩展模板重新生成");
    }
    writePrivateFileAtomicSync(configPath, JSON.stringify({
      ...base,
      run_with_model: model ? `${model.provider}/${model.modelId}` : "",
      thinking_level: thinkingLevel,
    }, null, 2));
  });
  return readReviewToolSettings(agentDir);
}
