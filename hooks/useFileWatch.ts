"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createStreamSource } from "@/lib/sse-broker-client";
import { getFileApiUrl } from "@/lib/file-paths";

/**
 * 同一个标签页里最多同时保持几条文件 watch 连接。
 *
 * 浏览器对同一源只给 6 条连接，会话事件流和全局 attention 流常驻占 2 条；
 * 若每个打开的文件预览再各占一条，两个窗口加三个文件就能把额度占满，
 * 之后所有 API 请求（发消息、建会话、轮询）都会静默排队，页面表现为"没反应"。
 */
export const FILE_WATCH_BUDGET = 3;

/**
 * 文件 watch 的连接额度，按「连接实例」计数：每个 useFileWatch 实例持有一个
 * owner token。同一路径可能被两个实例（例如同一个文件在两个预览面板里）同时监听，
 * 那就是两条真实连接，必须各占一份；否则额度会低估实际连接数。
 */
export class FileWatchBudget {
  private owners = new Set<string>();
  /** 额度已满时排队的 owner，FIFO：先到先得，避免某个预览永远等不到。 */
  private waiters: string[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.owners.size;
  }

  /**
   * 申请额度：拿到返回 true；额度已满则进入等待队列并返回 false。
   * 等待者不需要自己轮询，持有者释放时会通过订阅通知它重试。
   */
  request(owner: string): boolean {
    if (this.owners.has(owner)) return true;
    if (this.owners.size < this.limit) {
      this.owners.add(owner);
      return true;
    }
    if (!this.waiters.includes(owner)) this.waiters.push(owner);
    return false;
  }

  release(owner: string): void {
    this.owners.delete(owner);
    this.waiters = this.waiters.filter((current) => current !== owner);
    this.promote();
  }

  /** 实例卸载或不再需要连接时退出等待队列。 */
  cancel(owner: string): void {
    this.waiters = this.waiters.filter((current) => current !== owner);
  }

  /** 额度归属变化时通知订阅者重新判定（hook 由此决定是否建连接）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isHolding(owner: string): boolean {
    return this.owners.has(owner);
  }

  isWaiting(owner: string): boolean {
    return this.waiters.includes(owner);
  }

  private promote(): void {
    while (this.owners.size < this.limit && this.waiters.length > 0) {
      this.owners.add(this.waiters.shift()!);
    }
    for (const listener of [...this.listeners]) listener();
  }
}

let watchOwnerSequence = 0;

/** 每个 hook 实例一个 owner token，连接生命周期与额度所有权一一对应。 */
function nextWatchOwner(): string {
  watchOwnerSequence += 1;
  return `file-watch-${watchOwnerSequence}`;
}

export const fileWatchBudget = new FileWatchBudget(FILE_WATCH_BUDGET);

/**
 * 是否应该持有 watch 连接：调用方允许、页面可见、且拿到额度。
 * 后台标签页不该占着连接额度，回到前台会重新建立连接并重新读一次文件。
 */
export function shouldHoldFileWatch(input: { enabled: boolean; hidden: boolean; acquired: boolean }): boolean {
  return input.enabled && !input.hidden && input.acquired;
}

export interface FileWatchOptions {
  filePath: string;
  sourceSessionId?: string | null;
  /** 调用方是否允许监听（预览类型不支持时为 false）。 */
  enabled?: boolean;
  /** 连接建立或文件发生变更后触发，供预览清理自己的元数据（尺寸/时长等）。 */
  onReset?: () => void;
  /** 对新尺寸的额外校验，返回错误文本表示该文件不可预览。 */
  validateSize?: (size: number) => string | null;
}

export interface FileWatchState {
  watching: boolean;
  /** 每次文件版本变化递增，供预览 URL 加缓存穿透参数。 */
  bust: number;
  size: number | null;
  error: string | null;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 文件 watch 的唯一实现：EventSource 生命周期、meta 同步、连接额度与可见性门控。
 * 预览组件只提供自己的元数据回调，不要各自再写一份连接逻辑。
 */
export function useFileWatch({
  filePath,
  sourceSessionId,
  enabled = true,
  onReset,
  validateSize,
}: FileWatchOptions): FileWatchState {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => !documentHidden());
  const ownerRef = useRef<string | null>(null);
  if (ownerRef.current === null) ownerRef.current = nextWatchOwner();
  // 额度持有状态：只在本实例的 isHolding 结果变化时才更新，避免其他实例释放额度
  // 时把已持有连接的预览也推进一次重建（连接与额度通知不能互相驱动）。
  const [granted, setGranted] = useState(false);
  const syncRequestRef = useRef(0);
  const onResetRef = useRef(onReset);
  const validateSizeRef = useRef(validateSize);
  onResetRef.current = onReset;
  validateSizeRef.current = validateSize;

