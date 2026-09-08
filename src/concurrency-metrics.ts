import { LatencySamples } from './latency-samples.js';
import type { ConcurrencyMetrics, ConcurrencyTimingMetrics } from './types.js';

export class ConcurrencyMetricAggregator {
  private active = 0;
  private queued = 0;
  private completed = 0;
  private failed = 0;
  private cancelledCount = 0;
  private timedOutCount = 0;
  private executionTimedOutCount = 0;
  private rejectedCount = 0;
  private accepted = 0;
  private rejectedQueueFullCount = 0;
  private bulkheadRejectedCount = 0;
  private queueTimedOutCount = 0;
  private abortedWhileQueuedCount = 0;
  private retriesAttemptedCount = 0;
  private retrySuccessesCount = 0;
  private retryExhaustedCount = 0;
  private queueWaitTotalMs = 0;
  private executionTotalMs = 0;
  private totalTotalMs = 0;
  private readonly queueWaitSamples: LatencySamples;
  private readonly executionSamples: LatencySamples;
  private readonly totalSamples: LatencySamples;

  public constructor(private readonly name: string, sampleSize: number) {
    this.queueWaitSamples = new LatencySamples(sampleSize);
    this.executionSamples = new LatencySamples(sampleSize);
    this.totalSamples = new LatencySamples(sampleSize);
  }

  public started(queueWaitMs: number, isRetry: boolean, wasQueued = false): void {
    this.active += 1;
    if (wasQueued) this.queued = Math.max(0, this.queued - 1);
    this.queueWaitTotalMs += queueWaitMs;
    this.queueWaitSamples.add(queueWaitMs);
    if (isRetry) this.retriesAttemptedCount += 1;
  }

  public enqueued(): void {
    this.queued += 1;
  }

  public acceptedOperation(): void {
    this.accepted += 1;
  }

  public queueFull(): void {
    this.rejectedCount += 1;
    this.rejectedQueueFullCount += 1;
  }

  public bulkheadFull(): void {
    this.rejectedCount += 1;
    this.bulkheadRejectedCount += 1;
  }

  public timedOut(): void {
    this.rejectedCount += 1;
    this.queueTimedOutCount += 1;
    this.timedOutCount += 1;
    this.queued = Math.max(0, this.queued - 1);
  }

  public abortedWhileQueued(): void {
    this.rejectedCount += 1;
    this.abortedWhileQueuedCount += 1;
    this.cancelledCount += 1;
    this.queued = Math.max(0, this.queued - 1);
  }

  public cancelled(): void {
    this.cancelledCount += 1;
  }

  public executionTimedOut(): void {
    this.executionTimedOutCount += 1;
    this.timedOutCount += 1;
  }

  public rejected(wasQueued = false): void {
    this.rejectedCount += 1;
    if (wasQueued) this.queued = Math.max(0, this.queued - 1);
  }

  public retrySucceeded(): void {
    this.retrySuccessesCount += 1;
  }

  public retryExhausted(): void {
    this.retryExhaustedCount += 1;
  }

  public finished(executionMs: number, totalMs: number, failed: boolean): void {
    this.active = Math.max(0, this.active - 1);
    this.completed += 1;
    if (failed) this.failed += 1;
    this.executionTotalMs += executionMs;
    this.totalTotalMs += totalMs;
    this.executionSamples.add(executionMs);
    this.totalSamples.add(totalMs);
  }

  public snapshot(limit: number, maxQueueSize: number, bulkheads: ConcurrencyMetrics['bulkheads'] = {}): ConcurrencyMetrics {
    const total = this.accepted + this.rejectedCount;
    return {
      name: this.name,
      limit,
      active: this.active,
      queued: this.queued,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelledCount,
      timedOut: this.timedOutCount,
      rejected: this.rejectedCount,
      accepted: this.accepted,
      maxQueueSize,
      rejectedQueueFull: this.rejectedQueueFullCount,
      bulkheadRejected: this.bulkheadRejectedCount,
      queueTimedOut: this.queueTimedOutCount,
      executionTimedOut: this.executionTimedOutCount,
      abortedWhileQueued: this.abortedWhileQueuedCount,
      queueUtilization: maxQueueSize === 0 ? 0 : this.queued / maxQueueSize,
      queueRejectionRate: total === 0 ? 0 : this.rejectedQueueFullCount / total,
      queueTimeoutRate: total === 0 ? 0 : this.queueTimedOutCount / total,
      retriesAttempted: this.retriesAttemptedCount,
      retrySuccesses: this.retrySuccessesCount,
      retryExhausted: this.retryExhaustedCount,
      bulkheads,
      queueWait: timing(this.queueWaitTotalMs, this.completed, this.queueWaitSamples),
      execution: timing(this.executionTotalMs, this.completed, this.executionSamples),
      total: timing(this.totalTotalMs, this.completed, this.totalSamples)
    };
  }
}

function timing(totalMs: number, count: number, samples: LatencySamples): ConcurrencyTimingMetrics {
  return {
    averageMs: count === 0 ? 0 : totalMs / count,
    ...samples.getPercentiles()
  };
}
