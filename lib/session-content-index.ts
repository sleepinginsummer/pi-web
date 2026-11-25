import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { projectTreeForResponse } from "./project-tree";
import { countTurnsBefore, turnAnchorShape } from "./session-turns";
import { createPageWalker } from "./session-page-budget";
import { getTurnAnchors, type TurnAnchorMessage } from "./message-display";
import { hasOutlineFinalAnswer } from "./outline-final-answer";
import type { SessionContext, SessionEntry, SessionTreeNode } from "./types";
import { readShadowMindStateEntry, type ShadowStateEntryLike } from "./shadow-session-protocol";
import { observerEnabledChange, observerRecord, SESSION_OBSERVER_ENTRY } from "./session-observer-protocol";
import {
  accumulateSessionStatsEntry,
  createEmptySessionStats,
  finalizeSessionStats,
  type SessionFileStats,
  type SessionUsageSummary,
} from "./session-stats";
import { SIDE_META_TYPE } from "./side-session";

interface IndexedRecord {
  id: string;
  parentId: string | null;
  type: string;
  offset: number;
  length: number;
  /** 这条记录开启新的一轮（与聊天分组、minimap 编号相同的规则）。 */
  turn?: TurnAnchorMessage;
  previewRole?: "user" | "assistant";
  previewText?: string;
  thinkingLevel?: string;
  model?: { provider: string; modelId: string };
  shadowMindEnabled?: boolean;
  /** custom 记录的 customType，用于按需读取观察员/侧聊/子代理/工具选择等极少数元数据行。 */
  customType?: string;
}

interface FileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

