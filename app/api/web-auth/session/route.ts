import { NextResponse } from "next/server";
import { isValidWebCredentials, isWebPasswordEnabled } from "@/lib/web-auth";
import {
  createWebSessionToken,
  getOrCreateWebSessionSecret,
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_MAX_AGE_SECONDS,
} from "@/lib/web-session";

const MAX_REQUEST_BYTES = 4 * 1024;

interface LoginBody {
  username?: unknown;
  password?: unknown;
  remember?: unknown;
}

function isSecureRequest(request: Request): boolean {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  return forwardedProtocol === "https" || new URL(request.url).protocol === "https:";
}

function sessionCookieOptions(request: Request, remember: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    ...(remember ? { maxAge: WEB_SESSION_MAX_AGE_SECONDS } : {}),
  };
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "请求内容过大" }, { status: 413 });
  }

  try {
    const body = await request.json().catch(() => null) as LoginBody | null;
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const remember = body?.remember === true;
    const configuredPassword = process.env.PI_WEB_PASSWORD;

    if (!isWebPasswordEnabled(configuredPassword)) {
      console.warn("Web 登录被拒绝：访问密码未配置");
      return NextResponse.json({ error: "站点未启用密码登录" }, { status: 409 });
    }

    if (!isValidWebCredentials(username, password, configuredPassword)) {
      console.warn("Web 登录失败", { username });
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set(
      WEB_SESSION_COOKIE_NAME,
      createWebSessionToken(configuredPassword, getOrCreateWebSessionSecret()),
      sessionCookieOptions(request, remember),
    );
    console.info("Web 登录成功", { username, remember });
    return response;
  } catch (error) {
    console.error("Web 登录服务异常", error);
    return NextResponse.json({ error: "登录服务暂时不可用" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(WEB_SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions(request, false),
    maxAge: 0,
  });
  return response;
}
