import { constants, fstatSync, lstatSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type NextRequest } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { hasParentDirectorySegment, isPathWithinRoots, resolveRealRoots } from "@/lib/path-security";
import { getImageMime } from "@/lib/file-types";
import { readRegularFileBytes } from "@/lib/regular-file";

const ICON_MAX_BYTES = 1024 * 1024;
const ICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "app/favicon.ico", "app/favicon.png", "app/icon.svg", "app/icon.png", "app/icon.ico",
  "src/favicon.svg", "src/favicon.ico", "src/favicon.png",
  "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
  "assets/icon.svg", "assets/icon.png", ".idea/icon.svg", "web/favicon.png",
];

// Darwin 的 <sys/fcntl.h>。Node 未导出此标志，它会拒绝路径上任意一级出现符号链接。
const ICON_OPEN_FLAGS = process.platform === "darwin" ? 0x20000000 : (constants.O_NOFOLLOW ?? 0);

function sameFileIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function readProjectIcon(projectRoot: string, projectRoots: Set<string>, candidate: string): Buffer | undefined {
  const iconPath = realpathSync.native(join(projectRoot, candidate));
  if (!isPathWithinRoots(iconPath, projectRoots)) return undefined;

  // 校验描述符与授权路径在打开前后的身份。逐级核对目录也覆盖没有描述符路径查询的系统。
  const directories: Array<{ path: string; stats: BigIntStats }> = [];
  for (let path = dirname(iconPath); ; path = dirname(path)) {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isDirectory()) return undefined;
    directories.push({ path, stats });
    if (dirname(path) === path) break;
  }
  const expected = lstatSync(iconPath, { bigint: true });
  if (!expected.isFile()) return undefined;

  return readRegularFileBytes(iconPath, ICON_MAX_BYTES, {
    openFlags: ICON_OPEN_FLAGS,
    authorizeOpenedFile: (fd) => {
      if (!sameFileIdentity(expected, fstatSync(fd, { bigint: true }))) return false;
      if (process.platform === "linux" && readlinkSync(`/proc/self/fd/${fd}`) !== iconPath) return false;
      return directories.every(({ path, stats }) => {
        const current = lstatSync(path, { bigint: true });
        return current.isDirectory() && sameFileIdentity(stats, current)
          && stats.ctimeNs === current.ctimeNs && stats.mtimeNs === current.mtimeNs;
      });
    },
  });
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  const cacheHeaders = { "Cache-Control": "no-store" };
  if (!project || !isAbsolute(project)) return new Response(null, { status: 400, headers: cacheHeaders });

  const allowedRoots = await getAllowedFileRoots();
  const noIcon = () => new Response(null, { status: 204, headers: cacheHeaders });
  if (hasParentDirectorySegment(project) || !isFilePathAllowed(project, allowedRoots)) return noIcon();

  // 先固定当前已授权的真实根目录，候选路径只基于本次确认的项目目录解析。
  const realAllowedRoots = resolveRealRoots(allowedRoots);
  let projectRoot: string;
  try {
    projectRoot = realpathSync.native(project);
  } catch {
    return noIcon();
  }
  if (!isPathWithinRoots(projectRoot, realAllowedRoots)) return noIcon();
  const projectRoots = new Set([projectRoot]);
  for (const candidate of ICON_CANDIDATES) {
    try {
      const bytes = readProjectIcon(projectRoot, projectRoots, candidate);
      const mime = getImageMime(candidate);
      if (!bytes?.length || !mime) continue;
      return new Response(new Uint8Array(bytes), {
        headers: {
          ...cacheHeaders,
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
          // 直接打开 SVG 的地址时也保持沙盒，禁止执行项目文件里的脚本。
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      console.debug("读取项目图标失败", { project, candidate, error });
    }
  }
  return noIcon();
}
