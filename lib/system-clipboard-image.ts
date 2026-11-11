import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/** 服务端最多返回的剪贴板图片大小；前端还会按附件上限再过滤一次。 */
export const MAX_SYSTEM_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;

// 让系统把剪贴板图片转换成 PNG 再写入临时文件。剪贴板里没有图片时 `as «class PNGf»` 会报错。
const WRITE_CLIPBOARD_PNG_SCRIPT = [
  "on run argv",
  "set pngData to the clipboard as «class PNGf»",
  "set outFile to open for access (POSIX file (item 1 of argv)) with write permission",
  "write pngData to outFile",
  "close access outFile",
  "end run",
];

export type OsascriptRunner = (args: string[]) => Promise<void>;

const runOsascript: OsascriptRunner = (args) => new Promise((resolve, reject) => {
  execFile("osascript", args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
});

export function isSystemClipboardImageSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

/**
 * 读取本机系统剪贴板中的图片并返回 PNG 数据。
 *
 * 微信等 macOS 应用复制图片时，剪贴板里放的是指向其沙盒目录的文件 URL 加 TIFF 数据，没有 PNG。
 * Chrome 优先按文件 URL 读取，被系统拒绝后粘贴事件和异步剪贴板 API 都拿不到图片；
 * 系统剪贴板自身可以把 TIFF 转成 PNG，所以由同一台机器上的服务端代为读取。
 * 没有图片、平台不支持或读取失败时返回 null。
 */
export async function readSystemClipboardPng(
  run: OsascriptRunner = runOsascript,
  platform: string = process.platform,
): Promise<Buffer | null> {
  if (!isSystemClipboardImageSupported(platform)) return null;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-clipboard-"));
  const target = join(dir, "clipboard.png");
  try {
    const args = WRITE_CLIPBOARD_PNG_SCRIPT.flatMap((line) => ["-e", line]);
    await run([...args, target]);
    const data = await readFile(target);
    if (!data.length || data.length > MAX_SYSTEM_CLIPBOARD_IMAGE_BYTES) return null;
    return data;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
