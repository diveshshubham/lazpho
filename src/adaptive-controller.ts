import { clampAdaptiveLimit } from './adaptive-safety.js';
import { normalizeAdaptiveOptions, validateAdaptiveRuntimeConfig } from './configuration-validation.js';
import { Ewma } from './ewma.js';
import type {
  AdaptiveConcurrencyController,
  AdaptiveConcurrencyOptions,
  AdaptiveControllerState,
  AdaptiveDecision,
  AdaptiveMode,
  AdaptiveReason,
  AdaptiveSignals,
  AdaptiveState,
  ConcurrencyObservation,
  QueuePressureOptions,
  AdaptiveRuntimeConfigUpdate
} from './types.js';

interface AdaptiveConfig {
  minLimit: number;
  maxLimit: number;
  targetP95Ms: number;
  maxErrorRate: number;
  mode: AdaptiveMode;
  evaluationIntervalMs: number;
  increaseStep: number;
  decreaseFactor: number;
  errorDecreaseFactor: number;
  ewmaAlpha: number;
  healthyEvaluations: number;
  unhealthyEvaluations: number;
  minThroughputImprovementRatio: number;
  queuePressure?: Required<QueuePressureOptions>;
}

export class AimdAdaptiveController implements AdaptiveConcurrencyController {
  private config: AdaptiveConfig;
  private readonly p95: Ewma;
  private readonly throughput: Ewma;
  private readonly errorRate: Ewma;
  private readonly queueUtilization: Ewma;
  private readonly queueWait: Ewma;
  private readonly queueRejections: Ewma;
  private readonly queueTimeouts: Ewma;
  private currentState: AdaptiveState = 'warmup';
  private lastTimestamp: number | undefined;
  private consecutiveHealthy = 0;
  private consecutiveUnhealthy = 0;
  private evaluations = 0;
  private lastDecision: AdaptiveDecision | undefined;

  public constructor(private readonly name: string, options: AdaptiveConcurrencyOptions) {
    this.config = normalizeAdaptiveOptions(options);
    this.p95 = new Ewma(this.config.ewmaAlpha);
    this.throughput = new Ewma(this.config.ewmaAlpha);
    this.errorRate = new Ewma(this.config.ewmaAlpha);
    this.queueUtilization = new Ewma(this.config.ewmaAlpha);
    this.queueWait = new Ewma(this.config.ewmaAlpha);
    this.queueRejections = new Ewma(this.config.ewmaAlpha);
    this.queueTimeouts = new Ewma(this.config.ewmaAlpha);
  }

  public evaluate(observation: ConcurrencyObservation): AdaptiveDecision {
    validateObservation(observation);
    if (observation.currentLimit < this.config.minLimit || observation.currentLimit > this.config.maxLimit) {
      throw new RangeError('Observation currentLimit must be within the configured safety bounds.');
    }
    if (this.lastTimestamp !== undefined && observation.timestamp < this.lastTimestamp) {
      throw new RangeError('Observation timestamp must not move backwards.');
    }
    if (this.lastTimestamp !== undefined && observation.timestamp - this.lastTimestamp < this.config.evaluationIntervalMs) {
      return this.remember(this.hold(observation.currentLimit, 'insufficient_data'));
    }
    this.lastTimestamp = observation.timestamp;
    this.evaluations += 1;
    const priorThroughput = this.throughput.current();
    const signals = this.updateSignals(observation);
    const p95 = signals.smoothedP95Ms;
    const errors = signals.smoothedErrorRate;
    if (p95 === null || errors === null) return this.remember(this.hold(observation.currentLimit, 'insufficient_data', signals));

    const pressure = this.config.queuePressure;
    const queueFailure = pressure && ((signals.smoothedQueueTimeoutRate ?? 0) > pressure.maxTimeoutRate || (signals.smoothedQueueRejectionRate ?? 0) > pressure.maxRejectionRate);
    const executionSaturated = p95 >= this.config.targetP95Ms * 0.8 || (priorThroughput !== undefined && (signals.smoothedThroughput ?? 0) < priorThroughput * 0.98);
    if (queueFailure && executionSaturated) {
      this.currentState = 'backing_off';
      const timedOut = (signals.smoothedQueueTimeoutRate ?? 0) > pressure!.maxTimeoutRate;
      return this.remember(this.change('decrease', observation.currentLimit, observation.currentLimit * (timedOut ? this.config.errorDecreaseFactor : this.config.decreaseFactor), timedOut ? 'queue_timeouts_high' : 'queue_rejections_high', signals));
    }

    if (errors > this.config.maxErrorRate || p95 > this.config.targetP95Ms) {
      this.consecutiveHealthy = 0;
      this.consecutiveUnhealthy += 1;
      if (this.consecutiveUnhealthy < this.config.unhealthyEvaluations) return this.remember(this.hold(observation.currentLimit, 'insufficient_data', signals));
      this.currentState = 'backing_off';
      const reason = errors > this.config.maxErrorRate ? 'error_rate_above_threshold' : 'latency_above_target';
      const factor = reason === 'error_rate_above_threshold' ? this.config.errorDecreaseFactor : this.config.decreaseFactor;
      return this.remember(this.change('decrease', observation.currentLimit, observation.currentLimit * factor, reason, signals));
    }

    this.consecutiveUnhealthy = 0;
    const comfortablyHealthy = p95 <= this.config.targetP95Ms * 0.8 && errors <= this.config.maxErrorRate;
    if (!comfortablyHealthy) {
      this.consecutiveHealthy = 0;
      this.currentState = 'stable';
      return this.remember(this.hold(observation.currentLimit, 'throughput_not_improving', signals));
    }

    const queuePressure = pressure !== undefined && (
      queueFailure
      || (signals.smoothedQueueUtilization ?? 0) > pressure.maxUtilization
      || (signals.smoothedQueueWaitP95Ms ?? 0) > pressure.maxQueueWaitP95Ms
    );
    const demandProbe = queuePressure
      && !queueFailure
      && observation.active >= observation.currentLimit * 0.9
      && p95 <= this.config.targetP95Ms * 0.7
      && errors <= this.config.maxErrorRate
      && priorThroughput !== undefined
      && (signals.smoothedThroughput ?? 0) >= priorThroughput * (1 + this.config.minThroughputImprovementRatio);
    if (queuePressure && !demandProbe) {
      this.currentState = 'stable';
      return this.remember(this.hold(observation.currentLimit, 'queue_pressure_hold', signals));
    }

    this.consecutiveHealthy += 1;
    if (this.currentState === 'warmup') {
      this.currentState = 'probing';
      return this.remember(this.change('increase', observation.currentLimit, observation.currentLimit + this.config.increaseStep, 'warmup', signals));
    }
    if (this.consecutiveHealthy < this.config.healthyEvaluations || priorThroughput === undefined) {
      return this.remember(this.hold(observation.currentLimit, 'insufficient_data', signals));
    }
    const improving = signals.smoothedThroughput !== null
      && signals.smoothedThroughput >= priorThroughput * (1 + this.config.minThroughputImprovementRatio);
    if (!improving) {
      this.currentState = 'stable';
      return this.remember(this.hold(observation.currentLimit, 'throughput_not_improving', signals));
    }
    this.currentState = 'probing';
    return this.remember(this.change(
      'increase',
      observation.currentLimit,
      observation.currentLimit + this.config.increaseStep,
      demandProbe ? 'queue_demand_probe' : 'healthy_and_throughput_improving',
      signals
    ));
  }

