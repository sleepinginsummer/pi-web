import { closeSync, openSync, readFileSync, readSync, statSync } from "fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export type SessionDiskFreshness = "current" | "changed" | "unstable";
type SessionDiskManager = Pick<SessionManager, "getHeader" | "getEntries">;

/** pi-web 自己对文件的改写：登记后不再被当成外部修改。 */
export interface SessionSelfAuthoredRewrite {
  /** 改写后的文件头（例如删除父会话时的级联 parentSession 重写）。 */
  header?: unknown;
  /** 改写后的 entry，按 id 覆盖内存里的旧版本。 */
  entries?: readonly unknown[];
}

/** 已知 EOF 之前用于确认「前缀没被动过」的窗口字节数。 */
const PREFIX_WINDOW_BYTES = 64 * 1024;
/** 单次增量核对的追加上限；超过就直接全量校验。 */
const MAX_APPEND_TAIL_BYTES = 32 * 1024 * 1024;
/**
 * 小于这个长度的文件一律全量核对：它们的全量代价只有毫秒级，没必要为省它
 * 让增量路径的「只核对尾部」盲区出现在小会话上。
 */
const FULL_VERIFY_MAX_BYTES = 2 * 1024 * 1024;
/** 读取首行 header 的上限。 */
const HEADER_PROBE_BYTES = 64 * 1024;
/**
 * 增量路径允许跳过前缀核对的预算：累计追加字节数或距上次全量核对的时间任一超标，
 * 下一次核对就必须重新解析整个文件。没有这个预算，「窗口之外的原地改写」可能一直不被发现。
 */
const MAX_DEFERRED_PREFIX_BYTES = 8 * 1024 * 1024;
const MAX_DEFERRED_PREFIX_MS = 5 * 60 * 1000;

/** 增量核对的预算，可用更小的值注入以覆盖边界。 */
export interface SessionDiskInspectorOptions {
  /** 累计追加多少字节之后必须重新全量核对。 */
  maxDeferredPrefixBytes?: number;
  /** 距上次全量核对多久之后必须重新全量核对。 */
  maxDeferredPrefixMs?: number;
}

