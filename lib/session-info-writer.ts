/**
 * session_info（会话标题）写入边界。
 *
 * 标题由文件级流程生成（自动命名、手动重新生成、批量补齐、回收站），写入方式有两种：
 *
 * - 存活 wrapper：用 wrapper 自己的 SessionManager 追加。SDK 会把 entry 同时写进内存和文件，
 *   内存与磁盘保持一致，pi-web 自己的写入不会被 lib/session-disk-freshness.ts 判成外部修改。
 *   文件级独立 SessionManager 写入会造成内存少一条记录，运行中的会话随后持续 409。
 * - 无存活 wrapper：照旧用文件级 SessionManager 追加。
 *
 * wrapper 只能在 rpc-manager 中解析（session-file-title → rpc-manager 会形成循环导入），
 * 因此由 rpc-manager 在模块加载时注册写入器。注册结果放在 globalThis 上以跨 HMR 存活。
 * 不需要额外的加载顺序保证：wrapper 只可能由 rpc-manager 创建，注册缺失时注册表必然为空，
 * 此时也没有存活 wrapper 需要同步，回退文件级写入就是正确行为。
 */

export type LiveSessionInfoWriteResult = "written" | "stale" | "no-live-session";

export interface LiveSessionInfoWriteOptions {
  /**
   * 写入前必须匹配的现有名称。undefined 表示不校验（显式重命名总是生效）；
   * null 表示要求当前没有名称；字符串表示必须等于该名称。
   */
  requireName?: string | null;
  /**
   * 只接受属于该会话的存活 wrapper。按路径匹配到的 wrapper 若不属于这个会话
   * （路径缓存过期）就不能算命中，避免写到别的会话的内存里。
   */
  sessionId?: string;
}

export type LiveSessionInfoWriter = (
  filePath: string,
  name: string,
  options: LiveSessionInfoWriteOptions,
) => LiveSessionInfoWriteResult;

const state = globalThis as typeof globalThis & {
  __piLiveSessionInfoWriter?: LiveSessionInfoWriter;
};

/** 由 rpc-manager 注册存活 wrapper 写入器。 */
export function registerLiveSessionInfoWriter(writer: LiveSessionInfoWriter): void {
  state.__piLiveSessionInfoWriter = writer;
}

/**
 * 优先通过存活 wrapper 写入 session_info。
 *
 * @returns written=已通过存活 wrapper 写入；stale=有存活 wrapper 但它与磁盘不一致（外部写入）或名称基线
 *          不匹配，调用方对自动命名必须放弃、不能退回文件级写入；no-live-session=没有匹配的存活
 *          wrapper，调用方用文件级 SessionManager 写入。
 */
export function writeSessionInfoThroughLiveSession(
  filePath: string,
  name: string,
  options: LiveSessionInfoWriteOptions = {},
): LiveSessionInfoWriteResult {
  return state.__piLiveSessionInfoWriter?.(filePath, name, options) ?? "no-live-session";
}
