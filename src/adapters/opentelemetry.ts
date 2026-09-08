import { createMetricsCollector } from '../observability.js';
import type { LazphoMetricSnapshot, MetricsCollector } from '../observability.js';
import type { ClosedLoopAdaptiveConcurrencyController, ConcurrencyController, LifecycleState, CircuitBreakerState } from '../types.js';

export type OtelAttributes = Readonly<Record<string, string | number | boolean>>;

export interface OtelObservableInstrument { }

export interface OtelBatchObservableResult {
  observe(instrument: OtelObservableInstrument, value: number, attributes?: OtelAttributes): void;
}

export type OtelBatchObservableCallback = (result: OtelBatchObservableResult) => void;

export interface OtelMeter {
  createObservableGauge(name: string, options?: { description?: string; unit?: string }): OtelObservableInstrument;
  createObservableCounter(name: string, options?: { description?: string; unit?: string }): OtelObservableInstrument;
  addBatchObservableCallback(callback: OtelBatchObservableCallback, instruments: OtelObservableInstrument[]): void;
  removeBatchObservableCallback(callback: OtelBatchObservableCallback, instruments: OtelObservableInstrument[]): void;
}

export interface LazphoOpenTelemetryOptions {
  controller: ConcurrencyController;
  meter: OtelMeter;
  adaptive?: ClosedLoopAdaptiveConcurrencyController;
  attributes?: OtelAttributes;
  onError?(error: unknown): void;
}

export interface LazphoOpenTelemetryInstrumentation {
  collect(): LazphoMetricSnapshot;
  dispose(): void;
}

export const LAZPHO_OTEL_METRIC_NAMES = Object.freeze({
  active: 'lazpho.controller.active',
  queued: 'lazpho.controller.queued',
  limit: 'lazpho.controller.limit',
  lifecycle: 'lazpho.controller.lifecycle',
  completed: 'lazpho.operations.completed',
  failed: 'lazpho.operations.failed',
  cancelled: 'lazpho.operations.cancelled',
  timedOut: 'lazpho.operations.timed_out',
  rejected: 'lazpho.operations.rejected',
  queueRejected: 'lazpho.operations.queue_rejected',
  bulkheadRejected: 'lazpho.operations.bulkhead_rejected',
  retryAttempted: 'lazpho.retry.attempted',
  retrySucceeded: 'lazpho.retry.succeeded',
  retryExhausted: 'lazpho.retry.exhausted',
  breakerState: 'lazpho.breaker.state',
  breakerTrips: 'lazpho.breaker.trips',
  breakerRejected: 'lazpho.breaker.rejections',
  breakerRecoveries: 'lazpho.breaker.recoveries',
  halfOpenAttempts: 'lazpho.breaker.half_open_attempts',
  bulkheadActive: 'lazpho.bulkhead.active',
  bulkheadQueued: 'lazpho.bulkhead.queued',
  bulkheadMaxConcurrent: 'lazpho.bulkhead.max_concurrent',
  bulkheadMaxQueue: 'lazpho.bulkhead.max_queue',
  bulkheadRejections: 'lazpho.bulkhead.rejections',
  adaptiveLatencyEwma: 'lazpho.adaptive.latency_ewma',
  adaptiveErrorRate: 'lazpho.adaptive.error_rate',
  adaptiveTargetLatency: 'lazpho.adaptive.target_latency'
} as const);

export function createLazphoOpenTelemetry(options: LazphoOpenTelemetryOptions): LazphoOpenTelemetryInstrumentation {
  const { controller, meter, adaptive, attributes: configuredAttributes } = options;
  let errorCallback: LazphoOpenTelemetryOptions['onError'] | undefined = options.onError;
  const gauges = {
    active: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.active),
    queued: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.queued),
    limit: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.limit),
    lifecycle: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.lifecycle),
    breakerState: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.breakerState),
    bulkheadActive: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.bulkheadActive),
    bulkheadQueued: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.bulkheadQueued),
    bulkheadMaxConcurrent: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.bulkheadMaxConcurrent),
    bulkheadMaxQueue: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.bulkheadMaxQueue),
    adaptiveLatencyEwma: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.adaptiveLatencyEwma, { unit: 'ms' }),
    adaptiveErrorRate: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.adaptiveErrorRate),
    adaptiveTargetLatency: meter.createObservableGauge(LAZPHO_OTEL_METRIC_NAMES.adaptiveTargetLatency, { unit: 'ms' })
  };
  const counters = {
    completed: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.completed),
    failed: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.failed),
    cancelled: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.cancelled),
    timedOut: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.timedOut),
    rejected: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.rejected),
    queueRejected: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.queueRejected),
    bulkheadRejected: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.bulkheadRejected),
    retryAttempted: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.retryAttempted),
    retrySucceeded: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.retrySucceeded),
    retryExhausted: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.retryExhausted),
    breakerTrips: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.breakerTrips),
    breakerRejected: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.breakerRejected),
    breakerRecoveries: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.breakerRecoveries),
    halfOpenAttempts: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.halfOpenAttempts),
    bulkheadRejections: meter.createObservableCounter(LAZPHO_OTEL_METRIC_NAMES.bulkheadRejections)
  };
  const instruments = [...Object.values(gauges), ...Object.values(counters)];
  let collect: MetricsCollector | undefined = createMetricsCollector(controller, adaptive);
  const first = collect();
  const attributes = Object.freeze({ ...configuredAttributes, controller: first.controller });
  const callback: OtelBatchObservableCallback = (result) => {
    if (!collect) return;
    try { observe(result, collect(), attributes, gauges, counters); }
    catch (error) { try { errorCallback?.(error); } catch { } }
  };
  meter.addBatchObservableCallback(callback, instruments);
  let disposed = false;
  return {
    collect(): LazphoMetricSnapshot {
      if (!collect) throw new Error('Lazpho OpenTelemetry instrumentation is disposed.');
      return collect();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      meter.removeBatchObservableCallback(callback, instruments);
      collect = undefined;
      errorCallback = undefined;
    }
  };
}

