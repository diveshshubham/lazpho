import { normalizeAdaptiveOptions, normalizeConcurrencyOptions } from './configuration-validation.js';
import type { AdaptiveConcurrencyOptions, AdaptiveMode, BulkheadOptions, CircuitBreakerOptions, ConcurrencyOptions, QueuePressureOptions } from './types.js';

export type LazphoPresetName = 'conservative' | 'balanced' | 'latencySensitive' | 'throughputOriented';

export interface LazphoAdaptiveConfig extends Omit<AdaptiveConcurrencyOptions, 'controller' | 'onMetrics' | 'onDecision' | 'queuePressure'> {
  queuePressure?: QueuePressureOptions;
}

export interface LazphoConfigInput {
  concurrency: ConcurrencyOptions;
  adaptive: LazphoAdaptiveConfig;
}

export interface ResolvedLazphoConfig {
  readonly concurrency: Readonly<{
    name?: string;
    limit: number;
    maxQueueSize: number;
    latencySampleSize: number;
    maxQueueWaitMs?: number;
    circuitBreaker?: Readonly<Required<CircuitBreakerOptions>>;
    bulkheads?: Readonly<Record<string, Readonly<BulkheadOptions>>>;
  }>;
  readonly adaptive: Readonly<{
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
    queuePressure?: Readonly<Required<QueuePressureOptions>>;
  }>;
}

export interface LazphoConfigOverrides {
  concurrency?: Partial<Omit<ConcurrencyOptions, 'circuitBreaker' | 'bulkheads'>> & {
    circuitBreaker?: CircuitBreakerOptions;
    bulkheads?: Readonly<Record<string, BulkheadOptions>>;
  };
  adaptive?: Partial<Omit<LazphoAdaptiveConfig, 'queuePressure'>> & {
    queuePressure?: QueuePressureOptions;
  };
}

export type LazphoConfigWarningCode =
  | 'LARGE_QUEUE_TO_CONCURRENCY_RATIO'
  | 'INITIAL_LIMIT_NEAR_MAXIMUM'
  | 'FIXED_EFFECTIVE_ADAPTIVE_LIMIT'
  | 'BULKHEAD_EXCEEDS_GLOBAL_LIMIT'
  | 'LARGE_BULKHEAD_QUEUE_RATIO'
  | 'VERY_LOW_LATENCY_TARGET';

export interface LazphoConfigWarning {
  readonly code: LazphoConfigWarningCode;
  readonly message: string;
  readonly field: string;
}

export interface LazphoConfigInspection {
  readonly config: ResolvedLazphoConfig;
  readonly warnings: readonly LazphoConfigWarning[];
  readonly summary: Readonly<{
    initialLimit: number;
    minLimit: number;
    maxLimit: number;
    maxQueueSize: number;
    adaptiveMode: AdaptiveMode;
    bulkheadCount: number;
    breakerEnabled: boolean;
  }>;
}

export interface LazphoPresetInfo {
  readonly name: LazphoPresetName;
  readonly description: string;
}

const presetNames = Object.freeze<LazphoPresetName[]>(['conservative', 'balanced', 'latencySensitive', 'throughputOriented']);

const presetInfo: Readonly<Record<LazphoPresetName, LazphoPresetInfo>> = Object.freeze({
  conservative: Object.freeze({ name: 'conservative', description: 'Small bounds and a short bounded queue for cautious initial rollout.' }),
  balanced: Object.freeze({ name: 'balanced', description: 'Moderate bounds and queue capacity for a general-purpose starting point.' }),
  latencySensitive: Object.freeze({ name: 'latencySensitive', description: 'Tight queueing and faster latency protection for response-time-sensitive dependencies.' }),
  throughputOriented: Object.freeze({ name: 'throughputOriented', description: 'Higher bounded headroom for dependencies proven to tolerate greater concurrency.' })
});

