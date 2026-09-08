export interface RequestRecord {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

export interface LatencyMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface RequestMetrics extends LatencyMetrics {
  totalRequests: number;
  activeRequests: number;
  errors: number;
  requestsPerSecond: number;
  averageDurationMs: number;
}

export interface ResourceMetrics {
  eventLoopLagMs: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
  } | null;
}

export interface MetricsSnapshot extends RequestMetrics {
  resources: ResourceMetrics;
  routes: Record<string, RequestMetrics>;
  controllers: Record<string, ConcurrencyMetrics>;
  adaptiveControllers: Record<string, AdaptiveControlMetrics>;
}

export interface FactoryOptions {
  enabled?: boolean;
  maxRoutes?: number;
  latencySampleSize?: number;
  rpsWindowSeconds?: number;
  eventLoopResolutionMs?: number;
  maxControllers?: number;
  maxAdaptiveControllers?: number;
  routeResolver?: (route: string) => string;
  isError?: (statusCode: number) => boolean;
}

export interface RequestTimer {
  finish(statusCode: number): void;
}

export interface Factory {
  recordRequest(record: RequestRecord): void;
  startRequest(route: string, method: string): RequestTimer;
  getMetrics(): MetricsSnapshot;
  getRouteMetrics(route: string): RequestMetrics | undefined;
  concurrency(options: ConcurrencyOptions): ConcurrencyController;
  getConcurrencyMetrics(name: string): ConcurrencyMetrics | undefined;
  adaptiveConcurrency(options: AdaptiveConcurrencyOptions): ClosedLoopAdaptiveConcurrencyController;
  getAdaptiveConcurrencyState(name: string): AdaptiveControllerState | undefined;
  reset(): void;
  close(): void;
}

export type AdaptiveMode = 'observe' | 'recommend' | 'auto';
export type LifecycleState = 'running' | 'draining' | 'closed';
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';
export type AdaptiveAction = 'increase' | 'decrease' | 'hold';
export type AdaptiveState = 'warmup' | 'probing' | 'stable' | 'backing_off';
export type AdaptiveReason =
  | 'warmup'
  | 'healthy_and_throughput_improving'
  | 'queue_demand_probe'
  | 'latency_above_target'
  | 'error_rate_above_threshold'
  | 'throughput_not_improving'
  | 'at_max_limit'
  | 'at_min_limit'
  | 'insufficient_data'
  | 'queue_pressure_hold'
  | 'queue_rejections_high'
  | 'queue_timeouts_high';

export interface QueuePressureOptions {
  maxUtilization?: number;
  maxQueueWaitP95Ms?: number;
  maxRejectionRate?: number;
  maxTimeoutRate?: number;
}

export interface AdaptiveConcurrencyOptions {
  name?: string;
  minLimit: number;
  maxLimit: number;
  targetP95Ms: number;
  maxErrorRate: number;
  mode?: AdaptiveMode;
  evaluationIntervalMs?: number;
  increaseStep?: number;
  decreaseFactor?: number;
  errorDecreaseFactor?: number;
  ewmaAlpha?: number;
  healthyEvaluations?: number;
  unhealthyEvaluations?: number;
  minThroughputImprovementRatio?: number;
  controller?: ConcurrencyController;
  decisionHistorySize?: number;
  queuePressure?: QueuePressureOptions;
  onMetrics?: (snapshot: AdaptiveBackpressureSnapshot) => void;
  onDecision?: (event: AdaptiveDecisionEvent) => void;
}

export interface AdaptiveRuntimeConfigUpdate {
  minLimit?: number;
  maxLimit?: number;
  targetP95Ms?: number;
}

export interface ConcurrencyObservation {
  timestamp: number;
  currentLimit: number;
  active: number;
  queued: number;
  throughput: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  errorRate: number;
  queueWaitP95Ms?: number;
  queueUtilization?: number;
  queueRejectionRate?: number;
  queueTimeoutRate?: number;
}

export interface AdaptiveSignals {
  smoothedP95Ms: number | null;
  smoothedThroughput: number | null;
  smoothedErrorRate: number | null;
  targetP95Ms: number;
  maxErrorRate: number;
  smoothedQueueUtilization?: number | null;
  smoothedQueueWaitP95Ms?: number | null;
  smoothedQueueRejectionRate?: number | null;
  smoothedQueueTimeoutRate?: number | null;
}

export interface AdaptiveDecision {
  action: AdaptiveAction;
  currentLimit: number;
  proposedLimit: number;
  state: AdaptiveState;
  reason: AdaptiveReason;
  mode: AdaptiveMode;
  willApply: boolean;
  signals: AdaptiveSignals;
}

