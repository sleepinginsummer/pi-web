import type { ImageContent } from "./types";

/**
 * 兼容 pi-web 结构与 pi-ai 历史落盘结构，返回可直接用于 img.src 的地址。
 * 缺少 URL 或 base64 数据时返回空字符串，由调用方统一视为不可展示。
 */
export function getImageSource(image: ImageContent): string {
  const flat = image as unknown as { data?: string; mimeType?: string };
  if (image.source) {
    if (image.source.type === "base64") {
      const data = image.source.data?.trim();
      const mediaType = image.source.media_type?.trim();
      return data && mediaType ? `data:${mediaType};base64,${data}` : "";
    }
    return image.source.url?.trim() ?? "";
  }

  const data = flat.data?.trim();
  const mediaType = flat.mimeType?.trim();
  return data && mediaType ? `data:${mediaType};base64,${data}` : "";
}
