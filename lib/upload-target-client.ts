"use client";

let cachedTarget: Promise<string> | null = null;

/**
 * 聊天附件落到系统下载目录。取到一次就缓存，失败不缓存（下次还能重试）。
 * 路径由 `/api/upload-target` 给出，客户端不自己拼。
 */
export function resolveUploadTarget(): Promise<string> {
  if (cachedTarget) return cachedTarget;

  cachedTarget = fetch("/api/upload-target")
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { directory?: unknown };
      if (typeof data.directory !== "string" || !data.directory) {
        throw new Error("upload target unavailable");
      }
      return data.directory;
    })
    .catch((error: unknown) => {
      cachedTarget = null;
      throw error;
    });

  return cachedTarget;
}
