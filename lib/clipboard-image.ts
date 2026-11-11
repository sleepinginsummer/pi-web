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

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "blob">>;

/**
 * 请求同一台机器上的 pi-web 服务读取系统剪贴板图片。
 *
 * 微信在 macOS 上只放沙盒文件 URL 和 TIFF 数据，浏览器两种途径都读不到；服务端可以让系统转成 PNG。
 * 页面不在本机访问、平台不支持或剪贴板没有图片时返回空数组。
 */
export async function readServerClipboardImageFiles(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<File[]> {
  try {
    const response = await fetchImpl("/api/clipboard-image", { method: "POST", cache: "no-store" });
    if (!response.ok || response.status === 204) return [];
    const blob = await response.blob();
    if (!blob.size) return [];
    return [new File([blob], "clipboard.png", { type: "image/png" })];
  } catch (error) {
    console.warn("通过服务端读取剪贴板图片失败", error);
    return [];
  }
}