interface PersistedSessionContentIndex {
  // 5：新增会话用量统计、观察员开关、side 边界和摘要元数据，旧索引需重建。
  format: 5;
  filePath: string;
  identity: FileIdentity;
  indexedBytes: number;
  headHash: string;
  boundaryHash: string;
  records: IndexedRecord[];
  leafId: string | null;
  totalActiveMs: number;
  previousTimingTimestamp?: number;
  sideCreatedAt: string | null;
  ownStats: SessionFileStats;
  ownTotalActiveMs: number;
  ownPreviousTimingTimestamp?: number;
  observerEnabledBySession: Record<string, boolean>;
  sessionName?: string;
  firstUserMessage?: string;
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

/**
 * 内存里最多留几份内容索引。
 *
 * 索引本身已经落盘（`writePrivateFileAtomicSync`），淘汰只是让下次重新读一遍文件；
 * 不设上限时，每个浏览过的会话的 `records` + `tree` 会一直驻留，长时间开着页面
 * 会把几百万条记录留在内存里。32 份足够覆盖最近浏览的几个项目，兼顾内存占用。
 */
const MAX_CACHED_INDEXES = 32;
/** 内存索引总记录数上限（约 30MB 堆占用），防止多个超大会话叠加撑爆内存。 */
export const MAX_CACHED_INDEX_RECORDS = 100_000;
const ORPHAN_GC_INTERVAL_MS = 30 * 60 * 1000;
let lastOrphanGcAt = 0;

function indexes(): Map<string, PersistedSessionContentIndex> {
  globalThis.__piSessionContentIndexes ??= new Map();
  return globalThis.__piSessionContentIndexes;
}

/** 写入最近使用的一份，并按份数与总记录数双重上限从最久未用开始 LRU 淘汰。 */
function rememberIndex(filePath: string, index: PersistedSessionContentIndex): void {
  const map = indexes();
  map.delete(filePath);
  map.set(filePath, index);
  let totalRecords = 0;
  for (const item of map.values()) totalRecords += item.records.length;
  while (map.size > MAX_CACHED_INDEXES || (map.size > 1 && totalRecords > MAX_CACHED_INDEX_RECORDS)) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    const evicted = map.get(oldest);
    map.delete(oldest);
    if (evicted) totalRecords -= evicted.records.length;
  }
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
      parsed.format !== 5
      || parsed.filePath !== filePath
      || !isRecord(parsed.identity)
      || !Number.isSafeInteger(parsed.indexedBytes)
      || parsed.indexedBytes < 0
      || typeof parsed.headHash !== "string"
      || typeof parsed.boundaryHash !== "string"
      || typeof parsed.version !== "string"
      || (parsed.sideCreatedAt !== null && typeof parsed.sideCreatedAt !== "string")
      || !isRecord(parsed.ownStats)
      || !isRecord(parsed.ownStats.tokens)
      || typeof parsed.ownTotalActiveMs !== "number"
      || !isRecord(parsed.observerEnabledBySession)
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
        && (record.turn === undefined || (record.turn !== null && typeof record.turn === "object"))
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
  const shadowMindEnabled = readShadowMindStateEntry(entry as ShadowStateEntryLike);
  const turn = turnAnchorShape(entry);
  return {
    id: entry.id,
    parentId,
    type: entry.type,
    offset,
    length,
    ...(turn ? { turn } : {}),
    ...previewOf(entry),
    ...(entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string" ? { thinkingLevel: entry.thinkingLevel } : {}),
    ...(model ? { model } : {}),
    ...(shadowMindEnabled !== null ? { shadowMindEnabled } : {}),
    ...(entry.type === "custom" && typeof entry.customType === "string" ? { customType: entry.customType } : {}),
  };
}

function updateTimingFields(
  target: { totalActiveMs: number; previousTimingTimestamp?: number },
  entry: Record<string, unknown>,
): void {
  const type = entry.type;
  if (type !== "message" && type !== "compaction" && type !== "branch_summary" && type !== "custom_message") return;
  const timestamp = Date.parse(String(entry.timestamp ?? ""));
  if (!Number.isFinite(timestamp)) return;
  const role = type === "message" && isRecord(entry.message) ? entry.message.role : undefined;
  if (role !== "user" && role !== "bashExecution" && target.previousTimingTimestamp !== undefined && timestamp > target.previousTimingTimestamp) {
    target.totalActiveMs += timestamp - target.previousTimingTimestamp;
  }
  target.previousTimingTimestamp = timestamp;
}

function updateTiming(index: PersistedSessionContentIndex, entry: Record<string, unknown>): void {
  updateTimingFields(index, entry);
}

function updateOwnTiming(index: PersistedSessionContentIndex, entry: Record<string, unknown>): void {
  const holder = {
    totalActiveMs: index.ownTotalActiveMs,
    previousTimingTimestamp: index.ownPreviousTimingTimestamp,
  };
  updateTimingFields(holder, entry);
  index.ownTotalActiveMs = holder.totalActiveMs;
  index.ownPreviousTimingTimestamp = holder.previousTimingTimestamp;
}

function extractFirstUserMessageText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const firstText = content.find((block) => isRecord(block) && block.type === "text" && typeof block.text === "string") as { text: string } | undefined;
    text = firstText?.text ?? "";
  }
  // 防止超长首条用户消息把索引文件撑大；列表与信息面板不需要超过 4KB 的首句。
  return text.length > 4096 ? text.slice(0, 4096) : text;
}

