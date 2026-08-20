// 会话文件级标题生成：对任意会话 .jsonl（未删除会话或回收站文件）生成标题，
// 以 session_info entry 写回文件（恢复/重开后标题依然保留）。
// 与 auto-name 路由不同，这里不创建 RPC 会话（无扩展绑定/registry/设置副作用），
// 直接用 SDK 的 services + AgentSession 轻量构造，用完即 dispose。
import { join, resolve } from "path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "./session-title";
import {
  SessionTitleTaskCoordinator,
  type SessionTitleTaskRegistry,
  type SessionTitleTaskRunRequest,
} from "./session-title-task-coordinator";
import { projectTrustReloadOptions } from "./project-trust";
import { getTrashDir } from "./trash";

export interface GenerateTitleForSessionFileOptions {
  /** 手动重新生成标题时覆盖已有名称；自动命名、回收站和批处理默认跳过已有名称。 */
  overwrite?: boolean;
}

const globalRegistry = globalThis as typeof globalThis & {
  __piSessionTitleTasks?: SessionTitleTaskRegistry;
};
// HMR 只复用纯任务 Map；coordinator 实例和 dependencies 每次模块加载都使用最新实现。
const sessionTitleTasks = globalRegistry.__piSessionTitleTasks ??= new Map();

function readTitleTaskState(filePath: string): { sessionId: string; name: string | undefined } | null {
  try {
    const manager = SessionManager.open(filePath);
    return { sessionId: manager.getSessionId(), name: manager.getSessionName() };
  } catch {
    return null;
  }
}

const sessionTitleCoordinator = new SessionTitleTaskCoordinator({
  normalizePath: resolve,
  readState: readTitleTaskState,
  run: (task) => runTitleGeneration(task),
}, sessionTitleTasks);

/** 会话文件 rename 后迁移正在执行任务的写入目标。 */
export function updateSessionTitleTaskPath(sessionId: string, filePath: string): void {
  sessionTitleCoordinator.migrate(sessionId, filePath);
}
/** 实际执行一次文件级标题生成；并发与排队统一由公开函数管理。 */
async function runTitleGeneration(task: SessionTitleTaskRunRequest): Promise<string | null> {
  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(task.target.filePath);
  } catch {
    // 文件不存在（已删除/恢复）或损坏
    return null;
  }
  if (sessionManager.getSessionId() !== task.sessionId) return null;
  const initialName = sessionManager.getSessionName();
  // 自动命名不覆盖已有名称；仅手动操作显式传入 overwrite。
  if (!task.overwrite && sessionManager.getSessionName()) return null;
  // 无 user 消息的会话（如 fork 产生的空会话）没有可命名的内容
  const hasUserMessage = sessionManager.getBranch().some(
    (entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user",
  );
  if (!hasUserMessage) return null;

  initTheme();
  const cwd = sessionManager.getCwd();
  const agentDir = getAgentDir();
  // 与 RPC 会话一致：不受信任项目的扩展不加载（见 lib/project-trust.ts, #236）
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  // 不传 model：SDK 从会话文件恢复上次使用的模型，失败则回退默认模型
  const { session } = await createAgentSessionFromServices({ services, sessionManager });
  try {
    const result = await generateSessionTitle(session);
    // 删除/恢复可能在模型请求期间 rename 文件。写入前重新打开任务的最新路径，
    // 并核对稳定 session id。名称也必须仍与任务开始时一致：期间发生的 PATCH/RPC
    // 手动改名优先，异步模型结果不能覆盖用户更新。
    let writer: SessionManager;
    try {
      writer = SessionManager.open(task.target.filePath);
    } catch {
      return null;
    }
    if (writer.getSessionId() !== task.sessionId || writer.getSessionName() !== initialName) return null;
    writer.appendSessionInfo(result.title);
    return result.title;
  } finally {
    session.dispose();
  }
}

/**
 * 为单个会话文件生成标题并写回 session_info entry。
 *
 * 同一稳定 session id 只运行一个任务：普通调用共享当前任务；overwrite 遇到普通任务时
 * 串行排队一次，多个 overwrite 共享该排队任务。任务保留可迁移的最新 filePath，
 * 删除/恢复 rename 后仍不会并发请求模型或向旧路径写入。
 *
 * @returns 生成并写入的标题；null=跳过（已有标题 / 无 user 消息 / 文件不可读或已消失）。
 * @throws 生成失败（由调用方决定记录与重试）。
 */
export function generateTitleForSessionFile(
  filePath: string,
  options: GenerateTitleForSessionFileOptions = {},
): Promise<string | null> {
  return sessionTitleCoordinator.submit(filePath, options.overwrite === true);
}

/** 会话删除进入回收站后异步生成一次标题；失败静默（仅记录日志），不阻塞删除流程。 */
export function queueTrashSessionTitle(fileName: string): void {
  void generateTitleForSessionFile(join(getTrashDir(), fileName)).catch((error) => {
    console.error(
      `[pi-web] failed to generate title for trashed session ${fileName}:`,
      error instanceof Error ? error.message : String(error),
    );
  });
}
