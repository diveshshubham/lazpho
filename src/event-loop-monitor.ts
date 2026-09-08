import { monitorEventLoopDelay } from 'node:perf_hooks';

export class EventLoopMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay> | null;

  public constructor(resolutionMs: number) {
    try {
      this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
      this.histogram.enable();
    } catch {
      this.histogram = null;
    }
  }

  public getLagMs(): number {
    try {
      if (!this.histogram || !Number.isFinite(this.histogram.mean)) return 0;
      const lagMs = this.histogram.mean / 1_000_000;
      this.histogram.reset();
      return lagMs;
    } catch {
      return 0;
    }
  }

  public close(): void {
    try { this.histogram?.disable(); } catch { }
  }
}
