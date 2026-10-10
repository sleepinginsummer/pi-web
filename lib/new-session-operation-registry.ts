/**
 * 新建会话的创建幂等表。
 *
 * 客户端为一次创建意图生成稳定的 operationId 并随 create 请求发送：
 * 服务端已经建好 runtime、但响应因超时或断连丢失时，重试会带同一个 id，
 * 必须拿回同一个 runtime，而不是再建一个孤儿会话。
 *
 * 注册表同时拥有"在途创建"：并发或重试请求共享同一个 Promise，
 * 因此两次请求只会有一个 factory 真正执行。
 *
 * 注册表放 globalThis 以跨 HMR 存活：它记录的是运行中 wrapper 的身份，
 * 进程重启后 wrapper 一起消失，条目自然作废（get 时由调用方校验存活）。
 */
const DEFAULT_OPERATION_LIMIT = 200;

export class NewSessionOperationRegistry {
  /**
   * @param operations 跨代际共享的纯数据表；HMR 后传入同一份 Map
   * @param limit 表上限
   */
  constructor(
    private readonly operations: Map<string, OperationEntry> = new Map(),
    private readonly limit: number = DEFAULT_OPERATION_LIMIT,
  ) {}

  get size(): number {
    return this.operations.size;
  }

  /** 已交付且仍可复用的身份；调用方负责校验 wrapper 是否存活。 */
  peekDelivered(operationId: string, cwd: string): string | undefined {
    const entry = this.operations.get(operationId);
    return entry && entry.cwd === cwd ? entry.delivered : undefined;
  }

  /**
   * 原子取得或创建：同一 operationId 的并发/重试请求共享一次 factory 调用，
   * 因此响应丢失后重试不会建出第二个 runtime。
   * cwd 不一致说明是另一个意图，直接拒绝复用。
   */
  getOrCreate(operationId: string, cwd: string, create: () => Promise<string>): Promise<string> {
    const existing = this.operations.get(operationId);
    if (existing) {
      if (existing.cwd !== cwd) {
        return Promise.reject(new Error("创建意图的 cwd 不匹配，拒绝复用已交付的 runtime"));
      }
      return existing.promise;
    }

    // 先同步登记在途 Promise，再执行 factory：并发请求只会有一个创建者。
    const entry: OperationEntry = { cwd, delivered: undefined, promise: Promise.resolve("") };
    entry.promise = create().then(
      (sessionId) => {
        entry.delivered = sessionId;
        this.touch(operationId);
        return sessionId;
      },
      (error: unknown) => {
        // 失败按身份清理：下一次重试可以重新创建。
        this.forget(operationId);
        throw error;
      },
    );
    this.operations.set(operationId, entry);
    this.evictOldest();
    return entry.promise;
  }

  /**
   * 交付结果已不可用时清除条目（存活判定由调用方注入）。
   * 不做这一步，创建响应丢失、runtime 又被回收后重试会拿回死掉的身份。
   */
  forgetIfUnusable(operationId: string, cwd: string, usable: (sessionId: string) => boolean): void {
    const entry = this.operations.get(operationId);
    if (!entry || entry.cwd !== cwd || entry.delivered === undefined) return;
    if (!usable(entry.delivered)) this.operations.delete(operationId);
  }

  forget(operationId: string): void {
    this.operations.delete(operationId);
  }

  private touch(operationId: string): void {
    const entry = this.operations.get(operationId);
    if (!entry) return;
    this.operations.delete(operationId);
    this.operations.set(operationId, entry);
  }

  private evictOldest(): void {
    while (this.operations.size > this.limit) {
      const oldest = this.operations.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.operations.get(oldest);
      // 在途创建不能淘汰：淘汰后重试会再建一个 runtime。
      if (entry && entry.delivered === undefined) {
        const alive = [...this.operations.keys()].find((key) => this.operations.get(key)?.delivered !== undefined);
        if (alive === undefined) break;
        this.operations.delete(alive);
        continue;
      }
      this.operations.delete(oldest);
    }
  }
}

type OperationEntry = {
  cwd: string;
  /** 已交付的 runtime 身份；undefined 表示创建仍在途。 */
  delivered: string | undefined;
  promise: Promise<string>;
};

declare global {
  var __piNewSessionOperationsData: Map<string, OperationEntry> | undefined;
}

/**
 * 每次模块加载都用当前实现包装共享数据表：只把纯 Map（含在途 Promise）放 globalThis，
 * 不能把类实例放上去——HMR 后旧实例会把旧方法继续带下去，
 * 本轮对幂等逻辑的修复在已运行的 dev 进程里就等于没生效
 * （与 lib/session-title-task-coordinator.ts 的约定一致）。
 */
export function getNewSessionOperationRegistry(): NewSessionOperationRegistry {
  const data = globalThis.__piNewSessionOperationsData
    ?? (globalThis.__piNewSessionOperationsData = new Map());
  return new NewSessionOperationRegistry(data);
}
