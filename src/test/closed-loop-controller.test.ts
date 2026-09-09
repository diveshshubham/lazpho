import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import type { AdaptiveConcurrencyOptions, ConcurrencyObservation } from '../index.js';

function observation(timestamp: number, currentLimit: number, overrides: Partial<ConcurrencyObservation> = {}): ConcurrencyObservation {
  return {
    timestamp,
    currentLimit,
    active: currentLimit,
    queued: 0,
    throughput: currentLimit * 10,
    p95Ms: 80,
    errorRate: 0,
    ...overrides
  };
}

function setup(
  mode: 'observe' | 'recommend' | 'auto' = 'auto',
  limit = 10,
  minLimit = 5,
  overrides: Partial<AdaptiveConcurrencyOptions> = {}
) {
  const factory = createFactory();
  const controller = factory.concurrency({ name: `work-${mode}`, limit });
  const adaptive = factory.adaptiveConcurrency({
    name: `adaptive-${mode}`,
    controller,
    minLimit,
    maxLimit: 50,
    targetP95Ms: 200,
    maxErrorRate: 0.01,
    mode,
    increaseStep: 5,
    decreaseFactor: 0.8,
    errorDecreaseFactor: 0.5,
    ewmaAlpha: 1,
    evaluationIntervalMs: 1,
    healthyEvaluations: 1,
    unhealthyEvaluations: 1,
    decisionHistorySize: 8,
    ...overrides
  });
  return { factory, controller, adaptive };
}

function gate(): { wait: Promise<void>; open(): void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, open: release };
}

test('auto mode applies a healthy increase through the fixed controller', () => {
  const { controller, adaptive } = setup('auto', 5);
  const decision = adaptive.evaluate(observation(1, 5));
  assert.equal(decision.action, 'increase');
  assert.equal(decision.willApply, true);
  assert.equal(controller.getLimit(), 10);
  assert.equal(adaptive.stats().increases, 1);
});

test('auto mode applies stronger error backoff and respects bounds', () => {
  const { controller, adaptive } = setup('auto', 50);
  const decision = adaptive.evaluate(observation(1, 50, { errorRate: 0.05 }));
  assert.equal(decision.action, 'decrease');
  assert.equal(decision.willApply, true);
  assert.equal(controller.getLimit(), 25);
  adaptive.evaluate(observation(2, 25, { errorRate: 1 }));
  adaptive.evaluate(observation(3, 13, { errorRate: 1 }));
  assert.ok(controller.getLimit() >= 5);
  assert.ok(controller.getLimit() <= 50);
});

test('observe and recommend modes never modify the fixed controller', () => {
  for (const mode of ['observe', 'recommend'] as const) {
    const { controller, adaptive } = setup(mode, 5);
    const decision = adaptive.evaluate(observation(1, 5));
    assert.equal(decision.action, 'increase');
    assert.equal(decision.willApply, false);
    assert.equal(controller.getLimit(), 5);
  }
});

test('holds without calling a no-op limit update', () => {
  const { controller, adaptive } = setup('auto', 50);
  const decision = adaptive.evaluate(observation(1, 50));
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'at_max_limit');
  assert.equal(adaptive.stats().limitChanges, 0);
  assert.equal(controller.getLimit(), 50);
});

test('adaptive failure fails safe and preserves the fixed controller', () => {
  const { controller, adaptive } = setup('auto', 10);
  const decision = adaptive.evaluate(observation(1, 10, { throughput: Number.NaN }));
  assert.equal(decision.action, 'hold');
  assert.equal(decision.willApply, false);
  assert.equal(controller.getLimit(), 10);
});

test('runtime decrease does not cancel active work', async () => {
  const { controller, adaptive } = setup('auto', 4, 2);
  const releases = [gate(), gate(), gate(), gate(), gate()];
  let active = 0;
  const operations = releases.map((release) => controller.run(async () => {
    active += 1;
    await release.wait;
    active -= 1;
  }));
  await Promise.resolve();
  await Promise.resolve();
  adaptive.evaluate(observation(1, 4, { errorRate: 0.5 }));
  assert.equal(controller.getLimit(), 2);
  assert.equal(active, 4);
  releases.slice(0, 4).forEach((release) => release.open());
  releases[4].open();
  await Promise.all(operations);
});

test('derives aggregate observations from controller metrics', async () => {
  const { controller, adaptive } = setup('auto', 5);
  await Promise.all(Array.from({ length: 10 }, () => controller.run(async () => undefined)));
  const decision = adaptive.evaluateFromMetrics(1);
  assert.equal(decision.currentLimit, 5);
  assert.ok(adaptive.stats().lastDecision);
});

test('serial evaluations retain bounded history and valid limits', () => {
  const { controller, adaptive } = setup('auto', 5);
  for (let timestamp = 1; timestamp <= 10_000; timestamp += 1) {
    adaptive.evaluate(observation(timestamp, controller.getLimit(), {
      p95Ms: timestamp % 7 === 0 ? 220 : 80,
      errorRate: 0
    }));
    assert.ok(controller.getLimit() >= 5 && controller.getLimit() <= 50);
  }
  assert.ok(adaptive.stats().history.length <= 8);
});

test('closed-loop simulations handle saturation, recovery, noisy metrics, and throughput plateaus', () => {
  const { controller, adaptive } = setup('auto', 5);
  let decreases = 0;
  for (let timestamp = 1; timestamp <= 18; timestamp += 1) {
    const limit = controller.getLimit();
    const saturated = limit >= 30 && timestamp < 10;
    const recovered = timestamp >= 10;
    const decision = adaptive.evaluate(observation(timestamp, limit, {
      throughput: saturated ? 300 : limit * 20,
      p95Ms: saturated ? 280 : recovered ? 70 : 100,
      errorRate: saturated && timestamp === 8 ? 0.05 : 0
    }));
    if (decision.action === 'decrease') decreases += 1;
  }
  assert.ok(decreases > 0);
  assert.ok(controller.getLimit() >= 5 && controller.getLimit() <= 50);

  const noisy = setup('auto', 20, 5, { unhealthyEvaluations: 2 });
  for (const [index, p95Ms] of [190, 210, 195, 205, 198, 202].entries()) {
    noisy.adaptive.evaluate(observation(index + 1, noisy.controller.getLimit(), { p95Ms }));
  }
  assert.ok(noisy.adaptive.stats().decreases <= 1);
});

test('recovers by probing upward after a temporary dependency slowdown', () => {
  const { controller, adaptive } = setup('auto', 20);
  adaptive.evaluate(observation(1, 20, { throughput: 200 }));
  const peakLimit = controller.getLimit();
  adaptive.evaluate(observation(2, peakLimit, { p95Ms: 300, throughput: 200 }));
  const backedOffLimit = controller.getLimit();
  assert.ok(backedOffLimit < peakLimit);
  adaptive.evaluate(observation(3, backedOffLimit, { p95Ms: 60, throughput: 400 }));
  assert.ok(controller.getLimit() > backedOffLimit);
  assert.equal(adaptive.stats().lastDecision?.willApply, true);
});
