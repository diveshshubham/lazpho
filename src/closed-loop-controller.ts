import { clampAdaptiveLimit } from './adaptive-safety.js';
import { AimdAdaptiveController } from './adaptive-controller.js';
import type {
  AdaptiveConcurrencyOptions,
  AdaptiveControlMetrics,
  AdaptiveBackpressureSnapshot,
  AdaptiveDecision,
  AdaptiveDecisionEvent,
  AdaptiveRuntimeConfigUpdate,
  ClosedLoopAdaptiveConcurrencyController,
  ConcurrencyObservation,
  LifecycleState
} from './types.js';
import { ControllerLifecycleError } from './concurrency-errors.js';
import { normalizeAdaptiveOptions, validateAdaptiveRuntimeConfig } from './configuration-validation.js';

export class ClosedLoopController implements ClosedLoopAdaptiveConcurrencyController {
  private readonly adaptive: AimdAdaptiveController;
  private readonly history: AdaptiveDecision[] = [];
  private readonly historySize: number;
  private readonly controller: AdaptiveConcurrencyOptions['controller'];
  private runtimeConfig: Required<AdaptiveRuntimeConfigUpdate>;
  private evaluating = false;
  private limitChanges = 0;
  private increases = 0;
  private decreases = 0;
  private holds = 0;
  private lastDecision: AdaptiveDecision | undefined;
  private lastDecisionEvent: AdaptiveDecisionEvent | undefined;
  private lastStats: { completed: number; failed: number; rejectedQueueFull: number; queueTimedOut: number; timestamp: number } | undefined;
  private limitSince: { limit: number; timestamp: number } | undefined;
  private lifecycleState: LifecycleState = 'running';
  private closePromise: Promise<void> | undefined;

  private readonly options: AdaptiveConcurrencyOptions;

  public constructor(private readonly name: string, options: AdaptiveConcurrencyOptions) {
    const normalized = normalizeAdaptiveOptions(options);
    this.options = normalized;
    this.adaptive = new AimdAdaptiveController(name, normalized);
    this.controller = normalized.controller;
    this.runtimeConfig = {
      minLimit: normalized.minLimit,
      maxLimit: normalized.maxLimit,
      targetP95Ms: normalized.targetP95Ms
    };
    this.historySize = normalized.decisionHistorySize;
    if (this.controller) {
      const initialLimit = this.controller.getLimit();
      this.validateInitialLimit(initialLimit);
      this.limitSince = { limit: initialLimit, timestamp: Date.now() };
    }
  }

  public evaluate(observation: ConcurrencyObservation): AdaptiveDecision {
    if (this.evaluating) return this.safeHold(this.currentLimit(observation.currentLimit));
    this.evaluating = true;
    try {
      const currentLimit = this.currentLimit(observation.currentLimit);
      const decision = this.adaptive.evaluate({ ...observation, currentLimit });
      return this.recordAndApply(decision);
    } catch (error) {
      if (!this.controller) throw error;
      return this.record(this.safeHold(this.currentLimit(observation.currentLimit)));
    } finally {
      this.evaluating = false;
    }
  }

