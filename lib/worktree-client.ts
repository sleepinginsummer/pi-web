import type { WorktreeInfo } from "./types";

interface WorktreeMutationResponse {
  path?: string;
  error?: string;
  dirty?: boolean;
}

type Fetcher = typeof fetch;

export class WorktreeMutationError extends Error {
  constructor(message: string, readonly dirty = false) {
    super(message);
    this.name = "WorktreeMutationError";
  }
}

async function readMutationResponse(response: Response): Promise<WorktreeMutationResponse> {
  return response.json().catch(() => ({})) as Promise<WorktreeMutationResponse>;
}

/** 统一封装 worktree 创建协议与响应校验。 */
export async function createWorktreeRequest(
  projectRoot: string,
  branch: string,
  fetcher: Fetcher = fetch,
): Promise<WorktreeInfo> {
  const response = await fetcher("/api/worktrees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projectRoot, branch }),
  });
  const data = await readMutationResponse(response);
  if (!response.ok || data.error || !data.path) {
    throw new WorktreeMutationError(data.error ?? `HTTP ${response.status}`);
  }
  return { path: data.path, branch, isMain: false };
}

/** 统一封装 worktree 删除协议，并保留脏目录确认信号。 */
export async function removeWorktreeRequest(
  projectRoot: string,
  path: string,
  force: boolean,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher("/api/worktrees", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projectRoot, path, force }),
  });
  const data = await readMutationResponse(response);
  if (!response.ok || data.error) {
    throw new WorktreeMutationError(data.error ?? `HTTP ${response.status}`, data.dirty === true);
  }
}
