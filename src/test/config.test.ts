import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { createLazphoPreset, getLazphoPresetInfo, inspectLazphoConfig, listLazphoPresets, resolveLazphoConfig, validateLazphoConfig } from '../config.js';
import type { LazphoConfigInput, LazphoPresetName } from '../config.js';

const names: readonly LazphoPresetName[] = ['conservative', 'balanced', 'latencySensitive', 'throughputOriented'];

test('all presets are deterministic, warning-free, deeply immutable, and accepted by existing controllers', async () => {
  assert.deepEqual(listLazphoPresets(), names);
  for (const name of names) {
    const first = createLazphoPreset(name);
    const second = createLazphoPreset(name);
    assert.deepEqual(first, second);
    assert.equal(inspectLazphoConfig(first).warnings.length, 0);
    assert.equal(getLazphoPresetInfo(name).name, name);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.concurrency));
    assert.ok(Object.isFrozen(first.adaptive));
    assert.ok(Object.isFrozen(first.adaptive.queuePressure));
    assert.throws(() => { (first.concurrency as { limit: number }).limit = 999; }, TypeError);
    assert.throws(() => { (first.adaptive.queuePressure as { maxUtilization: number }).maxUtilization = 1; }, TypeError);

    const factory = createFactory();
    const controller = factory.concurrency({ ...first.concurrency, name: `${name}-work` });
    const adaptive = factory.adaptiveConcurrency({ ...first.adaptive, name: `${name}-adaptive`, controller });
    assert.equal(await controller.run(() => name), name);
    await adaptive.close();
    factory.close();
  }
});

test('preset values express distinct bounded operating postures', () => {
  const conservative = createLazphoPreset('conservative');
  const balanced = createLazphoPreset('balanced');
  const latency = createLazphoPreset('latencySensitive');
  const throughput = createLazphoPreset('throughputOriented');
  assert.deepEqual(
    names.map((name) => {
      const value = createLazphoPreset(name);
      return [value.concurrency.limit, value.concurrency.maxQueueSize, value.adaptive.minLimit, value.adaptive.maxLimit, value.adaptive.targetP95Ms];
    }),
    [[4, 16, 2, 8, 250], [8, 64, 4, 32, 200], [4, 8, 2, 16, 100], [16, 128, 8, 64, 300]]
  );
  assert.ok(latency.concurrency.maxQueueSize < balanced.concurrency.maxQueueSize);
  assert.ok(throughput.adaptive.maxLimit > balanced.adaptive.maxLimit);
  assert.ok(conservative.adaptive.maxLimit < throughput.adaptive.maxLimit);
});

test('overrides use shallow primitives, partial queue pressure, and full breaker/bulkhead replacement', () => {
  const configured = createLazphoPreset('balanced', {
    concurrency: {
      name: 'orders', limit: 12, maxQueueSize: 80,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 2_000 },
      bulkheads: { payments: { maxConcurrent: 6, maxQueue: 20 } }
    },
    adaptive: { name: 'orders-adaptive', maxLimit: 48, targetP95Ms: 150, queuePressure: { maxUtilization: 0.6 } }
  });
  assert.equal(configured.concurrency.limit, 12);
  assert.equal(configured.concurrency.maxQueueWaitMs, 1_000);
  assert.deepEqual(configured.concurrency.circuitBreaker, { failureThreshold: 5, resetTimeoutMs: 2_000, halfOpenMaxAttempts: 1 });
  assert.deepEqual({ ...configured.concurrency.bulkheads }, { payments: { maxConcurrent: 6, maxQueue: 20 } });
  assert.equal(configured.adaptive.maxLimit, 48);
  assert.equal(configured.adaptive.targetP95Ms, 150);
  assert.deepEqual(configured.adaptive.queuePressure, { maxUtilization: 0.6, maxQueueWaitP95Ms: 150, maxRejectionRate: 0.01, maxTimeoutRate: 0.005 });
  assert.throws(() => { (configured.concurrency.circuitBreaker as { failureThreshold: number }).failureThreshold = 1; }, TypeError);
  assert.throws(() => { (configured.concurrency.bulkheads!.payments as { maxQueue: number }).maxQueue = 1; }, TypeError);
});

test('invalid overrides and unknown presets fail before controller construction', () => {
  assert.throws(() => createLazphoPreset('balanced', { concurrency: { limit: 0 } }), /limit must be a positive integer/);
  assert.throws(() => createLazphoPreset('balanced', { adaptive: { maxLimit: 6 } }), /initial controller limit/);
  assert.throws(() => createLazphoPreset('missing' as LazphoPresetName), /Unknown Lazpho preset/);
});

