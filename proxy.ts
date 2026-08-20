import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { getSafeInternalPath } from "@/lib/web-auth-redirect";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import {
  verifyPersistedWebSessionToken,
  WEB_SESSION_COOKIE_NAME,
} from "@/lib/web-session";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/web-auth/session",
  "/manifest.webmanifest",
  "/sw.js",
  "/offline.html",
  "/favicon.ico",
]);

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
    || pathname.startsWith("/icons/")
    || pathname.startsWith("/_next/");
}

function unauthorizedApiResponse(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const apiRequest = isApiPath(pathname);
  const trustedRequest = apiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!trustedRequest) {
    if (apiRequest) {
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    }
    return new NextResponse("Untrusted request", { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (pathname === "/login") return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  const authenticated = verifyPersistedWebSessionToken(
    request.cookies.get(WEB_SESSION_COOKIE_NAME)?.value,
    password,
  );

  if (pathname === "/login" && authenticated) {
    return NextResponse.redirect(new URL(
      getSafeInternalPath(request.nextUrl.searchParams.get("next")),
      request.url,
    ));
  }

  if (isPublicPath(pathname)) return NextResponse.next();
  if (authenticated) return NextResponse.next();
  if (apiRequest) return unauthorizedApiResponse();

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