const presets: Readonly<Record<LazphoPresetName, LazphoConfigInput>> = Object.freeze({
  conservative: {
    concurrency: { limit: 4, maxQueueSize: 16, maxQueueWaitMs: 500, latencySampleSize: 256 },
    adaptive: adaptive(2, 8, 250, 0.02, 1, 5_000, { maxUtilization: 0.5, maxQueueWaitP95Ms: 125, maxRejectionRate: 0.01, maxTimeoutRate: 0.005 }, 3, 2, 0.8, 0.6)
  },
  balanced: {
    concurrency: { limit: 8, maxQueueSize: 64, maxQueueWaitMs: 1_000, latencySampleSize: 512 },
    adaptive: adaptive(4, 32, 200, 0.02, 2, 5_000, { maxUtilization: 0.7, maxQueueWaitP95Ms: 150, maxRejectionRate: 0.01, maxTimeoutRate: 0.005 }, 2, 2, 0.8, 0.5)
  },
  latencySensitive: {
    concurrency: { limit: 4, maxQueueSize: 8, maxQueueWaitMs: 150, latencySampleSize: 512 },
    adaptive: adaptive(2, 16, 100, 0.01, 1, 2_000, { maxUtilization: 0.4, maxQueueWaitP95Ms: 50, maxRejectionRate: 0.005, maxTimeoutRate: 0.002 }, 3, 1, 0.7, 0.5)
  },
  throughputOriented: {
    concurrency: { limit: 16, maxQueueSize: 128, maxQueueWaitMs: 2_000, latencySampleSize: 1_024 },
    adaptive: adaptive(8, 64, 300, 0.03, 4, 5_000, { maxUtilization: 0.8, maxQueueWaitP95Ms: 225, maxRejectionRate: 0.02, maxTimeoutRate: 0.01 }, 2, 2, 0.85, 0.6)
  }
});

export function listLazphoPresets(): readonly LazphoPresetName[] { return presetNames; }

export function getLazphoPresetInfo(name: LazphoPresetName): LazphoPresetInfo {
  assertPreset(name);
  return presetInfo[name];
}

export function createLazphoPreset(name: LazphoPresetName, overrides: LazphoConfigOverrides = {}): ResolvedLazphoConfig {
  assertPreset(name);
  return resolveLazphoConfig(presets[name], overrides);
}

export function resolveLazphoConfig(base: LazphoConfigInput, overrides: LazphoConfigOverrides = {}): ResolvedLazphoConfig {
  const concurrency: ConcurrencyOptions = { ...base.concurrency, ...overrides.concurrency };
  const adaptiveOverride = overrides.adaptive;
  const queuePressure = adaptiveOverride && Object.prototype.hasOwnProperty.call(adaptiveOverride, 'queuePressure')
    ? adaptiveOverride.queuePressure && { ...base.adaptive.queuePressure, ...adaptiveOverride.queuePressure }
    : base.adaptive.queuePressure;
  const adaptiveInput: LazphoAdaptiveConfig = { ...base.adaptive, ...adaptiveOverride, queuePressure };
  const normalizedConcurrency = normalizeConcurrencyOptions(concurrency);
  const normalizedAdaptive = normalizeAdaptiveOptions(adaptiveInput);
  if (normalizedConcurrency.limit < normalizedAdaptive.minLimit || normalizedConcurrency.limit > normalizedAdaptive.maxLimit) {
    throw new RangeError('initial controller limit must be an integer within minLimit and maxLimit.');
  }
  return freezeConfig({
    concurrency: normalizedConcurrency,
    adaptive: {
      name: normalizedAdaptive.name,
      minLimit: normalizedAdaptive.minLimit,
      maxLimit: normalizedAdaptive.maxLimit,
      targetP95Ms: normalizedAdaptive.targetP95Ms,
      maxErrorRate: normalizedAdaptive.maxErrorRate,
      mode: normalizedAdaptive.mode,
      evaluationIntervalMs: normalizedAdaptive.evaluationIntervalMs,
      increaseStep: normalizedAdaptive.increaseStep,
      decreaseFactor: normalizedAdaptive.decreaseFactor,
      errorDecreaseFactor: normalizedAdaptive.errorDecreaseFactor,
      ewmaAlpha: normalizedAdaptive.ewmaAlpha,
      healthyEvaluations: normalizedAdaptive.healthyEvaluations,
      unhealthyEvaluations: normalizedAdaptive.unhealthyEvaluations,
      minThroughputImprovementRatio: normalizedAdaptive.minThroughputImprovementRatio,
      decisionHistorySize: normalizedAdaptive.decisionHistorySize,
      queuePressure: normalizedAdaptive.queuePressure
    }
  });
}

export function validateLazphoConfig(config: LazphoConfigInput): void { resolveLazphoConfig(config); }

