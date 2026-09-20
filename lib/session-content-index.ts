import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { projectTreeForResponse } from "./project-tree";
import type { SessionContext, SessionEntry, SessionTreeNode } from "./types";

interface IndexedRecord {
  id: string;
  parentId: string | null;
  type: string;
  offset: number;
  length: number;
  anchor: boolean;
  previewRole?: "user" | "assistant";
  previewText?: string;
  thinkingLevel?: string;
  model?: { provider: string; modelId: string };
}

interface FileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

interface PersistedSessionContentIndex {
  format: 1;
  filePath: string;
  identity: FileIdentity;
  indexedBytes: number;
  headHash: string;
  boundaryHash: string;
  records: IndexedRecord[];
  leafId: string | null;
  totalActiveMs: number;
  previousTimingTimestamp?: number;
  tree: SessionTreeNode[];
  version: string;
}

const HASH_WINDOW_BYTES = 4096;
const PREVIEW_LIMIT = 41;
const MAX_INDEX_BUILD_ATTEMPTS = 3;

declare global {
  var __piSessionContentIndexes: Map<string, PersistedSessionContentIndex> | undefined;
  var __piSessionContentIndexPromises: Map<string, Promise<PersistedSessionContentIndex>> | undefined;
}

function indexes(): Map<string, PersistedSessionContentIndex> {
  globalThis.__piSessionContentIndexes ??= new Map();
  return globalThis.__piSessionContentIndexes;
}

function promises(): Map<string, Promise<PersistedSessionContentIndex>> {
  globalThis.__piSessionContentIndexPromises ??= new Map();
  return globalThis.__piSessionContentIndexPromises;
}

function fileIdentity(filePath: string): FileIdentity {
  const stats = statSync(filePath, { bigint: true });
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: Number(stats.size),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

function versionOf(identity: FileIdentity, indexedBytes: number, boundaryHash: string): string {
  return createHash("sha256")
    .update([identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs, indexedBytes, boundaryHash].join(":"))
    .digest("base64url")
    .slice(0, 22);
}

function hashRange(filePath: string, start: number, length: number): string {
  if (length <= 0) return createHash("sha256").digest("base64url");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("base64url");
  } finally {
    closeSync(fd);
  }
}

function contentHashAt(filePath: string, indexedBytes: number): { headHash: string; boundaryHash: string } {
  return {
    headHash: hashRange(filePath, 0, Math.min(indexedBytes, HASH_WINDOW_BYTES)),
    boundaryHash: hashRange(
      filePath,
      Math.max(0, indexedBytes - HASH_WINDOW_BYTES),
      Math.min(indexedBytes, HASH_WINDOW_BYTES),
    ),
  };
}

