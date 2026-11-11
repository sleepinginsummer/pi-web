import { NextResponse } from "next/server";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { isSystemClipboardImageSupported, readSystemClipboardPng } from "@/lib/system-clipboard-image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 读取服务端所在机器的剪贴板图片，作为浏览器粘贴失败时的兜底。
 * 只有页面与服务在同一台机器上时才有意义，所以只接受发往本机回环地址的请求。
 * 有图片时返回 image/png，没有图片时返回 204。
 */
export async function POST(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  if (!isSystemClipboardImageSupported()) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  const png = await readSystemClipboardPng();
  if (!png) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
