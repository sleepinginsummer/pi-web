import { randomUUID } from "crypto";
import { linkSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

type AtomicPublish = (tempPath: string, destinationPath: string) => void;

interface AtomicPublishOptions {
  ignoreCleanupFailureAfterPublish?: boolean;
}

/** 统一私有临时文件的创建与清理，发布函数决定替换或仅创建语义。 */
function writePrivateFileViaAtomicPublishSync(
  path: string,
  contents: string,
  publish: AtomicPublish,
  options: AtomicPublishOptions = {},
): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;
  let published = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    publish(tempPath, path);
    published = true;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      const isMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isMissing && published && options.ignoreCleanupFailureAfterPublish) {
        console.warn("[pi-web] atomic publish succeeded but temporary file cleanup failed:", error);
      } else if (!isMissing && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  writePrivateFileViaAtomicPublishSync(path, contents, renameSync);
}

/**
 * 原子创建私有文件；目标已存在时以 EEXIST 失败，且绝不替换目标内容。
 * 临时文件与目标位于同一目录，通过硬链接把完整内容发布为目标路径。
 */
export function writePrivateFileCreateAtomicSync(path: string, contents: string): void {
  writePrivateFileViaAtomicPublishSync(path, contents, linkSync, {
    // link 成功即完成 create-only 发布；临时硬链接清理失败不能把成功伪装成失败。
    ignoreCleanupFailureAfterPublish: true,
  });
}
