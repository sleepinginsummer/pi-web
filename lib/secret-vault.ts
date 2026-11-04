import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * pi-web's side of the pi-secret-vault extension's encrypted vault.
 *
 * The file format, lock and Keychain item are the contract in that extension's `src/store.ts`;
 * a running session notices changes by the file's signature on its next hook. This module only
 * encrypts and never decrypts: Settings lists names and metadata, and no route returns a value.
 */
const VAULT_VERSION = 1;
const KEYCHAIN_SERVICE = "pi-secret-vault";
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 15000;
export const SECRET_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;

interface StoredRecord {
  iv: string;
  tag: string;
  ct: string;
  addedAt: number;
  source: string;
  length: number;
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

/** Names and metadata only. Needs no key, so a locked Keychain cannot hide the list. */
export function listSecrets(dir = defaultVaultDir()): SecretVaultEntry[] {
  return Object.entries(readVault(dir).records)
    .map(([name, record]) => ({ name, addedAt: record.addedAt, source: record.source, length: record.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveSecret(name: string, value: string, dir = defaultVaultDir(), keys = providerFor(dir)): void {
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
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`pi-secret-vault:v${VAULT_VERSION}:${name}`, "utf8"));
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    file.records[name] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
      addedAt: Date.now(),
      source: "web",
      length: value.length,
    };
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
