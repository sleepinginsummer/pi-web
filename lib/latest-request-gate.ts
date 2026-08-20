/** 按资源键分配单调请求序号，只允许同一资源的最新请求提交结果。 */
export class LatestRequestGate {
  private readonly generations = new Map<string, number>();
  private sequence = 0;
  private readonly inFlight = new Map<string, number>();

  begin(key: string): number {
    const generation = this.sequence + 1;
    this.sequence = generation;
    this.generations.set(key, generation);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    return generation;
  }

  invalidate(key: string): void {
    this.sequence += 1;
    this.generations.set(key, this.sequence);
    if (!this.inFlight.has(key)) this.generations.delete(key);
  }

  isLatest(key: string, generation: number): boolean {
    return this.generations.get(key) === generation;
  }

  finish(key: string): void {
    const remaining = (this.inFlight.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.inFlight.set(key, remaining);
      return;
    }
    this.inFlight.delete(key);
    this.generations.delete(key);
  }
}
