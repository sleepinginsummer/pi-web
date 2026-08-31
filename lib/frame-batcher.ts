export type FrameScheduler = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
};

/** 可测试的逐帧队列；flush 保序提交，reset 丢弃当前批次。 */
export class FrameBatcher<T> {
  private queue: T[] = [];
  private frameId: number | null = null;

  constructor(
    private readonly dispatch: (items: T[]) => void,
    private readonly scheduler: FrameScheduler,
  ) {}

  enqueue(item: T): void {
    this.queue.push(item);
    if (this.frameId !== null) return;
    this.frameId = this.scheduler.request(() => {
      this.frameId = null;
      this.dispatchQueuedItems();
    });
  }

  flush(): void {
    if (this.frameId !== null) {
      this.scheduler.cancel(this.frameId);
      this.frameId = null;
    }
    this.dispatchQueuedItems();
  }

  reset(): void {
    if (this.frameId !== null) this.scheduler.cancel(this.frameId);
    this.frameId = null;
    this.queue = [];
  }

  private dispatchQueuedItems(): void {
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.dispatch(items);
  }
}
