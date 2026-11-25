import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type NextRequest } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
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

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  const cacheHeaders = { "Cache-Control": "no-store" };
  if (!project || !isAbsolute(project)) return new Response(null, { status: 400, headers: cacheHeaders });

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(project, allowedRoots) || !isExistingFilePathAllowed(project, allowedRoots)) {
    return new Response(null, { status: 204, headers: cacheHeaders });
  }

  const projectRoots = new Set([project]);
  for (const candidate of ICON_CANDIDATES) {
    const iconPath = join(project, candidate);
    try {
      // 图标可以是项目内的符号链接，实际读取的文件必须留在这个项目内。
      if (!isExistingFilePathAllowed(iconPath, projectRoots)) continue;
      const bytes = readRegularFileBytes(realpathSync(iconPath), ICON_MAX_BYTES);
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
      console.debug("读取项目图标失败", { project, candidate, error });
    }
  }
  return new Response(null, { status: 204, headers: cacheHeaders });
}
