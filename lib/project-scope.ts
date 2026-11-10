import { samePath } from "./paths";
import { resolveProject } from "./worktree";

/**
 * Keep the items that belong to `cwd`'s project: the same directory, or any
 * checkout (main or linked worktree) of the same repository, the way the
 * sidebar groups sessions. Project lookups are cached by lib/worktree.ts.
 */
export async function filterToProject<T extends { cwd: string }>(
  items: readonly T[],
  cwd: string,
  resolve: (dir: string) => Promise<{ projectRoot: string }> = resolveProject,
): Promise<T[]> {
  if (items.length === 0) return [];
  let root = cwd;
  try {
    root = (await resolve(cwd)).projectRoot;
  } catch {
    // Without a project identity only the directory itself matches.
  }
  const roots = new Map<string, string>();
  for (const dir of new Set(items.map((item) => item.cwd))) {
    try {
      roots.set(dir, (await resolve(dir)).projectRoot);
    } catch {
      roots.set(dir, dir);
    }
  }
  return items.filter((item) => samePath(item.cwd, cwd) || samePath(roots.get(item.cwd) ?? item.cwd, root));
}