  public state(): AdaptiveControllerState {
    return { name: this.name, state: this.currentState, mode: this.config.mode, evaluations: this.evaluations, lastDecision: this.lastDecision };
  }

  public updateConfig(update: Required<AdaptiveRuntimeConfigUpdate>): void {
    const candidate: AdaptiveConfig = {
      ...this.config,
      minLimit: update.minLimit,
      maxLimit: update.maxLimit,
      targetP95Ms: update.targetP95Ms
    };
    validateAdaptiveRuntimeConfig(candidate);
    this.config = candidate;
  }

  private updateSignals(observation: ConcurrencyObservation): AdaptiveSignals {
    return {
      smoothedP95Ms: observation.p95Ms === undefined ? null : this.p95.update(observation.p95Ms),
      smoothedThroughput: this.throughput.update(observation.throughput),
      smoothedErrorRate: this.errorRate.update(observation.errorRate),
      smoothedQueueUtilization: observation.queueUtilization === undefined ? null : this.queueUtilization.update(observation.queueUtilization),
      smoothedQueueWaitP95Ms: observation.queueWaitP95Ms === undefined ? null : this.queueWait.update(observation.queueWaitP95Ms),
      smoothedQueueRejectionRate: observation.queueRejectionRate === undefined ? null : this.queueRejections.update(observation.queueRejectionRate),
      smoothedQueueTimeoutRate: observation.queueTimeoutRate === undefined ? null : this.queueTimeouts.update(observation.queueTimeoutRate),
      targetP95Ms: this.config.targetP95Ms,
      maxErrorRate: this.config.maxErrorRate
    };
  }

  private change(action: 'increase' | 'decrease', currentLimit: number, rawProposedLimit: number, reason: AdaptiveReason, signals: AdaptiveSignals): AdaptiveDecision {
    const proposedLimit = clampAdaptiveLimit(rawProposedLimit, this.config.minLimit, this.config.maxLimit);
    if (proposedLimit === currentLimit) return this.hold(currentLimit, action === 'increase' ? 'at_max_limit' : 'at_min_limit', signals);
    return { action, currentLimit, proposedLimit, state: this.currentState, reason, mode: this.config.mode, willApply: false, signals };
  }

  private hold(currentLimit: number, reason: AdaptiveReason, signals = this.signals()): AdaptiveDecision {
    return { action: 'hold', currentLimit, proposedLimit: currentLimit, state: this.currentState, reason, mode: this.config.mode, willApply: false, signals };
  }

  private signals(): AdaptiveSignals {
    return {
      smoothedP95Ms: this.p95.current() ?? null,
      smoothedThroughput: this.throughput.current() ?? null,
      smoothedErrorRate: this.errorRate.current() ?? null,
      targetP95Ms: this.config.targetP95Ms,
      maxErrorRate: this.config.maxErrorRate
    };
  }

  private remember(decision: AdaptiveDecision): AdaptiveDecision {
    this.lastDecision = decision;
    return decision;
  }
}

function validateObservation(observation: ConcurrencyObservation): void {
  for (const [name, value] of Object.entries(observation)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new RangeError(`Observation ${name} must be a finite non-negative number.`);
    }
  }
  if (!Number.isInteger(observation.currentLimit) || observation.currentLimit === 0) throw new RangeError('Observation currentLimit must be a positive integer.');
}