function observe(
  result: OtelBatchObservableResult,
  snapshot: LazphoMetricSnapshot,
  attributes: OtelAttributes,
  gauges: Record<string, OtelObservableInstrument>,
  counters: Record<string, OtelObservableInstrument>
): void {
  result.observe(gauges.active, snapshot.concurrency.active, attributes);
  result.observe(gauges.queued, snapshot.concurrency.queued, attributes);
  result.observe(gauges.limit, snapshot.concurrency.currentLimit, attributes);
  result.observe(gauges.lifecycle, lifecycleValue(snapshot.lifecycle), attributes);
  for (const [name, bulkhead] of Object.entries(snapshot.bulkheads)) {
    const bulkheadAttributes = { ...attributes, bulkhead: name };
    result.observe(gauges.bulkheadActive, bulkhead.active, bulkheadAttributes);
    result.observe(gauges.bulkheadQueued, bulkhead.queued, bulkheadAttributes);
    result.observe(gauges.bulkheadMaxConcurrent, bulkhead.maxConcurrent, bulkheadAttributes);
    result.observe(gauges.bulkheadMaxQueue, bulkhead.maxQueue, bulkheadAttributes);
    result.observe(counters.bulkheadRejections, bulkhead.rejected, bulkheadAttributes);
  }
  result.observe(counters.completed, snapshot.totals.completed, attributes);
  result.observe(counters.failed, snapshot.totals.failed, attributes);
  result.observe(counters.cancelled, snapshot.totals.cancelled, attributes);
  result.observe(counters.timedOut, snapshot.totals.timedOut, attributes);
  result.observe(counters.rejected, snapshot.totals.rejected, attributes);
  result.observe(counters.queueRejected, snapshot.totals.queueRejected, attributes);
  result.observe(counters.bulkheadRejected, snapshot.totals.bulkheadRejected, attributes);
  result.observe(counters.retryAttempted, snapshot.totals.retriesAttempted, attributes);
  result.observe(counters.retrySucceeded, snapshot.totals.retrySuccesses, attributes);
  result.observe(counters.retryExhausted, snapshot.totals.retryExhausted, attributes);
  if (snapshot.breaker) {
    result.observe(gauges.breakerState, breakerValue(snapshot.breaker.state), attributes);
    result.observe(counters.breakerTrips, snapshot.breaker.breakerTrips, attributes);
    result.observe(counters.breakerRejected, snapshot.breaker.breakerRejected, attributes);
    result.observe(counters.breakerRecoveries, snapshot.breaker.breakerRecoveries, attributes);
    result.observe(counters.halfOpenAttempts, snapshot.breaker.halfOpenAttempts, attributes);
  }
  if (snapshot.adaptive) {
    if (snapshot.adaptive.latencyEwmaMs !== null) result.observe(gauges.adaptiveLatencyEwma, snapshot.adaptive.latencyEwmaMs, attributes);
    if (snapshot.adaptive.errorRate !== null) result.observe(gauges.adaptiveErrorRate, snapshot.adaptive.errorRate, attributes);
    result.observe(gauges.adaptiveTargetLatency, snapshot.adaptive.targetP95Ms, attributes);
  }
}

export function lifecycleValue(state: LifecycleState): number { return state === 'running' ? 0 : state === 'draining' ? 1 : 2; }
export function breakerValue(state: CircuitBreakerState): number { return state === 'closed' ? 0 : state === 'open' ? 1 : 2; }
