import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isValidSessionId } from "./session-file-references-core";

function commitPath(sessionId: string): string | undefined {
  if (!isValidSessionId(sessionId)) return undefined;
  return join(getAgentDir(), "pi-web-team-rebuild-commits", sessionId);
}

export function hasTeamRebuildSessionCommit(sessionId: string): boolean {
  const path = commitPath(sessionId);
  if (!path) return false;
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    return stats?.isFile() === true && stats.size === 0;
  } catch (error) {
    console.warn("[pi-web] 读取重建会话提交凭据失败", { sessionId, error });
    return false;
  }
}

/** 确认团队已提交后才写入。按会话 ID 保存，归档或恢复时仍可读取。 */
export function persistTeamRebuildSessionCommit(sessionId: string): void {
  const path = commitPath(sessionId);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, "");
  } catch (error) {
    // 团队记录已提交，后续授权检查仍可用团队凭据补写。
    console.warn("[pi-web] 保存重建会话提交凭据失败", { sessionId, error });
  }
}
