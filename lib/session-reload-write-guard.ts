type AppendMethod = (this: unknown, ...args: unknown[]) => unknown;

type GuardedMethod = {
  name: string;
  descriptor: PropertyDescriptor | undefined;
  guarded: AppendMethod;
};

/** ctx.compact 不随重载一起结束；压缩提交检查须保留到 manager 生命周期结束。 */
export function installSessionCompactionWriteGuard(manager: object, assertWritable: () => void): void {
  const target = manager as Record<string, unknown>;
  const original = target.appendCompaction;
  if (typeof original !== "function") return;
  const descriptor = Object.getOwnPropertyDescriptor(manager, "appendCompaction");
  Object.defineProperty(manager, "appendCompaction", {
    configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      // 此处抛错沿 SDK compact 的失败路径进入 ctx.compact 的 onError，不写入旧叶节点。
      assertWritable();
      return (original as AppendMethod).apply(this, args);
    },
  });
}

/**
 * 重载的 shutdown/start 钩子会跨越异步资源加载，入口检查不能保护稍后的 SDK 写入。
 * 临时守住会话自有 manager 的公开 append* 入口，在创建/追加 entry 前同步检查；
 * 保留既有持久化快照包装，不依赖 SDK 私有 _appendEntry。调用方必须串行执行重载。
 */
export async function withSessionReloadWriteGuard<T>(
  manager: object,
  assertWritable: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const target = manager as Record<string, unknown>;
  const names = new Set<string>();
  for (let source: object | null = manager; source && source !== Object.prototype; source = Object.getPrototypeOf(source)) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name.startsWith("append") && typeof target[name] === "function") names.add(name);
    }
  }
  const methods: GuardedMethod[] = [];
  let active = true;
  let blocked = false;
  let conflict: unknown;
  try {
    for (const name of names) {
      const original = target[name] as AppendMethod;
      const descriptor = Object.getOwnPropertyDescriptor(manager, name);
      const guarded: AppendMethod = function (...args) {
        if (active) {
          if (blocked) throw conflict;
          try {
            assertWritable();
          } catch (error) {
            blocked = true;
            conflict = error;
            throw error;
          }
        }
        return original.apply(this, args);
      };
      Object.defineProperty(manager, name, { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: guarded });
      methods.push({ name, descriptor, guarded });
    }
    const result = await operation();
    // SDK ExtensionRunner 会捕获钩子异常并继续；不能因此把磁盘冲突报告成重载成功。
    if (blocked) throw conflict;
    return result;
  } catch (error) {
    throw blocked ? conflict : error;
  } finally {
    active = false;
    for (const { name, descriptor, guarded } of methods.reverse()) {
      if (target[name] !== guarded) continue;
      if (descriptor) Object.defineProperty(manager, name, descriptor);
      else Reflect.deleteProperty(manager, name);
    }
  }
}