function updateIndexMetadata(index: PersistedSessionContentIndex, entry: Record<string, unknown>): void {
  if (
    index.sideCreatedAt === null
    && entry.type === "custom"
    && entry.customType === SIDE_META_TYPE
    && isRecord(entry.data)
    && entry.data.version === 1
    && typeof entry.data.parentSessionId === "string"
    && typeof entry.data.createdAt === "string"
  ) {
    index.sideCreatedAt = entry.data.createdAt;
    // side 元数据之前的记录均属于继承历史，重置自有统计与耗时。
    index.ownStats = createEmptySessionStats();
    index.ownTotalActiveMs = 0;
    index.ownPreviousTimingTimestamp = undefined;
  }

  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const isOwn = index.sideCreatedAt === null || timestamp > index.sideCreatedAt;
  if (isOwn) {
    accumulateSessionStatsEntry(index.ownStats, entry as unknown as SessionEntry);
    updateOwnTiming(index, entry);
  }

  if (entry.type === "custom" && entry.customType === SESSION_OBSERVER_ENTRY && isRecord(entry.data) && typeof entry.data.sessionId === "string") {
    const enabled = observerEnabledChange(observerRecord(entry as { type: string; customType?: string; data?: unknown }, entry.data.sessionId));
    if (typeof enabled === "boolean") {
      index.observerEnabledBySession[entry.data.sessionId] = enabled;
    }
  }

  if (entry.type === "session_info" && typeof entry.name === "string") {
    const trimmed = entry.name.trim();
    index.sessionName = trimmed || undefined;
  }

  if (index.firstUserMessage === undefined) {
    const firstText = extractFirstUserMessageText(entry);
    if (firstText !== undefined) index.firstUserMessage = firstText;
  }
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
    format: 5,
    filePath,
    identity,
    indexedBytes: 0,
    headHash: "",
    boundaryHash: "",
    records: [],
    leafId: null,
    totalActiveMs: 0,
    sideCreatedAt: null,
    ownStats: createEmptySessionStats(),
    ownTotalActiveMs: 0,
    observerEnabledBySession: {},
    tree: [],
    version: "",
  };
}

function canAppend(filePath: string, current: FileIdentity, previous: PersistedSessionContentIndex): boolean {
  if (previous.identity.dev !== current.dev || previous.identity.ino !== current.ino || current.size < previous.indexedBytes) return false;
  const hashes = contentHashAt(filePath, previous.indexedBytes);
  return hashes.headHash === previous.headHash && hashes.boundaryHash === previous.boundaryHash;
}

const FAST_OBSERVER_LINE_MIN_BYTES = 16 * 1024;
const FAST_OBSERVER_PREFIX_BYTES = 1024;

/**
 * 200MB 级大会话里 `pi-web:session-observer` 交互记录可达上百 MB（单行最大 1.6MB）。
 * 建索引时它们只贡献 id/parentId/type/customType/timestamp，不需要 JSON.parse 整段大交互正文；
 * 仅对开关类记录（enabled/settings）或非常规字段顺序回退完整 JSON.parse。
 */