export function inspectLazphoConfig(config: LazphoConfigInput): LazphoConfigInspection {
  const resolved = resolveLazphoConfig(config);
  const warnings = Object.freeze(configWarnings(resolved));
  return Object.freeze({
    config: resolved,
    warnings,
    summary: Object.freeze({
      initialLimit: resolved.concurrency.limit,
      minLimit: resolved.adaptive.minLimit,
      maxLimit: resolved.adaptive.maxLimit,
      maxQueueSize: resolved.concurrency.maxQueueSize,
      adaptiveMode: resolved.adaptive.mode,
      bulkheadCount: Object.keys(resolved.concurrency.bulkheads ?? {}).length,
      breakerEnabled: resolved.concurrency.circuitBreaker !== undefined
    })
  });
}

function configWarnings(config: ResolvedLazphoConfig): LazphoConfigWarning[] {
  const warnings: LazphoConfigWarning[] = [];
  if (config.concurrency.maxQueueSize > config.adaptive.maxLimit * 20) warning(warnings, 'LARGE_QUEUE_TO_CONCURRENCY_RATIO', 'concurrency.maxQueueSize', 'Queue capacity is more than twenty times the maximum concurrency limit.');
  if (config.adaptive.minLimit !== config.adaptive.maxLimit && config.concurrency.limit >= config.adaptive.maxLimit * 0.9) warning(warnings, 'INITIAL_LIMIT_NEAR_MAXIMUM', 'concurrency.limit', 'Initial concurrency is at least ninety percent of the adaptive maximum.');
  if (config.adaptive.mode === 'auto' && config.adaptive.minLimit === config.adaptive.maxLimit) warning(warnings, 'FIXED_EFFECTIVE_ADAPTIVE_LIMIT', 'adaptive.minLimit', 'Auto mode has identical minimum and maximum limits, so it cannot change concurrency.');
  if (config.adaptive.targetP95Ms < 10) warning(warnings, 'VERY_LOW_LATENCY_TARGET', 'adaptive.targetP95Ms', 'The latency target is below ten milliseconds and may be sensitive to runtime noise.');
  for (const [name, bulkhead] of Object.entries(config.concurrency.bulkheads ?? {})) {
    if (bulkhead.maxConcurrent > config.adaptive.maxLimit) warning(warnings, 'BULKHEAD_EXCEEDS_GLOBAL_LIMIT', `concurrency.bulkheads.${name}.maxConcurrent`, 'Bulkhead concurrency exceeds the global adaptive maximum and cannot be fully used.');
    if (bulkhead.maxQueue > bulkhead.maxConcurrent * 20) warning(warnings, 'LARGE_BULKHEAD_QUEUE_RATIO', `concurrency.bulkheads.${name}.maxQueue`, 'Bulkhead queue capacity is more than twenty times its concurrency limit.');
  }
  return warnings;
}

function warning(target: LazphoConfigWarning[], code: LazphoConfigWarningCode, field: string, message: string): void {
  target.push(Object.freeze({ code, field, message }));
}

function freezeConfig(config: { concurrency: ReturnType<typeof normalizeConcurrencyOptions>; adaptive: ResolvedLazphoConfig['adaptive'] }): ResolvedLazphoConfig {
  const bulkheads: Record<string, Readonly<BulkheadOptions>> = Object.create(null);
  for (const [name, value] of Object.entries(config.concurrency.bulkheads ?? {})) bulkheads[name] = Object.freeze({ ...value });
  const concurrency = Object.freeze({
    ...config.concurrency,
    circuitBreaker: config.concurrency.circuitBreaker && Object.freeze({ ...config.concurrency.circuitBreaker }),
    bulkheads: config.concurrency.bulkheads && Object.freeze(bulkheads)
  });
  const adaptiveConfig = Object.freeze({
    ...config.adaptive,
    queuePressure: config.adaptive.queuePressure && Object.freeze({ ...config.adaptive.queuePressure })
  });
  return Object.freeze({ concurrency, adaptive: adaptiveConfig });
}

function adaptive(
  minLimit: number,
  maxLimit: number,
  targetP95Ms: number,
  maxErrorRate: number,
  increaseStep: number,
  evaluationIntervalMs: number,
  queuePressure: QueuePressureOptions,
  healthyEvaluations: number,
  unhealthyEvaluations: number,
  decreaseFactor: number,
  errorDecreaseFactor: number
): LazphoAdaptiveConfig {
  return { minLimit, maxLimit, targetP95Ms, maxErrorRate, mode: 'auto', increaseStep, evaluationIntervalMs, queuePressure, healthyEvaluations, unhealthyEvaluations, decreaseFactor, errorDecreaseFactor };
}

function assertPreset(name: LazphoPresetName): void {
  if (!presetNames.includes(name)) throw new RangeError(`Unknown Lazpho preset: ${String(name)}.`);
}
