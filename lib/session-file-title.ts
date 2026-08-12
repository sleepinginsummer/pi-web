// 会话文件级标题生成：对任意会话 .jsonl（未删除会话或回收站文件）生成标题，
// 以 session_info entry 写回文件（恢复/重开后标题依然保留）。
// 与 auto-name 路由不同，这里不创建 RPC 会话（无扩展绑定/registry/设置副作用），
// 直接用 SDK 的 services + AgentSession 轻量构造，用完即 dispose。
import { statSync } from "fs";
import { join } from "path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "./session-title";
import { projectTrustReloadOptions } from "./project-trust";
import { getTrashDir } from "./trash";

/**
 * 为单个会话文件生成标题并写回 session_info entry。
 * @returns true=成功写入标题；false=跳过（已有标题 / 无 user 消息 / 文件不可读或已消失）。
 * @throws 生成失败（由调用方决定记录与重试）。
 */
export async function generateTitleForSessionFile(filePath: string): Promise<boolean> {
  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(filePath);
  } catch {
    // 文件不存在（已删除/恢复）或损坏
    return false;
  }
  // 已有显示名称（手动设置或此前自动生成）不重复生成
  if (sessionManager.getSessionName()) return false;
  // 无 user 消息的会话（如 fork 产生的空会话）没有可命名的内容
  const hasUserMessage = sessionManager.getBranch().some(
    (entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user",
  );
  if (!hasUserMessage) return false;

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
    // 生成期间文件可能已被移动/删除：写盘前确认仍在原位置，
    // 避免 appendFileSync 在已搬走的路径上重建一个只有 session_info 的空壳文件
    try {
      statSync(filePath);
    } catch {
      return false;
    }
    session.setSessionName(result.title);
    return true;
  } finally {
    session.dispose();
  }
}

// 回收站删除时触发的标题任务（key 为回收站文件名），防止同一文件并发重复触发
const TITLE_TASKS = new Map<string, Promise<boolean | void>>();

/** 会话删除进入回收站后异步生成一次标题；失败静默（仅记录日志），不阻塞删除流程。 */
export function queueTrashSessionTitle(fileName: string): void {
  if (TITLE_TASKS.has(fileName)) return;
  const task = generateTitleForSessionFile(join(getTrashDir(), fileName))
    .catch((error) => {
      console.error(
        `[pi-web] failed to generate title for trashed session ${fileName}:`,
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      TITLE_TASKS.delete(fileName);
    });
  TITLE_TASKS.set(fileName, task);
}