function tryFastParseLargeObserverLine(line: Buffer): Record<string, unknown> | null {
  if (line.length < FAST_OBSERVER_LINE_MIN_BYTES) return null;
  const prefix = line.subarray(0, Math.min(line.length, FAST_OBSERVER_PREFIX_BYTES)).toString("utf8");
  if (!prefix.includes(`"${SESSION_OBSERVER_ENTRY}"`)) return null;
  if (prefix.includes('"kind":"enabled"') || prefix.includes('"kind":"settings"')) return null;

  const typeMatch = /"type"\s*:\s*"custom"/.exec(prefix);
  const customTypeMatch = /"customType"\s*:\s*"pi-web:session-observer"/.exec(prefix);
  const idMatch = /"id"\s*:\s*"([^"\\]+)"/.exec(prefix);
  if (!typeMatch || !customTypeMatch || !idMatch) return null;

  const parentNullMatch = /"parentId"\s*:\s*null\b/.exec(prefix);
  const parentStrMatch = /"parentId"\s*:\s*"([^"\\]+)"/.exec(prefix);
  if (!parentNullMatch && !parentStrMatch) return null;

  const timestampMatch = /"timestamp"\s*:\s*"([^"\\]+)"/.exec(prefix);
  return {
    type: "custom",
    customType: SESSION_OBSERVER_ENTRY,
    id: idMatch[1],
    parentId: parentStrMatch ? parentStrMatch[1] : null,
    ...(timestampMatch ? { timestamp: timestampMatch[1] } : {}),
  };
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
        const entry = tryFastParseLargeObserverLine(line)
          ?? JSON.parse(line.toString("utf8")) as Record<string, unknown>;
        if (entry.type !== "session") {
          const record = toIndexedRecord(entry, offset, line.length);
          if (record) {
            index.records.push(record);
            index.leafId = record.id;
            updateTiming(index, entry);
            updateIndexMetadata(index, entry);
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
  const persisted = (memory?.format === 5 ? memory : null) ?? loadPersisted(filePath);
  if (persisted && persisted.identity.size === current.size && persisted.identity.mtimeNs === current.mtimeNs && persisted.identity.ctimeNs === current.ctimeNs) {
    rememberIndex(filePath, persisted);
    return persisted;
  }

  const index = persisted && canAppend(filePath, current, persisted)
    ? {
        ...persisted,
        records: [...persisted.records],
        ownStats: { ...persisted.ownStats, tokens: { ...persisted.ownStats.tokens } },
        observerEnabledBySession: { ...persisted.observerEnabledBySession },
      }
    : blankIndex(filePath, current);
  await scanFrom(filePath, index);
  finalizeSessionStats(index.ownStats);
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
  rememberIndex(filePath, index);
  scheduleOrphanIndexGc();
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

/**
 * 同一个会话文件里多次按偏移读取共用一个描述符。
 *
 * 大纲遇到长串纯工具记录时会一条条往前补读候选回答；每读一条都 open/close 一遍
 * 就是纯系统调用开销。调用方负责在 finally 里 close()。
 */
interface IndexedRecordReader {
  read(records: readonly IndexedRecord[]): SessionEntry[];
  close(): void;
}

function openRecordReader(filePath: string): IndexedRecordReader {
  const fd = openSync(filePath, "r");
  let closed = false;
  return {
    read(records) {
      return records.map((record) => {
        const buffer = Buffer.allocUnsafe(record.length);
        const bytesRead = readSync(fd, buffer, 0, record.length, record.offset);
        if (bytesRead !== record.length) throw new Error(`会话索引记录读取不完整: ${record.id}`);
        return JSON.parse(buffer.toString("utf8")) as SessionEntry;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

function readRecords(filePath: string, records: IndexedRecord[]): SessionEntry[] {
  if (records.length === 0) return [];
  const reader = openRecordReader(filePath);
  try {
    return reader.read(records);
  } finally {
    reader.close();
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
  /** 某条记录之上的轮次数，按索引中的完整祖先链计算。 */
  turnsBefore: (entryId: string) => number;
  settings: Pick<SessionContext, "thinkingLevel" | "model">;
  shadowMindEnabled: boolean;
  totalActiveMs: number;
  version: string;
}

export async function readIndexedContextPage(
  filePath: string,
  options: { leafId?: string; before?: string; tail: number },
  preloadedIndex?: PersistedSessionContentIndex,
): Promise<IndexedContextPage> {
  const index = preloadedIndex ?? await getSessionContentIndex(filePath);
  const byId = new Map(index.records.map((record) => [record.id, record]));
  const activeLeafId = options.leafId ?? index.leafId;
  let current = byId.get(options.before ?? activeLeafId ?? "");
  if (options.before) current = current?.parentId ? byId.get(current.parentId) : undefined;
  const selected: IndexedRecord[] = [];
  // 与内存路径共用同一份页预算：尾部连续的非消息记录不占 tail，按条数一刀切会
  // 让首屏一条消息都没有。索引里有每条记录的字节长度，顺带限制单页读取量。
  const walker = createPageWalker(options.tail);
  // 环检测：分页本身有上限，但父链成环时会把同一条记录反复算进页面。
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    selected.push(current);
    // 索引中只需读取元信息即可按可见消息分页，不用解析全部历史内容。
    const countsAsVisible = current.type === "compaction"
      || current.previewRole === "user"
      || current.previewRole === "assistant";
    if (walker.accept(countsAsVisible, current.length)) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const settings = resolveBranchSettings(byId, options.before ?? activeLeafId ?? null);
  selected.reverse();
  return {
    entries: readRecords(filePath, selected),
    leafId: activeLeafId,
    // 页内只有当前页的记录，向上数轮次必须走索引里的全部祖先（#791）。
    turnsBefore: (entryId: string) => {
      const oldest = selected.findIndex((record) => record.id === entryId);
      const record = byId.get(entryId);
      if (!record) return 0;
      const page = oldest < 0 ? [record] : selected.slice(oldest);
      return countTurnsBefore(byId, page, (entry) => entry.turn ?? null);
    },
    settings,
    // 与 wrapper 的 getEntries() 一致：开关属于整个会话，不随分支或分页回退。
    shadowMindEnabled: index.records.findLast((record) => typeof record.shadowMindEnabled === "boolean")?.shadowMindEnabled ?? false,
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

function resolveBranchSettings(
  byId: ReadonlyMap<string, IndexedRecord>,
  leafId: string | null,
): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (!leafId) return { thinkingLevel: "off", model: null };
  let thinkingLevel: string | undefined;
  let modelChange: SessionContext["model"] | undefined;
  let responseModel: SessionContext["model"] | undefined;
  let cursor = byId.get(leafId);
  // 环检测：损坏文件缺少设置时防止死循环。
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id) && (thinkingLevel === undefined || modelChange === undefined)) {
    visited.add(cursor.id);
    if (thinkingLevel === undefined && cursor.thinkingLevel !== undefined) {
      thinkingLevel = cursor.thinkingLevel;
    }
    if (modelChange === undefined && cursor.type === "model_change" && cursor.model) {
      modelChange = cursor.model;
    } else if (responseModel === undefined && cursor.type !== "model_change" && cursor.model) {
      responseModel = cursor.model;
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: modelChange ?? responseModel ?? null,
  };
}

/** 按索引读取会话累计用量与活动分支设置，供 `/api/sessions/stats` 免全量解析。 */
export async function readIndexedSessionUsageSummary(
  filePath: string,
  leafId?: string | null,
): Promise<SessionUsageSummary> {
  const index = await getSessionContentIndex(filePath);
  const byId = new Map(index.records.map((record) => [record.id, record]));
  const activeLeafId = leafId === undefined ? index.leafId : leafId;
  return {
    tokens: { ...index.ownStats.tokens },
    cost: index.ownStats.cost,
    toolCalls: index.ownStats.toolCalls,
    totalActiveMs: index.ownTotalActiveMs,
    ...resolveBranchSettings(byId, activeLeafId),
  };
}

/** O(1) 读取会话观察员开关状态，免全量解析。 */
export async function readIndexedObserverEnabled(filePath: string, sessionId: string): Promise<boolean> {
  const index = await getSessionContentIndex(filePath);
  return index.observerEnabledBySession[sessionId] === true;
}

/** 仅按偏移读取 `pi-web:session-observer` 记录，避免打开观察员面板时全量解析大会话。 */
export async function readIndexedObserverEntries(
  filePath: string,
  leafId?: string | null,
): Promise<{ entries: SessionEntry[]; branch: SessionEntry[] }> {
  const index = await getSessionContentIndex(filePath);
  const observerRecords = index.records.filter((record) => record.type === "custom" && record.customType === SESSION_OBSERVER_ENTRY);
  if (observerRecords.length === 0) return { entries: [], branch: [] };

  const activeLeafId = leafId === undefined ? index.leafId : leafId;
  const branchIds = new Set<string>();
  if (activeLeafId) {
    const byId = new Map(index.records.map((record) => [record.id, record]));
    let cursor = byId.get(activeLeafId);
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.type === "custom" && cursor.customType === SESSION_OBSERVER_ENTRY) {
        branchIds.add(cursor.id);
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  const entries = readRecords(filePath, observerRecords);
  const branch = entries.filter((entry) => branchIds.has(entry.id));
  return { entries, branch };
}

const SKIPPED_INFO_CUSTOM_TYPES = new Set([SESSION_OBSERVER_ENTRY, "shadow-mind-event"]);

export interface IndexedSessionFullView {
  leafId: string | null;
  tree: SessionTreeNode[];
  entries: SessionEntry[];
  settings: Pick<SessionContext, "thinkingLevel" | "model">;
  stats: SessionFileStats;
  totalActiveMs: number;
  entryCount: number;
  latestEntryId: string | null;
  sessionName?: string;
  firstUserMessage?: string;
  metaEntries: SessionEntry[];
  version: string;
  /** 某条记录之上的轮次数，按索引里的完整祖先链算（首屏只读了尾页）。 */
  turnsBefore: (entryId: string) => number;
}

/** 供 `GET /api/sessions/[id]` 按索引组装完整视图：仅读取尾页消息与极少数自定义元数据记录。 */
export async function readIndexedSessionFullView(
  filePath: string,
  options: { tail: number },
): Promise<IndexedSessionFullView> {
  const index = await getSessionContentIndex(filePath);
  const page = await readIndexedContextPage(filePath, { tail: options.tail });
  const metaRecords = index.records.filter(
    (record) => record.type === "custom" && record.customType !== undefined && !SKIPPED_INFO_CUSTOM_TYPES.has(record.customType),
  );
  const metaEntries = readRecords(filePath, metaRecords);
  return {
    leafId: index.leafId,
    tree: index.tree,
    entries: page.entries,
    settings: page.settings,
    stats: { ...index.ownStats, tokens: { ...index.ownStats.tokens } },
    totalActiveMs: index.ownTotalActiveMs,
    entryCount: index.records.length,
    latestEntryId: index.records.at(-1)?.id ?? null,
    sessionName: index.sessionName,
    firstUserMessage: index.firstUserMessage,
    metaEntries,
    version: index.version,
    turnsBefore: page.turnsBefore,
  };
}
/** 只读索引身份（文件签名、活动 leaf），供调用方先查上层缓存再决定是否逐条读记录。 */
export async function readIndexedOutlineIdentity(
  filePath: string,
  leafId?: string,
): Promise<{ leafId: string | null; version: string }> {
  const index = await getSessionContentIndex(filePath);
  return { leafId: leafId ?? index.leafId, version: index.version };
}

export interface IndexedBranchOutlineSlice {
  leafId: string | null;
  version: string;
  turns: Array<{
    turnNumber: number;
    anchor: SessionEntry;
    finalAssistant: SessionEntry | null;
  }>;
}

/** 删除指定会话对应的内存与磁盘内容索引（删除/归档会话时调用）。 */
export function deleteSessionContentIndex(filePath: string): void {
  indexes().delete(filePath);
  try {
    unlinkSync(indexPath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[pi-web] 删除会话内容索引失败:", error instanceof Error ? error.message : error);
    }
  }
}

function readIndexedFilePathQuick(indexFilePath: string): string | null {
  try {
    const fd = openSync(indexFilePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(4096);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) return null;
      const head = buffer.toString("utf8", 0, bytesRead);
      const match = /"filePath"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
      if (!match) return null;
      const parsed = JSON.parse(match[1]);
      return typeof parsed === "string" ? parsed : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 清理磁盘上对应原会话已不存在的孤儿索引文件，返回清理数量。 */
export function pruneOrphanSessionContentIndexes(): number {
  const directory = join(getAgentDir(), "pi-web-session-content-index-v1");
  if (!existsSync(directory)) return 0;
  let removed = 0;
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const fullPath = join(directory, name);
    const targetSessionPath = readIndexedFilePathQuick(fullPath);
    if (!targetSessionPath || !existsSync(targetSessionPath)) {
      try {
        unlinkSync(fullPath);
        removed += 1;
      } catch {
        // 并发已被删除则忽略
      }
    }
  }
  return removed;
}

function scheduleOrphanIndexGc(): void {
  const now = Date.now();
  if (now - lastOrphanGcAt < ORPHAN_GC_INTERVAL_MS) return;
  lastOrphanGcAt = now;
  setTimeout(() => {
    try {
      pruneOrphanSessionContentIndexes();
    } catch {
      // 后台清理失败不影响主流程
    }
  }, 5_000).unref?.();
}
/**
 * 仅按字节偏移读取当前活动分支上每轮的锚点记录和最终助手记录，
 * 跳过全部 toolResult 与中间过程消息，用于快速生成全量轻量大纲。
 */
export async function readIndexedBranchOutlineRecords(
  filePath: string,
  leafId?: string,
): Promise<IndexedBranchOutlineSlice> {
  const index = await getSessionContentIndex(filePath);
  const byId = new Map(index.records.map((record) => [record.id, record]));
  const activeLeafId = leafId ?? index.leafId;
  const branch: IndexedRecord[] = [];
  let cursor = byId.get(activeLeafId ?? "");
  // 环检测：走不到头就不会卡死（文件损坏时最多走一圈）。
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.turn) branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();
  const anchors = getTurnAnchors(branch.map((record) => record.turn!));
  const specs: Array<{ turnNumber: number; anchor: IndexedRecord; assistants: IndexedRecord[] }> = [];
  for (let i = 0; i < branch.length; i += 1) {
    if (!anchors[i]) continue;
    const assistants: IndexedRecord[] = [];
    let j = i + 1;
    while (j < branch.length && !anchors[j]) {
      if (branch[j].turn?.role === "assistant") assistants.push(branch[j]);
      j += 1;
    }
    specs.push({ turnNumber: specs.length + 1, anchor: branch[i], assistants });
  }
  const toRead: IndexedRecord[] = [];
  const seen = new Set<string>();
  const queue = (record: IndexedRecord) => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    toRead.push(record);
  };
  for (const spec of specs) {
    queue(spec.anchor);
    const last = spec.assistants.at(-1);
    if (last) queue(last);
  }
  // 同一份文件读一次描述符：末尾没有回答的轮次会逐条往前补读候选记录。
  const reader = openRecordReader(filePath);
  try {
    const entriesById = new Map(reader.read(toRead).map((entry) => [entry.id, entry]));
    const turns = specs
      .map((spec) => {
        const anchor = entriesById.get(spec.anchor.id);
        if (!anchor) return null;
        const finalAssistant = selectFinalAssistant(reader, spec.assistants, entriesById);
        return { turnNumber: spec.turnNumber, anchor, finalAssistant };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return { leafId: activeLeafId, version: index.version, turns };
  } finally {
    reader.close();
  }
}

/**
 * 与主对话一致：取本轮最后一条「有可展示回答」的助手记录。
 * 末尾只有工具调用、思考或空中止时继续往前找；整轮都没有回答则保留最后一条，
 * 由大纲按空摘要处理（主对话同样回退到它）。
 */
function selectFinalAssistant(
  reader: IndexedRecordReader,
  assistants: readonly IndexedRecord[],
  entriesById: Map<string, SessionEntry>,
): SessionEntry | null {
  const last = assistants.at(-1);
  if (!last) return null;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const record = assistants[i];
    let entry = entriesById.get(record.id);
    if (!entry) {
      entry = reader.read([record])[0];
      if (!entry) continue;
      entriesById.set(record.id, entry);
    }
    if (hasOutlineFinalAnswer(entry)) return entry;
  }
  return entriesById.get(last.id) ?? null;
}


export function resetSessionContentIndexesForTests(): void {
  globalThis.__piSessionContentIndexes = undefined;
  globalThis.__piSessionContentIndexPromises = undefined;
}
