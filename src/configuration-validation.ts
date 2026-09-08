import { circuitBreakerOptions } from './circuit-breaker.js';
import type { AdaptiveConcurrencyOptions, AdaptiveMode, AdaptiveRuntimeConfigUpdate, BulkheadOptions, CircuitBreakerOptions, ConcurrencyOptions, QueuePressureOptions } from './types.js';

export interface NormalizedConcurrencyOptions {
  name?: string;
  limit: number;
  maxQueueSize: number;
  latencySampleSize: number;
  maxQueueWaitMs?: number;
  circuitBreaker?: Required<CircuitBreakerOptions>;
  bulkheads?: Readonly<Record<string, BulkheadOptions>>;
}

export interface NormalizedAdaptiveOptions {
  name?: string;
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
  decisionHistorySize: number;
  queuePressure?: Required<QueuePressureOptions>;
  controller?: AdaptiveConcurrencyOptions['controller'];
  onMetrics?: AdaptiveConcurrencyOptions['onMetrics'];
  onDecision?: AdaptiveConcurrencyOptions['onDecision'];
}

export function normalizeConcurrencyOptions(options: ConcurrencyOptions): NormalizedConcurrencyOptions {
  validateControllerName(options.name);
  return {
    name: options.name,
    limit: positiveInteger(options.limit, 'limit'),
    maxQueueSize: options.maxQueueSize === undefined ? 1_000 : nonNegativeInteger(options.maxQueueSize, 'maxQueueSize'),
    latencySampleSize: options.latencySampleSize === undefined ? 1_024 : positiveInteger(options.latencySampleSize, 'latencySampleSize'),
    maxQueueWaitMs: options.maxQueueWaitMs === undefined ? undefined : positiveInteger(options.maxQueueWaitMs, 'maxQueueWaitMs'),
    circuitBreaker: circuitBreakerOptions(options.circuitBreaker),
    bulkheads: normalizeBulkheads(options.bulkheads)
  };
}

export function normalizeAdaptiveOptions(options: AdaptiveConcurrencyOptions): NormalizedAdaptiveOptions {
  validateControllerName(options.name);
  const normalized: NormalizedAdaptiveOptions = {
    name: options.name,
    minLimit: positiveInteger(options.minLimit, 'minLimit'),
    maxLimit: positiveInteger(options.maxLimit, 'maxLimit'),
    targetP95Ms: positiveNumber(options.targetP95Ms, 'targetP95Ms'),
    maxErrorRate: rate(options.maxErrorRate, 'maxErrorRate'),
    mode: options.mode ?? 'recommend',
    evaluationIntervalMs: positiveNumber(options.evaluationIntervalMs ?? 5_000, 'evaluationIntervalMs'),
    increaseStep: positiveInteger(options.increaseStep ?? 1, 'increaseStep'),
    decreaseFactor: factor(options.decreaseFactor ?? 0.8, 'decreaseFactor'),
    errorDecreaseFactor: factor(options.errorDecreaseFactor ?? 0.5, 'errorDecreaseFactor'),
    ewmaAlpha: factor(options.ewmaAlpha ?? 0.2, 'ewmaAlpha'),
    healthyEvaluations: positiveInteger(options.healthyEvaluations ?? 2, 'healthyEvaluations'),
    unhealthyEvaluations: positiveInteger(options.unhealthyEvaluations ?? 2, 'unhealthyEvaluations'),
    minThroughputImprovementRatio: rate(options.minThroughputImprovementRatio ?? 0.01, 'minThroughputImprovementRatio'),
    decisionHistorySize: positiveInteger(options.decisionHistorySize ?? 50, 'decisionHistorySize'),
    queuePressure: options.queuePressure ? {
      maxUtilization: rate(options.queuePressure.maxUtilization ?? 1, 'queuePressure.maxUtilization'),
      maxQueueWaitP95Ms: positiveNumber(options.queuePressure.maxQueueWaitP95Ms ?? Number.MAX_VALUE, 'queuePressure.maxQueueWaitP95Ms'),
      maxRejectionRate: rate(options.queuePressure.maxRejectionRate ?? 1, 'queuePressure.maxRejectionRate'),
      maxTimeoutRate: rate(options.queuePressure.maxTimeoutRate ?? 1, 'queuePressure.maxTimeoutRate')
    } : undefined,
    controller: options.controller,
    onMetrics: options.onMetrics,
    onDecision: options.onDecision
  };
  validateAdaptiveRuntimeConfig(normalized);
  if (!['observe', 'recommend', 'auto'].includes(normalized.mode)) throw new RangeError('mode must be observe, recommend, or auto.');
  return normalized;
}

export function validateAdaptiveRuntimeConfig(config: Required<AdaptiveRuntimeConfigUpdate>): void {
  positiveInteger(config.minLimit, 'minLimit');
  positiveInteger(config.maxLimit, 'maxLimit');
  if (config.maxLimit < config.minLimit) throw new RangeError('maxLimit must be greater than or equal to minLimit.');
  positiveNumber(config.targetP95Ms, 'targetP95Ms');
}

export function validateControllerName(value: string | undefined): void {
  if (value !== undefined && (!value || value.length > 128)) throw new RangeError('Controller name must contain 1 to 128 characters.');
}

function normalizeBulkheads(value: Readonly<Record<string, BulkheadOptions>> | undefined): Readonly<Record<string, BulkheadOptions>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('bulkheads must be an object.');
  const normalized: Record<string, BulkheadOptions> = Object.create(null);
  for (const [name, options] of Object.entries(value)) {
    if (name.length === 0 || name.length > 128) throw new RangeError('Bulkhead name must contain 1 to 128 characters.');
    if (!options || typeof options !== 'object') throw new TypeError(`bulkheads.${name} must be an object.`);
    normalized[name] = {
      maxConcurrent: positiveInteger(options.maxConcurrent, `bulkheads.${name}.maxConcurrent`),
      maxQueue: nonNegativeInteger(options.maxQueue, `bulkheads.${name}.maxQueue`)
    };
  }
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number.`);
  return value;
}

function rate(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1.`);
  return value;
}

function factor(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError(`${name} must be greater than 0 and at most 1.`);
  return value;
}
