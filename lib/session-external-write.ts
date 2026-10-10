/**
 * “会话文件正在/已被外部修改”的统一契约。
 *
 * 服务端在 wrapper 与磁盘内容不一致时返回 409；这既可能是外部进程真的在写（pi TUI），
 * 也可能是一次很快结束的写入竞争。客户端必须能区分它和内容错误，才能重试并保留已有视图，
 * 而不是把整个聊天区替换成错误页。
 */

export const SESSION_EXTERNAL_WRITE_CODE = "session_external_write";

export interface SessionExternalWritePayload {
  error: string;
  code: string;
}

/** 统一构造新鲜度冲突的 409 响应体。 */
export function sessionExternalWritePayload(message: string): SessionExternalWritePayload {
  return { error: message, code: SESSION_EXTERNAL_WRITE_CODE };
}

/** 服务端 409 响应体是否表示可重试的外部写入冲突。 */
export function isSessionExternalWritePayload(payload: unknown): boolean {
  return typeof payload === "object"
    && payload !== null
    && (payload as { code?: unknown }).code === SESSION_EXTERNAL_WRITE_CODE;
}

/**
 * 客户端可恢复错误：会话文件正在被写入，稍后重试即可。
 * 用结构判定而不是 instanceof，避免热更新后跨模块实例导致识别失效。
 */
export class SessionExternalWriteError extends Error {
  readonly code = SESSION_EXTERNAL_WRITE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionExternalWriteError";
  }
}

export function isSessionExternalWriteError(value: unknown): value is SessionExternalWriteError {
  return value instanceof Error && (value as { code?: unknown }).code === SESSION_EXTERNAL_WRITE_CODE;
}