export interface AdaptiveControllerState {
  name: string;
  state: AdaptiveState;
  mode: AdaptiveMode;
  evaluations: number;
  lastDecision: AdaptiveDecision | undefined;
}

export interface AdaptiveConcurrencyController {
  evaluate(observation: ConcurrencyObservation): AdaptiveDecision;
  state(): AdaptiveControllerState;
}

export interface AdaptiveControlMetrics {
  currentLimit: number | null;
  proposedLimit: number | null;
  limitChanges: number;
  increases: number;
  decreases: number;
  holds: number;
  controllerState: AdaptiveState;
  lastDecision: AdaptiveDecision | undefined;
  timeAtCurrentLimitMs: number;
  history: readonly AdaptiveDecision[];
}

export interface AdaptiveDecisionEvent {
  action: AdaptiveAction;
  reason: AdaptiveReason;
  previousLimit: number;
  nextLimit: number;
  latencyEwmaMs: number | null;
  errorRate: number | null;
  active: number;
  queued: number;
  timestamp: number;
}

export interface AdaptiveBackpressureSnapshot {
  lifecycle: LifecycleState;
  currentLimit: number;
  active: number;
  queued: number;
  totalAccepted: number;
  totalRejected: number;
  totalCompleted: number;
  totalFailed: number;
  latencyEwmaMs: number | null;
  errorRate: number | null;
  lastDecision: AdaptiveDecisionEvent | undefined;
  circuitBreaker?: CircuitBreakerMetrics;
  controller: {
    minLimit: number;
    maxLimit: number;
    targetP95Ms: number;
    mode: AdaptiveMode;
  };
}

export interface ClosedLoopAdaptiveConcurrencyController extends AdaptiveConcurrencyController {
  evaluateFromMetrics(timestamp?: number): AdaptiveDecision;
  stats(): AdaptiveControlMetrics;
  snapshot(): AdaptiveBackpressureSnapshot;
  updateConfig(update: AdaptiveRuntimeConfigUpdate): void;
  close(): Promise<void>;
  lifecycle(): LifecycleState;
}

export interface ConcurrencyOptions {
  name?: string;
  limit: number;
  maxQueueSize?: number;
  latencySampleSize?: number;
  maxQueueWaitMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  bulkheads?: Readonly<Record<string, BulkheadOptions>>;
}

export interface BulkheadOptions {
  maxConcurrent: number;
  maxQueue: number;
}

export interface BulkheadMetrics extends BulkheadOptions {
  active: number;
  queued: number;
  rejected: number;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts?: number;
}

export interface CircuitBreakerMetrics {
  enabled: boolean;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  breakerTrips: number;
  breakerRejected: number;
  halfOpenAttempts: number;
  breakerRecoveries: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryOptions;
  bulkhead?: string;
}

export interface RunContext {
  signal: AbortSignal;
  /** One-based execution attempt number; 1 is the initial attempt. */
  attempt: number;
}

export interface RetryOptions {
  /** Number of retries after the initial attempt. Defaults to 0. */
  attempts?: number;
  /** Fixed delay before each retry. Defaults to 0. */
  delayMs?: number;
  /** Receives the failure and its one-based execution attempt number. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface ConcurrencyTimingMetrics extends LatencyMetrics {
  averageMs: number;
}

export interface ConcurrencyMetrics {
  name: string;
  limit: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  rejected: number;
  accepted: number;
  maxQueueSize: number;
  rejectedQueueFull: number;
  bulkheadRejected: number;
  queueTimedOut: number;
  executionTimedOut: number;
  abortedWhileQueued: number;
  queueUtilization: number;
  queueRejectionRate: number;
  queueTimeoutRate: number;
  retriesAttempted: number;
  retrySuccesses: number;
  retryExhausted: number;
  bulkheads: Readonly<Record<string, Readonly<BulkheadMetrics>>>;
  circuitBreaker?: CircuitBreakerMetrics;
  queueWait: ConcurrencyTimingMetrics;
  execution: ConcurrencyTimingMetrics;
  total: ConcurrencyTimingMetrics;
}

export interface ConcurrencyController {
  run<T>(operation: (context: RunContext) => Promise<T> | T, options?: RunOptions): Promise<T>;
  setLimit(limit: number): void;
  getLimit(): number;
  stats(): ConcurrencyMetrics;
  close(): Promise<void>;
  lifecycle(): LifecycleState;
}
