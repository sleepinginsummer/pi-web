type ClipboardItemLike = Pick<ClipboardItem, "types" | "getType">;
type ClipboardReader = { read(): Promise<ClipboardItemLike[]> };

function preferredImageType(types: readonly string[]): string | undefined {
  return types.includes("image/png") ? "image/png" : types.find((type) => type.startsWith("image/"));
}

/**
 * 读取剪贴板里的图片数据。
 *
 * 微信等应用会同时放入文件引用和图片数据，粘贴事件给出的 File 可能指向浏览器无权读取的文件；
 * 这里直接取图片数据作为兜底。API 不可用、用户拒绝授权或没有图片时返回空数组。
 */
export async function readClipboardImageFiles(
  clipboard: ClipboardReader | undefined = globalThis.navigator?.clipboard,
): Promise<File[]> {
  if (!clipboard?.read) return [];
  try {
    const items = await clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = preferredImageType(item.types);
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], `clipboard.${type.split("/")[1]}`, { type }));
    }
    return files;
  } catch (error) {
    console.warn("读取剪贴板图片失败", error);
    return [];
  }
}