function indexPath(filePath: string): string {
  const directory = join(getAgentDir(), "pi-web-session-content-index-v1");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(filePath).digest("hex");
  return join(directory, `${name}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPersisted(filePath: string): PersistedSessionContentIndex | null {
  const path = indexPath(filePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSessionContentIndex;
    if (
      parsed.format !== 1
      || parsed.filePath !== filePath
      || !isRecord(parsed.identity)
      || !Number.isSafeInteger(parsed.indexedBytes)
      || parsed.indexedBytes < 0
      || typeof parsed.headHash !== "string"
      || typeof parsed.boundaryHash !== "string"
      || typeof parsed.version !== "string"
      || !Array.isArray(parsed.records)
      || !parsed.records.every((record) => (
        isRecord(record)
        && typeof record.id === "string"
        && (record.parentId === null || typeof record.parentId === "string")
        && typeof record.type === "string"
        && Number.isSafeInteger(record.offset)
        && record.offset >= 0
        && Number.isSafeInteger(record.length)
        && record.length >= 0
        && typeof record.anchor === "boolean"
      ))
      || !Array.isArray(parsed.tree)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function previewOf(entry: Record<string, unknown>): Pick<IndexedRecord, "previewRole" | "previewText"> {
  if (entry.type !== "message" || !isRecord(entry.message)) return {};
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return {};
  const content = entry.message.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return {
    previewRole: role,
    previewText: text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text || (role === "assistant" ? "[assistant]" : "message"),
  };
}

function toIndexedRecord(entry: Record<string, unknown>, offset: number, length: number): IndexedRecord | null {
  if (typeof entry.id !== "string" || typeof entry.type !== "string") return null;
  const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
  const message = isRecord(entry.message) ? entry.message : undefined;
  const model = entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string"
    ? { provider: entry.provider, modelId: entry.modelId }
    : entry.type === "message" && message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string"
      ? { provider: message.provider, modelId: message.model }
      : undefined;
  return {
    id: entry.id,
    parentId,
    type: entry.type,
    offset,
    length,
    anchor: entry.type === "compaction" || (entry.type === "message" && message?.role === "user"),
    ...previewOf(entry),
    ...(entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string" ? { thinkingLevel: entry.thinkingLevel } : {}),
    ...(model ? { model } : {}),
  };
}

function updateTiming(index: PersistedSessionContentIndex, entry: Record<string, unknown>): void {
  const type = entry.type;
  if (type !== "message" && type !== "compaction" && type !== "branch_summary" && type !== "custom_message") return;
  const timestamp = Date.parse(String(entry.timestamp ?? ""));
  if (!Number.isFinite(timestamp)) return;
  const role = type === "message" && isRecord(entry.message) ? entry.message.role : undefined;
  if (role !== "user" && role !== "bashExecution" && index.previousTimingTimestamp !== undefined && timestamp > index.previousTimingTimestamp) {
    index.totalActiveMs += timestamp - index.previousTimingTimestamp;
  }
  index.previousTimingTimestamp = timestamp;
}

function buildProjectedTree(records: IndexedRecord[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const record of records) {
    const entry = {
      id: record.id,
      parentId: record.parentId,
      type: record.previewRole ? "message" : record.type,
      ...(record.previewRole ? { message: { role: record.previewRole, content: record.previewText ?? "" } } : {}),
    } as unknown as SessionEntry;
    byId.set(record.id, { entry, children: [] });
  }
  const roots: SessionTreeNode[] = [];
  for (const record of records) {
    const node = byId.get(record.id)!;
    const parent = record.parentId ? byId.get(record.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return projectTreeForResponse(roots);
}

function blankIndex(filePath: string, identity: FileIdentity): PersistedSessionContentIndex {
  return {
    format: 1,
    filePath,
    identity,
    indexedBytes: 0,
    headHash: "",
    boundaryHash: "",
    records: [],
    leafId: null,
    totalActiveMs: 0,
    tree: [],
    version: "",
  };
}

function canAppend(filePath: string, current: FileIdentity, previous: PersistedSessionContentIndex): boolean {
  if (previous.identity.dev !== current.dev || previous.identity.ino !== current.ino || current.size < previous.indexedBytes) return false;
  const hashes = contentHashAt(filePath, previous.indexedBytes);
  return hashes.headHash === previous.headHash && hashes.boundaryHash === previous.boundaryHash;
}

async function scanFrom(filePath: string, index: PersistedSessionContentIndex): Promise<void> {
  let pending = Buffer.alloc(0);
  let pendingOffset = index.indexedBytes;
  let parsedLines = 0;
  for await (const chunkValue of createReadStream(filePath, { start: index.indexedBytes })) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let lineStart = 0;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      if (pending[cursor] !== 0x0a) continue;
      const raw = pending.subarray(lineStart, cursor);
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      const offset = pendingOffset + lineStart;
      try {
        const entry = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
        if (entry.type !== "session") {
          const record = toIndexedRecord(entry, offset, line.length);
          if (record) {
            index.records.push(record);
            index.leafId = record.id;
            updateTiming(index, entry);
          }
        }
      } catch {
        // 完整但损坏的行与 SDK 的容错列表读取保持一致，跳过并继续建立可用索引。
      }
      index.indexedBytes = pendingOffset + cursor + 1;
      lineStart = cursor + 1;
      parsedLines += 1;
      if (parsedLines % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (lineStart > 0) {
      pending = pending.subarray(lineStart);
      pendingOffset = index.indexedBytes;
    }
  }
}

async function buildOrUpdateIndex(filePath: string, attempt = 1): Promise<PersistedSessionContentIndex> {
  const current = fileIdentity(filePath);
  const memory = indexes().get(filePath);
  const persisted = memory ?? loadPersisted(filePath);
  if (persisted && persisted.identity.size === current.size && persisted.identity.mtimeNs === current.mtimeNs && persisted.identity.ctimeNs === current.ctimeNs) {
    indexes().set(filePath, persisted);
    return persisted;
  }

  const index = persisted && canAppend(filePath, current, persisted)
    ? { ...persisted, records: [...persisted.records] }
    : blankIndex(filePath, current);
  await scanFrom(filePath, index);
  const finalIdentity = fileIdentity(filePath);
  if (finalIdentity.size !== current.size || finalIdentity.mtimeNs !== current.mtimeNs || finalIdentity.ctimeNs !== current.ctimeNs) {
    if (attempt >= MAX_INDEX_BUILD_ATTEMPTS) throw new Error("会话文件持续变化，无法发布一致的内容索引");
    return buildOrUpdateIndex(filePath, attempt + 1);
  }
  index.identity = finalIdentity;
  const hashes = contentHashAt(filePath, index.indexedBytes);
  index.headHash = hashes.headHash;
  index.boundaryHash = hashes.boundaryHash;
  index.version = versionOf(finalIdentity, index.indexedBytes, index.boundaryHash);
  index.tree = buildProjectedTree(index.records);
  writePrivateFileAtomicSync(indexPath(filePath), JSON.stringify(index));
  indexes().set(filePath, index);
  return index;
}

export async function getSessionContentIndex(filePath: string): Promise<PersistedSessionContentIndex> {
  const existing = promises().get(filePath);
  if (existing) return existing;
  const pending = buildOrUpdateIndex(filePath).finally(() => {
    if (promises().get(filePath) === pending) promises().delete(filePath);
  });
  promises().set(filePath, pending);
  return pending;
}

function readRecords(filePath: string, records: IndexedRecord[]): SessionEntry[] {
  if (records.length === 0) return [];
  const fd = openSync(filePath, "r");
  try {
    return records.map((record) => {
      const buffer = Buffer.allocUnsafe(record.length);
      const bytesRead = readSync(fd, buffer, 0, record.length, record.offset);
      if (bytesRead !== record.length) throw new Error(`会话索引记录读取不完整: ${record.id}`);
      return JSON.parse(buffer.toString("utf8")) as SessionEntry;
    });
  } finally {
    closeSync(fd);
  }
}

/** 按索引读取单条记录，供思考、图片和大文本的按需接口复用。 */
export async function readIndexedSessionEntry(filePath: string, entryId: string): Promise<SessionEntry | null> {
  const index = await getSessionContentIndex(filePath);
  const record = index.records.find((candidate) => candidate.id === entryId);
  return record ? readRecords(filePath, [record])[0] ?? null : null;
}

export interface IndexedContextPage {
  entries: SessionEntry[];
  leafId: string | null;
  settings: Pick<SessionContext, "thinkingLevel" | "model">;
  totalActiveMs: number;
  version: string;
}

export async function readIndexedContextPage(
  filePath: string,
  options: { leafId?: string; before?: string; tail: number },
): Promise<IndexedContextPage> {
  const index = await getSessionContentIndex(filePath);
  const byId = new Map(index.records.map((record) => [record.id, record]));
  const activeLeafId = options.leafId ?? index.leafId;
  let current = byId.get(options.before ?? activeLeafId ?? "");
  if (options.before) current = current?.parentId ? byId.get(current.parentId) : undefined;
  const selected: IndexedRecord[] = [];
  while (current && selected.length < options.tail) {
    selected.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  let thinkingLevel: string | undefined;
  let model: SessionContext["model"] | undefined;
  let settingsCursor = byId.get(options.before ?? activeLeafId ?? "");
  while (settingsCursor && (thinkingLevel === undefined || model === undefined)) {
    thinkingLevel ??= settingsCursor.thinkingLevel;
    model ??= settingsCursor.model;
    settingsCursor = settingsCursor.parentId ? byId.get(settingsCursor.parentId) : undefined;
  }
  selected.reverse();
  return {
    entries: readRecords(filePath, selected),
    leafId: activeLeafId,
    settings: { thinkingLevel: thinkingLevel ?? "off", model: model ?? null },
    totalActiveMs: index.totalActiveMs,
    version: index.version,
  };
}

export async function readIndexedSessionDetails(filePath: string): Promise<{
  leafId: string | null;
  tree: SessionTreeNode[];
  version: string;
}> {
  const index = await getSessionContentIndex(filePath);
  return { leafId: index.leafId, tree: index.tree, version: index.version };
}

export function resetSessionContentIndexesForTests(): void {
  globalThis.__piSessionContentIndexes = undefined;
  globalThis.__piSessionContentIndexPromises = undefined;
}
