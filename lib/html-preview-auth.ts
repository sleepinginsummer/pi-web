import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { encodeFilePathForApi } from "./file-paths";
import { filePathFromApiSegments } from "./paths";
import { hasParentDirectorySegment, isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { isSandboxedPreviewAssetRequest, RAW_FILE_PATH_SEGMENT } from "./request-security";
import { readWebSessionSecret, verifyPersistedWebSessionToken, WEB_SESSION_COOKIE_NAME } from "./web-session";

const TOKEN_PREFIX = "~preview-";
export const PREVIEW_CREDENTIAL_MAX_AGE_SECONDS = 60 * 60 * 24;
const RAW_PREFIX = `/api/files/${RAW_FILE_PATH_SEGMENT}/`;
interface PreviewGrant { directory: string; expiresAt: number; nonce: string }

/** 凭据放在路径中，相邻 CSS/JS 和嵌套图片、视频的相对 URL 才能自然保留它。 */
export function rawPreviewFileSegments(segments: string[]): string[] {
  const files = segments.slice(1);
  return files[0]?.startsWith(TOKEN_PREFIX) ? files.slice(1) : files;
}

function parseRequest(request: Request): { token: string; filePath: string } | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(RAW_PREFIX)) return null;
  try {
    const segments = pathname.slice(RAW_PREFIX.length).split("/").map(decodeURIComponent);
    if (!segments[0]?.startsWith(TOKEN_PREFIX) || segments.length < 2) return null;
    return { token: segments[0].slice(TOKEN_PREFIX.length), filePath: filePathFromApiSegments(segments.slice(1)) };
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function signature(payload: string, password: string, secret: Buffer): Buffer {
  // 与登录令牌使用不同的签名域，预览凭据不能充当登录 Cookie；修改密码立即失效。
  const key = createHmac("sha256", secret).update("pi-web/preview/v1\0").update(password).digest();
  return createHmac("sha256", key).update(payload).digest();
}

function verifyGrant(request: Request, password: string, now: number): boolean {
  const parsed = parseRequest(request);
  const secret = readWebSessionSecret();
  if (!parsed || !secret || hasParentDirectorySegment(parsed.filePath)) return false;
  const [payload, signed, extra] = parsed.token.split(".");
  if (!payload || !signed || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signed)) return false;
  const actual = Buffer.from(signed, "base64url");
  const expected = signature(payload, password, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  let grant: PreviewGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof grant?.directory !== "string" || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Math.floor(now / 1000)) return false;
  const roots = new Set([grant.directory]);
  // 同时检查词法路径和真实路径，防止拿目录凭据经过符号链接读取目录外文件。
  return isPathWithinRoots(parsed.filePath, roots) && isExistingPathWithinRoots(parsed.filePath, roots);
}

/** 仅静态子资源可用凭据替代 Cookie；导航、fetch/XHR、写请求继续走登录和来源检查。 */
export function isPreviewAssetAuthenticated(request: Request, password: string, now = Date.now()): boolean {
  return isSandboxedPreviewAssetRequest(request) && verifyGrant(request, password, now);
}

/** raw 分支也校验路径中的凭据，避免已登录请求绕过目录或有效期限制。 */
export function isRawPreviewCredentialAllowed(request: Request, password = process.env.PI_WEB_PASSWORD, now = Date.now()): boolean {
  if (!parseRequest(request)) return true;
  return typeof password === "string" && password.length > 0 && verifyGrant(request, password, now);
}

/** 文件完成既有路径授权后，已登录的 HTML 入口才可签发预览目录凭据。 */
export function getPreviewDocumentRedirect(request: Request, filePath: string, now = Date.now()): string | null {
  const password = process.env.PI_WEB_PASSWORD;
  if (!password || parseRequest(request) || !/\.html?$/i.test(filePath)) return null;
  const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))?.slice(WEB_SESSION_COOKIE_NAME.length + 1);
  if (!verifyPersistedWebSessionToken(cookie, password, now)) return null;
  const secret = readWebSessionSecret();
  if (!secret) return null;
  const grant: PreviewGrant = { directory: path.dirname(filePath), expiresAt: Math.floor(now / 1000) + PREVIEW_CREDENTIAL_MAX_AGE_SECONDS, nonce: randomBytes(16).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
  const token = `${payload}.${signature(payload, password, secret).toString("base64url")}`;
  const url = new URL(request.url);
  url.pathname = `${RAW_PREFIX}${TOKEN_PREFIX}${token}/${encodeFilePathForApi(filePath)}`;
  // Next.js 的 request.url 可能使用内部监听地址；相对 Location 保留浏览器实际访问源。
  return `${url.pathname}${url.search}`;
}