test('public validation and constructors share errors for invalid fixed and adaptive fields', () => {
  const valid = createLazphoPreset('balanced');
  const fixedInvalid = [
    { limit: 0 }, { maxQueueSize: -1 }, { maxQueueWaitMs: 0 }, { latencySampleSize: 0 },
    { name: '' }, { circuitBreaker: { failureThreshold: 0, resetTimeoutMs: 1 } },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 0 } },
    { bulkheads: { bad: { maxConcurrent: 0, maxQueue: 0 } } }
  ];
  for (const update of fixedInvalid) {
    const concurrency = { ...valid.concurrency, ...update } as LazphoConfigInput['concurrency'];
    const publicError = captured(() => validateLazphoConfig({ concurrency, adaptive: valid.adaptive }));
    const factory = createFactory();
    const constructorError = captured(() => factory.concurrency(concurrency));
    const presetError = captured(() => createLazphoPreset('balanced', { concurrency: update as never }));
    assert.equal(constructorError.constructor, publicError.constructor);
    assert.equal(constructorError.message, publicError.message);
    assert.equal(presetError.constructor, publicError.constructor);
    assert.equal(presetError.message, publicError.message);
    factory.close();
  }

  const adaptiveInvalid = [
    { minLimit: 0 }, { maxLimit: 0 }, { targetP95Ms: 0 }, { maxErrorRate: 2 },
    { evaluationIntervalMs: 0 }, { increaseStep: 0 }, { decreaseFactor: 0 },
    { errorDecreaseFactor: 2 }, { ewmaAlpha: 0 }, { healthyEvaluations: 0 },
    { unhealthyEvaluations: 0 }, { decisionHistorySize: 0 },
    { queuePressure: { maxUtilization: 2 } }
  ];
  for (const update of adaptiveInvalid) {
    const adaptive = { ...valid.adaptive, ...update } as LazphoConfigInput['adaptive'];
    const publicError = captured(() => validateLazphoConfig({ concurrency: valid.concurrency, adaptive }));
    const factory = createFactory();
    const constructorError = captured(() => factory.adaptiveConcurrency(adaptive));
    const presetError = captured(() => createLazphoPreset('balanced', { adaptive: update as never }));
    assert.equal(constructorError.constructor, publicError.constructor);
    assert.equal(constructorError.message, publicError.message);
    assert.equal(presetError.constructor, publicError.constructor);
    assert.equal(presetError.message, publicError.message);
    factory.close();
  }
});

test('inspection warnings are deterministic, immutable, advisory, and absent from resolved config', () => {
  const risky = createLazphoPreset('balanced', {
    concurrency: { limit: 95, maxQueueSize: 2_500, bulkheads: { huge: { maxConcurrent: 101, maxQueue: 2_100 } } },
    adaptive: { maxLimit: 100, targetP95Ms: 5 }
  });
  const first = inspectLazphoConfig(risky);
  const second = inspectLazphoConfig(risky);
  assert.deepEqual(first, second);
  assert.deepEqual(first.warnings.map(({ code }) => code), [
    'LARGE_QUEUE_TO_CONCURRENCY_RATIO', 'INITIAL_LIMIT_NEAR_MAXIMUM', 'VERY_LOW_LATENCY_TARGET',
    'BULKHEAD_EXCEEDS_GLOBAL_LIMIT', 'LARGE_BULKHEAD_QUEUE_RATIO'
  ]);
  const fixed = inspectLazphoConfig(createLazphoPreset('balanced', { concurrency: { limit: 8 }, adaptive: { minLimit: 8, maxLimit: 8 } }));
  assert.deepEqual(fixed.warnings.map(({ code }) => code), ['FIXED_EFFECTIVE_ADAPTIVE_LIMIT']);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.warnings));
  assert.ok(Object.isFrozen(first.warnings[0]));
  assert.ok(Object.isFrozen(first.summary));
  assert.throws(() => { (first.warnings as unknown as unknown[]).push(risky); }, TypeError);
  assert.equal('warnings' in first.config, false);
});

test('resolved configuration and inspection are JSON-serializable and callback-free', () => {
  const resolved = resolveLazphoConfig({
    concurrency: { name: 'serial', limit: 3 },
    adaptive: { name: 'serial-adaptive', minLimit: 1, maxLimit: 6, targetP95Ms: 100, maxErrorRate: 0.01 }
  });
  const parsed = JSON.parse(JSON.stringify(inspectLazphoConfig(resolved))) as { config: ResolvedConfigShape };
  assert.equal(parsed.config.concurrency.name, 'serial');
  assert.equal(parsed.config.adaptive.mode, 'recommend');
  assert.equal(JSON.stringify(resolved).includes('function'), false);
});

test('preset-derived adaptive controllers retain normal runtime updateConfig behavior', async () => {
  const preset = createLazphoPreset('balanced');
  const factory = createFactory();
  const controller = factory.concurrency({ ...preset.concurrency, name: 'runtime-preset' });
  const adaptive = factory.adaptiveConcurrency({ ...preset.adaptive, name: 'runtime-preset-adaptive', controller });
  adaptive.updateConfig({ minLimit: 6, maxLimit: 20, targetP95Ms: 175 });
  assert.deepEqual(adaptive.snapshot().controller, { minLimit: 6, maxLimit: 20, targetP95Ms: 175, mode: 'auto' });
  await adaptive.close();
  factory.close();
});

interface ResolvedConfigShape { concurrency: { name?: string }; adaptive: { mode: string } }

function captured(operation: () => unknown): Error {
  try { operation(); } catch (error) { assert.ok(error instanceof Error); return error; }
  throw new Error('Expected operation to throw.');
}
