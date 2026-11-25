import { toSlashPath } from "./paths";

// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
  var __piGitMutationRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalGitMutationRoots: Set<string> | undefined;
}

/**
 * Allowed roots are internal bookkeeping keys that are never displayed, so they
 * are stored slash-normalized for consistent Set membership. Correctness does
 * not depend on it — isPathWithinRoots() re-normalizes whatever it is given.
 */
export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}

/** 仅记录用户显式打开或创建的工作区目录，用于 Git 分支切换等写操作授权，不与文件浏览白名单混用。 */
export function getAdditionalGitMutationRoots(): Set<string> {
  if (!globalThis.__piAdditionalGitMutationRoots) {
    globalThis.__piAdditionalGitMutationRoots = new Set();
  }
  return globalThis.__piAdditionalGitMutationRoots;
}

export function allowGitMutationRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalGitMutationRoots().add(normalizedRoot);
  globalThis.__piGitMutationRootsCache?.roots.add(normalizedRoot);
}
