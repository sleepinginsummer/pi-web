import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const SUBMIT_GUARD_EXTENSION_NAME = "pi-web-submit-guard";

export type SubmitGuardTicket = {
  /** 派发时的停表值；Stop 之后它与 `AgentSessionWrapper` 记下的值不同。 */
  readonly epoch: number;
  /** Stop 在 pi 接收之前落地：这条提交不该再发。 */
  cancelled: boolean;
  /** `input` 钩子把它拦下了：pi 既没入队，也不会为它开一轮。 */
  swallowed: boolean;
};

/**
 * Stop 与「已派发、pi 还没接收」的提交之间的仲裁。
 *
 * pi 在自己的异步 `input` 钩子（扩展可以在这里改正文、拦下提交）里等扩展，这条消息此刻不在任何
 * 队列：Stop 撤不回它，`clear_queue` 也看不到它。钩子返回时如果回合已经停下，pi 会按「空闲」为它
 * 另起一轮，先把用户消息写进会话记录再调模型——用户按了 Stop，消息却发了，还会和退回输入框的草稿
 * 重复成两条。
 *
 * 内联扩展总排在发现的扩展之后（`DefaultResourceLoader` 把 `extensionFactories` 追加在最后），
 * 所以 `input` 处理里这道守闸是最后一道：它看到的是所有钩子跑完之后的状态，被 Stop 作废的那条提交
 * 在这里拿到 `handled`，pi 于是既不记录也不开回合。
 */
export class SubmitGuard {
  private inFlight: SubmitGuardTicket | null = null;

  /**
   * 一次派发开始。提交锁保证同一时刻只有一条提交在 pi 手里，所以这里只记一条，
   * 不需要按文字匹配队列。
   */
  begin(epoch: number): SubmitGuardTicket {
    const ticket: SubmitGuardTicket = { epoch, cancelled: false, swallowed: false };
    this.inFlight = ticket;
    return ticket;
  }

  /** pi 已经接收或拒绝：此后 Stop 与它无关。 */
  end(ticket: SubmitGuardTicket): void {
    if (this.inFlight === ticket) this.inFlight = null;
  }

  /** Stop：作废仍在 pi 手里的那条提交；返回是否真的作废了一条。 */
  cancelInFlight(): boolean {
    const ticket = this.inFlight;
    if (!ticket || ticket.cancelled) return false;
    ticket.cancelled = true;
    return true;
  }

  /**
   * `input` 钩子的最后一道。凭「谁的提交」而不是正文认人：前面的钩子可以用 `transform` 改写
   * 正文，比对文字会正好漏掉这种提交。提交锁保证同一时刻只有一条 `send()` 派发在 pi 手里，
   * 所以「在途票据 + 来源 rpc」就唯一确定了它——pi 只为这次派发发出一次 `input`。
   */
  guardInput(event: { source?: unknown }): boolean {
    const ticket = this.inFlight;
    if (!ticket || !ticket.cancelled) return false;
    if (event.source !== "rpc") return false;
    ticket.swallowed = true;
    return true;
  }
}

/**
 * 内联扩展：把守闸挂到 pi 的 `input` 事件上。Chat only 和子代理不装它——那里的会话不跑扩展，
 * 也就没有异步 `input` 钩子把提交卡在队列之外。
 */
export function createSubmitGuardExtension(guard: () => SubmitGuard | undefined): InlineExtension {
  return {
    name: SUBMIT_GUARD_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("input", (event) => {
        if (!guard()?.guardInput(event)) return;
        return { action: "handled" as const };
      });
    },
  };
}