  public evaluateFromMetrics(timestamp = Date.now()): AdaptiveDecision {
    const controller = this.controller;
    if (!controller) return this.record(this.safeHold(this.runtimeConfig.minLimit));
    try {
      const metrics = controller.stats();
      const previous = this.lastStats;
      const elapsedMs = previous ? Math.max(1, timestamp - previous.timestamp) : 1;
      const completed = metrics.completed - (previous?.completed ?? metrics.completed);
      const failed = metrics.failed - (previous?.failed ?? metrics.failed);
      const rejectedQueueFull = metrics.rejectedQueueFull - (previous?.rejectedQueueFull ?? metrics.rejectedQueueFull);
      const queueTimedOut = metrics.queueTimedOut - (previous?.queueTimedOut ?? metrics.queueTimedOut);
      this.lastStats = { completed: metrics.completed, failed: metrics.failed, rejectedQueueFull: metrics.rejectedQueueFull, queueTimedOut: metrics.queueTimedOut, timestamp };
      if (completed === 0) return this.record(this.safeHold(controller.getLimit()));
      return this.evaluate({
        timestamp,
        currentLimit: controller.getLimit(),
        active: metrics.active,
        queued: metrics.queued,
        throughput: completed / (elapsedMs / 1_000),
        p95Ms: metrics.execution.p95Ms,
        errorRate: failed / completed,
        queueWaitP95Ms: metrics.queueWait.p95Ms,
        queueUtilization: metrics.queueUtilization,
        queueRejectionRate: rejectedQueueFull / Math.max(1, completed + rejectedQueueFull + queueTimedOut),
        queueTimeoutRate: queueTimedOut / Math.max(1, completed + rejectedQueueFull + queueTimedOut)
      });
    } catch {
      return this.record(this.safeHold(this.currentLimit(1)));
    }
  }

  public state() {
    return this.adaptive.state();
  }

  public stats(): AdaptiveControlMetrics {
    const currentLimit = this.controller?.getLimit() ?? this.lastDecision?.currentLimit ?? null;
    const now = Date.now();
    const timeAtCurrentLimitMs = this.limitSince && currentLimit === this.limitSince.limit
      ? Math.max(0, now - this.limitSince.timestamp)
      : 0;
    return {
      currentLimit,
      proposedLimit: this.lastDecision?.proposedLimit ?? null,
      limitChanges: this.limitChanges,
      increases: this.increases,
      decreases: this.decreases,
      holds: this.holds,
      controllerState: this.adaptive.state().state,
      lastDecision: this.lastDecision,
      timeAtCurrentLimitMs,
      history: this.history.slice()
    };
  }

  public snapshot(): AdaptiveBackpressureSnapshot {
    const metrics = this.metrics();
    const decision = this.lastDecision;
    return {
      lifecycle: this.lifecycle(),
      currentLimit: this.currentLimit(this.options.minLimit),
      active: metrics?.active ?? 0,
      queued: metrics?.queued ?? 0,
      totalAccepted: metrics?.accepted ?? 0,
      totalRejected: metrics?.rejected ?? 0,
      totalCompleted: metrics?.completed ?? 0,
      totalFailed: metrics?.failed ?? 0,
      circuitBreaker: metrics?.circuitBreaker && { ...metrics.circuitBreaker },
      latencyEwmaMs: decision?.signals.smoothedP95Ms ?? null,
      errorRate: decision?.signals.smoothedErrorRate ?? null,
      lastDecision: this.lastDecisionEvent && { ...this.lastDecisionEvent },
      controller: {
        minLimit: this.runtimeConfig.minLimit,
        maxLimit: this.runtimeConfig.maxLimit,
        targetP95Ms: this.runtimeConfig.targetP95Ms,
        mode: this.options.mode ?? 'recommend'
      }
    };
  }

  public updateConfig(update: AdaptiveRuntimeConfigUpdate): void {
    if (this.lifecycle() !== 'running') throw new ControllerLifecycleError(this.name, 'update configuration');
    const candidate: Required<AdaptiveRuntimeConfigUpdate> = {
      minLimit: update.minLimit ?? this.runtimeConfig.minLimit,
      maxLimit: update.maxLimit ?? this.runtimeConfig.maxLimit,
      targetP95Ms: update.targetP95Ms ?? this.runtimeConfig.targetP95Ms
    };
    validateAdaptiveRuntimeConfig(candidate);
    const controller = this.controller;
    const currentLimit = controller?.getLimit();
    const reconciledLimit = currentLimit === undefined
      ? undefined
      : clampAdaptiveLimit(currentLimit, candidate.minLimit, candidate.maxLimit);

    if (controller && reconciledLimit !== undefined && reconciledLimit !== currentLimit) controller.setLimit(reconciledLimit);
    this.adaptive.updateConfig(candidate);
    this.runtimeConfig = candidate;
    if (reconciledLimit !== undefined && reconciledLimit !== currentLimit) {
      this.limitSince = { limit: reconciledLimit, timestamp: Date.now() };
    }
  }

