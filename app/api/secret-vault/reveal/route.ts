import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { revealSecret, SECRET_NAME_RE } from "@/lib/secret-vault";

export const dynamic = "force-dynamic";

function reply(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 登录态由 proxy 统一验证；只在用户主动查看时返回单条原文，所有响应禁止缓存。 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return reply({ error: "Untrusted API request" }, 403);
  if (!hasJsonContentType(req)) return reply({ error: "Content-Type must be application/json" }, 415);
  const body = await req.json().catch(() => null) as { name?: unknown } | null;
  if (typeof body?.name !== "string" || !SECRET_NAME_RE.test(body.name)) {
    return reply({ error: "Invalid secret name" }, 400);
  }
  try {
    const value = revealSecret(body.name);
    if (value === undefined) return reply({ error: "Secret not found" }, 404);
    return reply({ value });
  } catch {
    // 不记录异常对象，避免底层错误将密钥材料带入日志或响应。
    console.error("保管库密钥读取失败");
    return reply({ error: "无法读取密钥" }, 500);
  }
}
