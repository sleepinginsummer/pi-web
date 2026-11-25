/** 顶部置顶区的项目标识：稳定色块加项目名首字，便于区分不同目录。 */

/**
 * 色块固定在 8 个色里。亮底深字，浅色与深色主题共用同一组，
 * 因此不需要按主题准备两套 token，也不会和 Pin 角标（右上角缎带）的形状混淆。
 */
export const PROJECT_BADGE_COLORS = [
  { background: "#3b82f6", foreground: "#082f49" },
  { background: "#14b8a6", foreground: "#042f2e" },
  { background: "#a855f7", foreground: "#3b0764" },
  { background: "#f97316", foreground: "#431407" },
  { background: "#22c55e", foreground: "#14532d" },
  { background: "#ec4899", foreground: "#500724" },
  { background: "#818cf8", foreground: "#1e1b4b" },
  { background: "#eab308", foreground: "#713f12" },
] as const;

export interface ProjectBadge {
  background: string;
  foreground: string;
  /** 项目名首字（大写）；撞色时仍能靠它区分。 */
  initial: string;
}

/** FNV-1a 32 位：同一项目路径在任何会话、任何刷新后都落到同一个色块。 */
function hashProjectPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 取首字：跳过 `_`、`.` 这类分隔符，CJK 取一个汉字，emoji 前缀的项目名取后面第一个字母。 */
export function projectBadgeInitial(name: string): string {
  const chars = Array.from(name.trim());
  const first = chars.find((char) => /[\p{L}\p{N}]/u.test(char)) ?? chars[0];
  if (first === undefined) return "?";
  return Array.from(first.toUpperCase())[0] ?? first;
}

// 侧栏同时出现的项目只有几十个；缓存避免每帧重算，并让调用方拿到同一个对象引用。
const badgeCache = new Map<string, ProjectBadge>();
const BADGE_CACHE_LIMIT = 512;

export function projectBadge(path: string, name: string): ProjectBadge {
  const key = `${path}\u0000${name}`;
  const cached = badgeCache.get(key);
  if (cached) return cached;
  if (badgeCache.size >= BADGE_CACHE_LIMIT) badgeCache.clear();
  const color = PROJECT_BADGE_COLORS[hashProjectPath(path) % PROJECT_BADGE_COLORS.length];
  const badge: ProjectBadge = { background: color.background, foreground: color.foreground, initial: projectBadgeInitial(name) };
  badgeCache.set(key, badge);
  return badge;
}
