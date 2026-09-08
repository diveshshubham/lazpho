export class RollingCounter {
  private readonly seconds: Float64Array;
  private readonly values: Uint32Array;

  public constructor(private readonly windowSeconds: number) {
    this.seconds = new Float64Array(windowSeconds);
    this.values = new Uint32Array(windowSeconds);
  }

  public increment(nowMs = Date.now()): void {
    const second = Math.floor(nowMs / 1_000);
    const index = second % this.windowSeconds;
    if (this.seconds[index] !== second) {
      this.seconds[index] = second;
      this.values[index] = 0;
    }
    this.values[index] += 1;
  }

  public perSecond(nowMs = Date.now()): number {
    const currentSecond = Math.floor(nowMs / 1_000);
    let total = 0;
    for (let index = 0; index < this.windowSeconds; index += 1) {
      if (currentSecond - this.seconds[index] < this.windowSeconds) total += this.values[index];
    }
    return total / this.windowSeconds;
  }

  public reset(): void {
    this.seconds.fill(0);
    this.values.fill(0);
  }
}
