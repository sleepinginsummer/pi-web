/** 追踪并发提交中的 prompt；每个 token 只能释放自身，避免乱序完成时提前报告空闲。 */
export class PendingPromptTracker {
  private readonly tokens = new Set<symbol>();

  begin(): symbol {
    const token = Symbol("pending-prompt");
    this.tokens.add(token);
    return token;
  }

  finish(token: symbol): void {
    this.tokens.delete(token);
  }

  get active(): boolean {
    return this.tokens.size > 0;
  }

  get size(): number {
    return this.tokens.size;
  }
}
