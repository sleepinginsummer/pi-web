import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const WEB_SESSION_COOKIE_NAME = "pi-web-session";
export const WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const SESSION_FILE_VERSION = 1;
const TOKEN_VERSION = "v1";
const SESSION_SECRET_BYTES = 32;

interface WebSessionConfig {
  version: typeof SESSION_FILE_VERSION;
  secret: string;
}

function getSessionConfigPath(): string {
  return process.env.PI_WEB_SESSION_CONFIG_PATH
    || path.join(homedir(), ".pi", "agent", "pi-web-session.json");
}

function parseSessionConfig(content: string): WebSessionConfig {
  const value = JSON.parse(content) as Partial<WebSessionConfig>;
  if (
    value.version !== SESSION_FILE_VERSION
    || typeof value.secret !== "string"
    || Buffer.from(value.secret, "base64url").length !== SESSION_SECRET_BYTES
  ) {
    throw new Error("Web 会话密钥文件格式无效");
  }
  return value as WebSessionConfig;
}

let cachedSessionSecret: { configPath: string; secret: Buffer } | null = null;

/** 只缓存成功读取的密钥；文件尚未创建时不缓存，确保首次登录仍可创建。 */
function readWebSessionSecret(): Buffer | null {
  const configPath = getSessionConfigPath();
  if (cachedSessionSecret?.configPath === configPath) return cachedSessionSecret.secret;

  try {
    const config = parseSessionConfig(readFileSync(configPath, "utf8"));
    const secret = Buffer.from(config.secret, "base64url");
    cachedSessionSecret = { configPath, secret };
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 会话密钥与访问密码分开保存，避免会话令牌成为密码的离线校验器。
 * wx 保证并发首次登录时只有一个请求能够创建密钥文件。
 */
export function getOrCreateWebSessionSecret(): Buffer {
  const existing = readWebSessionSecret();
  if (existing) return existing;

  const configPath = getSessionConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config: WebSessionConfig = {
    version: SESSION_FILE_VERSION,
    secret: randomBytes(SESSION_SECRET_BYTES).toString("base64url"),
  };

  let descriptor: number;
  try {
    descriptor = openSync(configPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readWebSessionSecret();
      if (raced) return raced;
    }
    throw error;
  }

  try {
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(configPath, 0o600);
  return Buffer.from(config.secret, "base64url");
}

function deriveSigningKey(secret: Buffer, password: string): Buffer {
  return createHmac("sha256", secret)
    .update("pi-web/session-signing-key/v1\0", "utf8")
    .update(password, "utf8")
    .digest();
}

function signPayload(payload: string, password: string, secret: Buffer): Buffer {
  return createHmac("sha256", deriveSigningKey(secret, password))
    .update(payload, "utf8")
    .digest();
}

export function createWebSessionToken(
  password: string,
  secret: Buffer,
  now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + WEB_SESSION_MAX_AGE_SECONDS;
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${TOKEN_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${signPayload(payload, password, secret).toString("base64url")}`;
}

export function verifyWebSessionToken(
  token: string | undefined,
  password: string,
  secret: Buffer | null,
  now = Date.now(),
): boolean {
  if (!token || !secret) return false;

  const [version, expiresAtText, nonce, signature, extra] = token.split(".");
  if (
    version !== TOKEN_VERSION
    || !/^\d+$/.test(expiresAtText ?? "")
    || !/^[A-Za-z0-9_-]{22}$/.test(nonce ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
    || extra !== undefined
    || Number(expiresAtText) <= Math.floor(now / 1000)
  ) {
    return false;
  }

  const payload = `${version}.${expiresAtText}.${nonce}`;
  const expected = signPayload(payload, password, secret);
  const provided = Buffer.from(signature, "base64url");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function verifyPersistedWebSessionToken(
  token: string | undefined,
  password: string,
  now = Date.now(),
): boolean {
  return verifyWebSessionToken(token, password, readWebSessionSecret(), now);
}
