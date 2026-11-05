import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * pi-web's side of the pi-secret-vault extension's encrypted vault.
 *
 * The file format, lock and Keychain item are the contract in that extension's `src/store.ts`;
 * a running session notices changes by the file's signature on its next hook. Settings lists names
 * and metadata, and no route returns a value. The only decryption is inside renameSecret, because
 * the name is bound into the ciphertext; the value is re-encrypted there and goes nowhere else.
 */
const VAULT_VERSION = 1;
const KEYCHAIN_SERVICE = "pi-secret-vault";
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 15000;
export const SECRET_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_REMARK_CHARS = 200;

interface StoredRecord {
  iv: string;
  tag: string;
  ct: string;
  addedAt: number;
  source: string;
  length: number;
  remark?: string;
}
interface VaultFile {
  version: number;
  records: Record<string, StoredRecord>;
}
export interface SecretVaultEntry {
  name: string;
  addedAt: number;
  source: string;
  length: number;
  remark?: string;
}
export interface VaultKeyProvider {
  read(): Buffer | undefined;
  create(): Buffer;
}

export function defaultVaultDir(): string {
  return join(getAgentDir(), "pi-secret-vault");
}

function keychainProvider(dir: string): VaultKeyProvider {
  const account = createHash("sha256").update(dir, "utf8").digest("hex").slice(0, 16);
  return {
    read() {
      try {
        const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 15000,
        });
        return Buffer.from(out.trim(), "base64");
      } catch (error) {
        // 44 is errSecItemNotFound. A locked Keychain must not look like "no key yet".
        if ((error as { status?: number }).status === 44) return undefined;
        throw new Error("The macOS Keychain refused to hand over the vault key");
      }
    },
    create() {
      const key = randomBytes(32);
      execFileSync("security", ["-i"], {
        input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -l ${KEYCHAIN_SERVICE} -w ${key.toString("base64")}\n`,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 15000,
      });
      return key;
    },
  };
}

function keyFileProvider(dir: string): VaultKeyProvider {
  const path = join(dir, "vault.key");
  return {
    read: () => (existsSync(path) ? Buffer.from(readFileSync(path, "utf8").trim(), "base64") : undefined),
    create() {
      const key = randomBytes(32);
      writeFileSync(path, key.toString("base64"), { mode: 0o600, flag: "wx" });
      return key;
    },
  };
}

function providerFor(dir: string): VaultKeyProvider {
  return process.platform === "darwin" ? keychainProvider(dir) : keyFileProvider(dir);
}

function readVault(dir: string): VaultFile {
  const path = join(dir, "vault.json");
  if (!existsSync(path)) return { version: VAULT_VERSION, records: {} };
  const file = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  if (file.version !== VAULT_VERSION) throw new Error(`Unsupported vault version ${file.version}`);
  return file;
}

function writeVault(dir: string, file: VaultFile): void {
  const path = join(dir, "vault.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function withVaultLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = join(dir, "vault.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const st = statSync(lock, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        try { rmdirSync(lock); } catch { /* another process cleared it */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the vault lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* best effort */ }
  }
}

/**
 * One line, or undefined when empty. A remark is plaintext and goes to the model in `sec_list`, so
 * this refuses what looks like a credential. The extension also compares against stored values
 * when the agent writes one; this side never decrypts for that, and the extension's output scrub
 * still masks a stored value that reaches `sec_list` from here.
 */
export function normalizeRemark(raw: string): string | undefined {
  const remark = raw.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!remark) return undefined;
  if ([...remark].length > MAX_REMARK_CHARS) throw new InvalidRemarkError(`Remark is longer than ${MAX_REMARK_CHARS} characters`);
  const looksSecret = /\{\{sec:/.test(remark)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(remark)
    || /[?&](?:token|key|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|auth)=/i.test(remark)
    || /(?:^|[\s=:])(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA|-----BEGIN)/.test(remark)
    || remark.split(/[\s·,，;；|]+/).some((token) => !token.includes("://")
      && /^[A-Za-z0-9+/_=.-]{32,}$/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token));
  if (looksSecret) throw new InvalidRemarkError("Remark looks like it contains a credential");
  return remark;
}

export class InvalidRemarkError extends Error {}

/** Names and metadata only. Needs no key, so a locked Keychain cannot hide the list. */
export function listSecrets(dir = defaultVaultDir()): SecretVaultEntry[] {
  return Object.entries(readVault(dir).records)
    .map(([name, record]) => ({ name, addedAt: record.addedAt, source: record.source, length: record.length, ...(record.remark ? { remark: record.remark } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function aad(name: string): Buffer {
  return Buffer.from(`pi-secret-vault:v${VAULT_VERSION}:${name}`, "utf8");
}

function seal(key: Buffer, name: string, value: string, source: string, addedAt: number, remark: string | undefined): StoredRecord {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(name));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    addedAt,
    source,
    length: value.length,
    ...(remark ? { remark } : {}),
  };
}

/** An undefined remark keeps the existing one: replacing a value is not forgetting what it is for. */
export function saveSecret(name: string, value: string, dir = defaultVaultDir(), keys = providerFor(dir), remark?: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error("Invalid secret name");
  if (!value.trim()) throw new Error("Secret value is empty");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("Secret value is too long");
  withVaultLock(dir, () => {
    const file = readVault(dir);
    let key = keys.read();
    if (!key) {
      // Never mint a key over records it could not decrypt.
      if (Object.keys(file.records).length) throw new Error("The vault has records but its key is gone");
      key = keys.create();
    }
    file.records[name] = seal(key, name, value, "web", Date.now(), remark ?? file.records[name]?.remark);
    writeVault(dir, file);
  });
}

export function removeSecret(name: string, dir = defaultVaultDir()): boolean {
  return withVaultLock(dir, () => {
    const file = readVault(dir);
    if (!file.records[name]) return false;
    delete file.records[name];
    writeVault(dir, file);
    return true;
  });
}

/** Metadata only, so it needs no key. An undefined remark clears it. False if the secret is gone. */
export function setSecretRemark(name: string, remark: string | undefined, dir = defaultVaultDir()): boolean {
  return withVaultLock(dir, () => {
    const file = readVault(dir);
    const record = file.records[name];
    if (!record) return false;
    if (remark) record.remark = remark;
    else delete record.remark;
    writeVault(dir, file);
    return true;
  });
}

export type RenameOutcome = "renamed" | "missing" | "taken";

/** Re-encrypts, because the name is bound into the ciphertext. The value never leaves this function. */
export function renameSecret(from: string, to: string, dir = defaultVaultDir(), keys = providerFor(dir)): RenameOutcome {
  if (!SECRET_NAME_RE.test(to)) throw new Error("Invalid secret name");
  return withVaultLock(dir, () => {
    const file = readVault(dir);
    const old = file.records[from];
    if (!old) return "missing";
    if (from === to) return "renamed";
    if (file.records[to]) return "taken";
    const key = keys.read();
    if (!key) throw new Error("The vault has records but its key is gone");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(old.iv, "base64"));
    decipher.setAAD(aad(from));
    decipher.setAuthTag(Buffer.from(old.tag, "base64"));
    const value = Buffer.concat([decipher.update(Buffer.from(old.ct, "base64")), decipher.final()]).toString("utf8");
    file.records[to] = seal(key, to, value, old.source, old.addedAt, old.remark);
    delete file.records[from];
    writeVault(dir, file);
    return "renamed";
  });
}