  useEffect(() => {
    const onVisibilityChange = () => setVisible(!documentHidden());
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // 尺寸落库 + 校验是同一条规则，meta 读取与实时事件都必须走它。
  const applySizeRef = useRef<(next: number) => boolean>(() => true);
  applySizeRef.current = (next: number) => {
    setSize(next);
    const rejection = validateSizeRef.current?.(next) ?? null;
    if (rejection) {
      setError(rejection);
      return false;
    }
    setError(null);
    return true;
  };

  useEffect(() => {
    // 换文件或换来源会话：清掉上一位文件的预览元数据，别让新文件先显示旧尺寸/旧错误。
    syncRequestRef.current += 1;
    setWatching(false);
    setBust(0);
    setSize(null);
    setError(null);
    onResetRef.current?.();
  }, [filePath, sourceSessionId]);

  // 额度申请与等待：本实例退出（卸载/隐藏/禁用）时在 cleanup 里归还名额。
  useEffect(() => {
    const owner = ownerRef.current!;
    if (!enabled || visible === false) {
      fileWatchBudget.cancel(owner);
      setGranted(false);
      return;
    }
    setGranted(fileWatchBudget.request(owner));
    // 额度释放时只在本实例的持有状态真变了才更新，其他持有者不受影响。
    const unsubscribe = fileWatchBudget.subscribe(() => {
      setGranted((current) => {
        const holding = fileWatchBudget.isHolding(owner);
        return current === holding ? current : holding;
      });
    });
    return () => {
      unsubscribe();
      // 归还名额（排队中则退出队列）：连接生命周期只负责关连接，不驱动额度。
      fileWatchBudget.release(owner);
    };
  }, [enabled, visible]);

  // 读 meta（尺寸 + 校验）只跟文件身份有关：禁用监听、后台页或排队等待额度时
  // 也要有尺寸与错误提示；连接预算只控制“持续监听”这件事。
  const syncMeta = useCallback(() => {
    const requestId = ++syncRequestRef.current;
    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((response) => response.json())
      .then((next: { size?: number; error?: string }) => {
        if (requestId !== syncRequestRef.current) return;
        if (next.error) {
          setError(next.error);
          return;
        }
        if (typeof next.size === "number" && !applySizeRef.current(next.size)) return;
        onResetRef.current?.();
        setBust((value) => value + 1);
      })
      .catch((nextError) => {
        if (requestId === syncRequestRef.current) setError(String(nextError));
      });
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    syncMeta();
  }, [syncMeta]);

  useEffect(() => {
    if (!granted || !enabled || visible === false) return;
    const es = createStreamSource(getFileApiUrl(filePath, "watch", sourceSessionId), 1);
    es.addEventListener("connected", () => {
      setWatching(true);
      // 服务端在 watcher 就绪后才发 connected：这里补读一次，闭合快照与实时事件之间的空档。
      syncMeta();
    });
    es.addEventListener("change", (event) => {
      syncRequestRef.current += 1;
      onResetRef.current?.();
      try {
        const data = JSON.parse((event as MessageEvent).data) as { size?: number };
        if (typeof data.size === "number" && !applySizeRef.current(data.size)) return;
      } catch {
        // 负载不可解析不影响刷新：版本号仍然递增，预览会重新读取文件。
      }
      setError(null);
      setBust((value) => value + 1);
    });
    const markDisconnected = () => setWatching(false);
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      syncRequestRef.current += 1;
      es.close();
      setWatching(false);
    };
  }, [granted, enabled, visible, filePath, sourceSessionId, syncMeta]);

  return { watching, bust, size, error };
}