function entryId(entry: unknown): string | undefined {
  const id = (entry as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

type FileStat = {
  version: string;
  identity: string;
  size: number;
};

function statOf(filePath: string): FileStat | null {
  try {
    const stat = statSync(filePath, { bigint: true });
    return {
      version: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
      identity: `${stat.dev}:${stat.ino}`,
      size: Number(stat.size),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 读取文件的一段字节；文件在此期间变短时返回实际读到的部分。 */
function readRange(filePath: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, position + offset);
      if (read <= 0) break;
      offset += read;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** 一段 JSONL entry 行与预期条目的比对结果。 */
type JsonlEntryComparison = {
  /** 实际比对过的 entry 条数（空行不计）。 */
  count: number;
  /** ok=全部一致；changed=内容不一致；unstable=行还没写完，下次请求再试。 */
  status: "ok" | "changed" | "unstable";
};

/**
 * 逐条比对 JSONL entry 行与预期条目。
 *
 * 空行按 pi 的读法跳过；pi-web 自己改写的 entry 用登记值比对，其余按位置严格比对。
 * 全量与增量必须共用这一份规则，否则两条路径会各自漂移（空行、登记改写都曾只在其中一边处理）。
 */
function compareJsonlEntryLines(
  lines: readonly string[],
  expected: readonly unknown[],
  adopted: ReadonlyMap<string, unknown>,
): JsonlEntryComparison {
  let count = 0;
  let differs = false;
  for (const line of lines) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return { count, status: "unstable" };
    }
    const id = entryId(entry);
    const adoptedEntry = id === undefined ? undefined : adopted.get(id);
    const expectedEntry = adoptedEntry !== undefined ? adoptedEntry : expected[count];
    if (expectedEntry === undefined || JSON.stringify(entry) !== JSON.stringify(expectedEntry)) differs = true;
    count += 1;
  }
  return { count, status: differs ? "changed" : "ok" };
}

/** 文件头与预期文件头的比对；两侧都先 parse，消除格式差异。 */
function compareHeaderLine(line: string, expectedJson: string): "ok" | "differs" | "unparsable" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "unparsable";
  }
  return JSON.stringify(parsed) === expectedJson ? "ok" : "differs";
}

/** 上次全量核对成功时的状态：只有它之后的追加才允许走增量路径。 */
type VerifiedState = {
  version: string;
  identity: string;
  size: number;
  /** 当时 SessionManager 里的 entry 条数。 */
  entryCount: number;
  /** 当时的预期文件头（含 pi-web 登记的改写）。 */
  headerJson: string;
  /**
   * EOF 之前 PREFIX_WINDOW_BYTES 的原字节，用于确认前缀没被改写。
   * 必须是独立副本：subarray 会共享整个文件的缓冲区，100MB 会话会一直驻留 100MB。
   */
  tail: Buffer;
  /** 上次全量核对的时间，用于限制前缀核对的跳过时长。 */
  prefixVerifiedAtMs: number;
  /** 上次全量核对之后累计追加的字节数，用于限制前缀核对的跳过量。 */
  deferredBytes: number;
};

/**
 * 只在文件元信息变化时核对完整 JSONL，既识别同 ID 的原地重写，
 * 又不在长会话的每次 context 请求中重复解析整个文件。
 *
 * 长会话的全量核对要读秒级（100MB 实测约 1.5s）且会阻塞事件循环，而运行中的会话
 * 一直在这个窗口里追加，于是「追加落在核对期间」变成随机 409。因此核对分两层：
 *
 * - 增量（inspectAppendOnly）：只对超过 2MB 的文件启用。同一 inode、文件严格变长、
 *   首行 header 未变、已验证 EOF 前 64KB 逐字节未动，且新增区间能逐条对上内存里
 *   多出来的 entry 时判定 current，读取量正比于新增字节（大文件从秒级降到毫秒级）。
 * - 全量（inspectFull）：其余情况一律重新解析整个文件，任何不确定都走这里。
 *
 * 两层共用 compareJsonlEntryLines/compareHeaderLine：读取范围和预期条目各自由调用方决定，
 * 比对规则只有一份。
 * 预算只在 inspect() 入口判定一次，且早于版本缓存短路：增量登记之后不再追加时，版本会一直
 * 命中缓存，若把时间预算留在快路径内部，旧前缀就永远不会被重新核对。
 *
 * 增量路径不重读前缀，所以它只能被有限地跳过：累计追加超过 maxDeferredPrefixBytes 或
 * 距上次全量核对超过 maxDeferredPrefixMs（默认 8MB / 5 分钟）时，下一次核对强制回到全量，
 * 因此「窗口之外的原地改写」最迟在这个界线内被发现，不会一直漏下去。真正要防的
 * 「别人追加」必然落在尾部并被逐条比对；pi-web 自己的原地改写通过
 * adoptSelfAuthoredRewrite 登记，不走这条盲区；小文件本来就不启用增量路径。
 */
export class SessionDiskInspector {
  private verified: VerifiedState | null = null;
  private observedFile: boolean;
  /** pi-web 自己改写的文件头；未登记时用 SessionManager 里的那份。 */
  private adoptedHeader: unknown;
  /** pi-web 自己改写的 entry，按 id 覆盖内存里的旧版本。 */
  private readonly adoptedEntries = new Map<string, unknown>();
  private readonly maxDeferredPrefixBytes: number;
  private readonly maxDeferredPrefixMs: number;

  constructor(
    private readonly manager: SessionDiskManager,
    existedOnOpen: boolean,
    options: SessionDiskInspectorOptions = {},
  ) {
    this.observedFile = existedOnOpen;
    this.maxDeferredPrefixBytes = options.maxDeferredPrefixBytes ?? MAX_DEFERRED_PREFIX_BYTES;
    this.maxDeferredPrefixMs = options.maxDeferredPrefixMs ?? MAX_DEFERRED_PREFIX_MS;
  }

  /**
   * 登记 pi-web 自己刚做完的文件改写（例如删除父会话时的级联 parentSession 重写）。
   * 不做这件事的话，存活的 wrapper 会把自己人写的文件判成外部修改，运行中直接 409。
   * 只登记被改写的字段，其余内容照旧逐条严格比对；登记后作废上次校验结果。
   */
  adoptSelfAuthoredRewrite(rewrite: SessionSelfAuthoredRewrite): void {
    if (rewrite.header !== undefined) this.adoptedHeader = rewrite.header;
    for (const entry of rewrite.entries ?? []) {
      const id = entryId(entry);
      if (id) this.adoptedEntries.set(id, entry);
    }
    this.verified = null;
  }

  /**
   * 诊断用：当前为确认前缀而保留的字节数（底层分配，含未使用的容量）。
   * 必须是 PREFIX_WINDOW_BYTES 量级，不能随会话文件大小增长。
   */
  retainedPrefixBytes(): number {
    return this.verified?.tail.buffer.byteLength ?? 0;
  }

  private expectedHeader(): unknown {
    return this.adoptedHeader !== undefined ? this.adoptedHeader : this.manager.getHeader();
  }

  inspect(filePath: string): SessionDiskFreshness {
    if (!filePath) return "current";
    const before = statOf(filePath);
    if (!before) return this.observedFile ? "unstable" : "current";
    this.observedFile = true;

    const verified = this.verified;
    if (!verified) return this.inspectFull(filePath, before);
    // 前缀预算在入口统一判定，且必须早于版本短路：增量登记之后如果不再追加，
    // 版本缓存会一直命中，旧前缀就永远不会被重新核对。
    if (this.prefixBudgetExpired(verified)) return this.inspectFull(filePath, before);
    if (before.version === verified.version) return "current";
    if (this.canSkipPrefixVerification(verified, before)) {
      const appended = this.inspectAppendOnly(filePath, before, verified);
      // null=增量证据不足（前缀被改写、header 不一致等），交给全量核对出结论。
      if (appended !== null) return appended;
    }
    return this.inspectFull(filePath, before);
  }

  /**
   * 前缀跳过的预算是否已经用尽：时间超限或累计追加超限。
   * 用尽后即使文件版本没变，下一次核对也必须重新解析整个文件。
   */
  private prefixBudgetExpired(verified: VerifiedState): boolean {
    if (Date.now() - verified.prefixVerifiedAtMs > this.maxDeferredPrefixMs) return true;
    return verified.deferredBytes > this.maxDeferredPrefixBytes;
  }

  /**
   * 增量路径的结构资格：同一文件、严格变长、文件够大，且这次的追加仍在前缀预算内。
   * 预算是否已经用尽由 inspect() 在入口判定；任何一条不成立都交给全量核对。
   */
  private canSkipPrefixVerification(verified: VerifiedState, before: FileStat): boolean {
    if (before.identity !== verified.identity) return false;
    if (before.size <= verified.size) return false;
    if (before.size === 0) return false;
    const appendedBytes = before.size - verified.size;
    if (appendedBytes > MAX_APPEND_TAIL_BYTES) return false;
    if (before.size <= FULL_VERIFY_MAX_BYTES) return false;
    // 这次的追加也必须仍在字节预算内，超过了就由全量核对顺带把预算重置掉。
    if (verified.deferredBytes + appendedBytes > this.maxDeferredPrefixBytes) return false;
    if (verified.entryCount > this.manager.getEntries().length) return false;
    return true;
  }

  /**
   * 追加优先的增量核对：只读 header 行、前缀窗口和新增字节。
   * 准入与预算由 inspect() 判定；本方法只负责读取、比对和提交。
   * @returns current/changed/unstable 表示已有结论；null 表示增量证据不足，必须走全量核对。
   */
  private inspectAppendOnly(filePath: string, before: FileStat, verified: VerifiedState): SessionDiskFreshness | null {
    let prefixBytes: Buffer;
    let headerBytes: Buffer;
    let appendedBytes: Buffer;
    try {
      prefixBytes = readRange(filePath, verified.size - verified.tail.length, verified.tail.length);
      headerBytes = readRange(filePath, 0, Math.min(HEADER_PROBE_BYTES, before.size));
      appendedBytes = readRange(filePath, verified.size, before.size - verified.size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unstable";
      throw error;
    }

    // 已验证前缀被动过（原地重写、截断后补齐）时不能只看尾部，退回全量。
    if (prefixBytes.length !== verified.tail.length || !prefixBytes.equals(verified.tail)) return null;

    // header 行必须完整且仍是预期值；探测窗口里没有换行说明这行超长，交给全量核对。
    const headerEnd = headerBytes.indexOf(0x0a);
    if (headerEnd < 0) return null;
    if (compareHeaderLine(headerBytes.toString("utf8", 0, headerEnd), verified.headerJson) !== "ok") return null;

    if (appendedBytes.length !== before.size - verified.size) return "unstable";
    const appendedText = appendedBytes.toString("utf8");
    if (!appendedText.endsWith("\n")) return "unstable";
    const expected = this.manager.getEntries();
    const expectedTail = expected.slice(verified.entryCount);
    const comparison = compareJsonlEntryLines(
      appendedText.slice(0, -1).split("\n"),
      expectedTail,
      this.adoptedEntries,
    );
    if (comparison.status === "unstable") return "unstable";
    if (comparison.status === "changed" || comparison.count !== expectedTail.length) return "changed";

    // 读取期间文件又变了时，判定结果不能用，让下一次请求重试。
    const after = statOf(filePath);
    if (!after || after.version !== before.version) return "unstable";
    this.verified = {
      version: before.version,
      identity: before.identity,
      size: before.size,
      entryCount: expected.length,
      headerJson: verified.headerJson,
      // Buffer.from 复制：subarray 会共享这次的读取缓冲区，大块追加会被一直拖住。
      tail: Buffer.from(appendedBytes.length >= PREFIX_WINDOW_BYTES
        ? appendedBytes.subarray(appendedBytes.length - PREFIX_WINDOW_BYTES)
        : Buffer.concat([verified.tail, appendedBytes]).subarray(-PREFIX_WINDOW_BYTES)),
      prefixVerifiedAtMs: verified.prefixVerifiedAtMs,
      deferredBytes: verified.deferredBytes + appendedBytes.length,
    };
    return "current";
  }

  /** 全量核对：逐条比对文件内容与内存（含 pi-web 登记的改写）。 */
  private inspectFull(filePath: string, before: FileStat): SessionDiskFreshness {
    let buffer: Buffer;
    try {
      buffer = readFileSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unstable";
      throw error;
    }
    const contents = buffer.toString("utf8");
    // 文件在校验期间变化时拒绝使用当前 wrapper，下次请求再重试。
    if (statOf(filePath)?.version !== before.version) return "unstable";
    if (!contents.endsWith("\n")) return "unstable";

    const expectedHeader = this.expectedHeader();
    const lines = contents.split("\n");
    const headerIndex = lines.findIndex((line) => line !== "");
    const headerStatus = headerIndex < 0
      ? "differs"
      : compareHeaderLine(lines[headerIndex], JSON.stringify(expectedHeader));
    const comparison = compareJsonlEntryLines(
      headerIndex < 0 ? [] : lines.slice(headerIndex + 1),
      this.manager.getEntries(),
      this.adoptedEntries,
    );

    // 解析长文件期间也可能发生写入，判定结果只能基于前后相同的文件版本。
    if (statOf(filePath)?.version !== before.version) return "unstable";
    if (headerStatus === "unparsable" || comparison.status === "unstable") return "unstable";
    const expectedCount = this.manager.getEntries().length;
    if (headerStatus !== "ok" || comparison.status === "changed" || comparison.count !== expectedCount) {
      return "changed";
    }
    this.verified = {
      version: before.version,
      identity: before.identity,
      size: before.size,
      entryCount: expectedCount,
      headerJson: JSON.stringify(expectedHeader),
      // Buffer.from 复制：subarray 会共享整个文件的缓冲区，等于把 100MB 一直留在内存里。
      tail: Buffer.from(buffer.subarray(Math.max(0, buffer.length - PREFIX_WINDOW_BYTES))),
      prefixVerifiedAtMs: Date.now(),
      deferredBytes: 0,
    };
    return "current";
  }
}
