import { LatencySamples } from './latency-samples.js';
import { RollingCounter } from './rolling-counter.js';
import type { RequestMetrics } from './types.js';

export class MetricAggregator {
  private totalRequests = 0;
  private activeRequests = 0;
  private errors = 0;
  private totalDurationMs = 0;
  private readonly latency: LatencySamples;
  private readonly throughput: RollingCounter;

  public constructor(latencySampleSize: number, rpsWindowSeconds: number) {
    this.latency = new LatencySamples(latencySampleSize);
    this.throughput = new RollingCounter(rpsWindowSeconds);
  }

  public start(): void {
    this.activeRequests += 1;
  }

  public record(durationMs: number, isError: boolean): void {
    this.totalRequests += 1;
    this.totalDurationMs += durationMs;
    if (isError) this.errors += 1;
    this.latency.add(durationMs);
    this.throughput.increment();
  }

  public finish(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  public snapshot(): RequestMetrics {
    return {
      totalRequests: this.totalRequests,
      activeRequests: this.activeRequests,
      errors: this.errors,
      requestsPerSecond: this.throughput.perSecond(),
      averageDurationMs: this.totalRequests === 0 ? 0 : this.totalDurationMs / this.totalRequests,
      ...this.latency.getPercentiles()
    };
  }

  public reset(): void {
    this.totalRequests = 0;
    this.activeRequests = 0;
    this.errors = 0;
    this.totalDurationMs = 0;
    this.latency.reset();
    this.throughput.reset();
  }
}
