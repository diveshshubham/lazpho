import type { AdaptiveBackpressureSnapshot, BulkheadMetrics, CircuitBreakerMetrics, ClosedLoopAdaptiveConcurrencyController, ConcurrencyController, ConcurrencyTimingMetrics, LifecycleState } from './types.js';

export interface LazphoMetricSnapshot {
  readonly controller: string;
  readonly lifecycle: LifecycleState;
  readonly concurrency: Readonly<{
    active: number;
    queued: number;
    currentLimit: number;
    maxQueueSize: number;
  }>;
  readonly totals: Readonly<{
    accepted: number;
    completed: number;
    failed: number;
    cancelled: number;
    timedOut: number;
    rejected: number;
    queueRejected: number;
    bulkheadRejected: number;
    retriesAttempted: number;
    retrySuccesses: number;
    retryExhausted: number;
  }>;
  readonly latency: Readonly<{
    queueWait: Readonly<ConcurrencyTimingMetrics>;
    execution: Readonly<ConcurrencyTimingMetrics>;
    total: Readonly<ConcurrencyTimingMetrics>;
  }>;
  readonly breaker?: Readonly<CircuitBreakerMetrics>;
  readonly bulkheads: Readonly<Record<string, Readonly<BulkheadMetrics>>>;
  readonly adaptive?: Readonly<{
    currentLimit: number;
    minLimit: number;
    maxLimit: number;
    targetP95Ms: number;
    latencyEwmaMs: number | null;
    errorRate: number | null;
  }>;
}

export type MetricsCollector = () => LazphoMetricSnapshot;

export interface MetricsExporterOptions {
  export(snapshot: LazphoMetricSnapshot): void;
  onError?(error: unknown): void;
  adaptive?: ClosedLoopAdaptiveConcurrencyController;
}

export interface MetricsExporter {
  /** Collect and push once. Returns false after disposal or when the callback fails. */
  export(): boolean;
  dispose(): void;
}

export function createMetricsCollector(
  controller: ConcurrencyController,
  adaptive?: ClosedLoopAdaptiveConcurrencyController
): MetricsCollector {
  return () => {
    const metrics = controller.stats();
    const adaptiveSnapshot = safeAdaptiveSnapshot(adaptive);
    const bulkheads = Object.create(null) as Record<string, Readonly<BulkheadMetrics>>;
    for (const [name, bulkhead] of Object.entries(metrics.bulkheads)) bulkheads[name] = Object.freeze({ ...bulkhead });
    return Object.freeze({
      controller: metrics.name,
      lifecycle: controller.lifecycle(),
      concurrency: Object.freeze({ active: metrics.active, queued: metrics.queued, currentLimit: metrics.limit, maxQueueSize: metrics.maxQueueSize }),
      totals: Object.freeze({
        accepted: metrics.accepted,
        completed: metrics.completed,
        failed: metrics.failed,
        cancelled: metrics.cancelled,
        timedOut: metrics.timedOut,
        rejected: metrics.rejected,
        queueRejected: metrics.rejectedQueueFull,
        bulkheadRejected: metrics.bulkheadRejected,
        retriesAttempted: metrics.retriesAttempted,
        retrySuccesses: metrics.retrySuccesses,
        retryExhausted: metrics.retryExhausted
      }),
      latency: Object.freeze({
        queueWait: Object.freeze({ ...metrics.queueWait }),
        execution: Object.freeze({ ...metrics.execution }),
        total: Object.freeze({ ...metrics.total })
      }),
      breaker: metrics.circuitBreaker && Object.freeze({ ...metrics.circuitBreaker }),
      bulkheads: Object.freeze(bulkheads),
      adaptive: adaptiveSnapshot && Object.freeze({
        currentLimit: adaptiveSnapshot.currentLimit,
        minLimit: adaptiveSnapshot.controller.minLimit,
        maxLimit: adaptiveSnapshot.controller.maxLimit,
        targetP95Ms: adaptiveSnapshot.controller.targetP95Ms,
        latencyEwmaMs: adaptiveSnapshot.latencyEwmaMs,
        errorRate: adaptiveSnapshot.errorRate
      })
    });
  };
}

export function createMetricsExporter(controller: ConcurrencyController, options: MetricsExporterOptions): MetricsExporter {
  let collect: MetricsCollector | undefined = createMetricsCollector(controller, options.adaptive);
  let exportCallback: MetricsExporterOptions['export'] | undefined = options.export;
  let errorCallback: MetricsExporterOptions['onError'] | undefined = options.onError;
  return {
    export(): boolean {
      if (!collect || !exportCallback) return false;
      try {
        exportCallback(collect());
        return true;
      } catch (error) {
        try { errorCallback?.(error); } catch { }
        return false;
      }
    },
    dispose(): void {
      collect = undefined;
      exportCallback = undefined;
      errorCallback = undefined;
    }
  };
}

function safeAdaptiveSnapshot(adaptive: ClosedLoopAdaptiveConcurrencyController | undefined): AdaptiveBackpressureSnapshot | undefined {
  if (!adaptive) return undefined;
  return adaptive.snapshot();
}
