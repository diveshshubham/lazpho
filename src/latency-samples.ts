import type { LatencyMetrics } from './types.js';

export class LatencySamples {
  private readonly samples: Float64Array;
  private count = 0;
  private next = 0;

  public constructor(size: number) {
    this.samples = new Float64Array(size);
  }

  public add(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples[this.next] = durationMs;
    this.next = (this.next + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
  }

  public getPercentiles(): LatencyMetrics {
    if (this.count === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((left, right) => left - right);
    return {
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99)
    };
  }

  public reset(): void {
    this.samples.fill(0);
    this.count = 0;
    this.next = 0;
  }
}

function percentile(sorted: number[], quantile: number): number {
  const position = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, position)];
}