  public lifecycle(): LifecycleState {
    return this.controller?.lifecycle() ?? this.lifecycleState;
  }

  public close(): Promise<void> {
    if (this.lifecycle() === 'closed') return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = 'draining';
    this.closePromise = (async () => {
      await this.controller?.close();
      this.lifecycleState = 'closed';
    })();
    return this.closePromise;
  }

  private recordAndApply(decision: AdaptiveDecision): AdaptiveDecision {
    let applied = false;
    const controller = this.controller;
    if (this.options.mode === 'auto' && controller && decision.action !== 'hold') {
      const actualLimit = controller.getLimit();
      const safeLimit = clampAdaptiveLimit(decision.proposedLimit, this.runtimeConfig.minLimit, this.runtimeConfig.maxLimit);
      if (actualLimit === decision.currentLimit && safeLimit === decision.proposedLimit && safeLimit !== actualLimit) {
        try {
          controller.setLimit(safeLimit);
          applied = true;
          this.limitChanges += 1;
          if (decision.action === 'increase') this.increases += 1;
          else this.decreases += 1;
          this.limitSince = { limit: safeLimit, timestamp: Date.now() };
        } catch { }
      }
    }
    return this.record({ ...decision, willApply: applied });
  }

  private record(decision: AdaptiveDecision): AdaptiveDecision {
    if (decision.action === 'hold') this.holds += 1;
    this.lastDecision = decision;
    this.history.push(decision);
    if (this.history.length > this.historySize) this.history.shift();
    this.lastDecisionEvent = this.decisionEvent(decision);
    this.emitDecision(this.lastDecisionEvent);
    this.emitMetrics();
    return decision;
  }

  private metrics() {
    try {
      return this.controller?.stats();
    } catch {
      return undefined;
    }
  }

  private decisionEvent(decision: AdaptiveDecision): AdaptiveDecisionEvent {
    const metrics = this.metrics();
    return {
      action: decision.action,
      reason: decision.reason,
      previousLimit: decision.currentLimit,
      nextLimit: decision.proposedLimit,
      latencyEwmaMs: decision.signals.smoothedP95Ms,
      errorRate: decision.signals.smoothedErrorRate,
      active: metrics?.active ?? 0,
      queued: metrics?.queued ?? 0,
      timestamp: Date.now()
    };
  }

  private emitDecision(event: AdaptiveDecisionEvent): void {
    try {
      this.options.onDecision?.({ ...event });
    } catch { }
  }

  private emitMetrics(): void {
    try {
      this.options.onMetrics?.(this.snapshot());
    } catch { }
  }

  private currentLimit(fallback: number): number {
    try { return this.controller?.getLimit() ?? fallback; } catch { return fallback; }
  }

  private validateInitialLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < this.runtimeConfig.minLimit || limit > this.runtimeConfig.maxLimit) {
      throw new RangeError('initial controller limit must be an integer within minLimit and maxLimit.');
    }
  }

  private safeHold(currentLimit: number): AdaptiveDecision {
    return {
      action: 'hold',
      currentLimit,
      proposedLimit: currentLimit,
      state: this.adaptive.state().state,
      reason: 'insufficient_data',
      mode: this.options.mode ?? 'recommend',
      willApply: false,
      signals: {
        smoothedP95Ms: null,
        smoothedThroughput: null,
        smoothedErrorRate: null,
        targetP95Ms: this.runtimeConfig.targetP95Ms,
        maxErrorRate: this.options.maxErrorRate
      }
    };
  }
}
