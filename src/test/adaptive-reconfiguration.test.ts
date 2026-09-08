import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';

function adaptiveOptions(name: string) {
  return {
    name,
    minLimit: 10,
    maxLimit: 100,
    targetP95Ms: 100,
    maxErrorRate: 0.01,
    mode: 'auto' as const,
    evaluationIntervalMs: 1,
    healthyEvaluations: 1,
    unhealthyEvaluations: 1,
    ewmaAlpha: 1
  };
}

test('fails fast for invalid adaptive limits, initial linked limit, and latency target', () => {
  const factory = createFactory();
  assert.throws(() => factory.adaptiveConcurrency({ ...adaptiveOptions('invalid-minimum'), minLimit: 0 }), /minLimit/);
  assert.throws(() => factory.adaptiveConcurrency({ ...adaptiveOptions('invalid-range'), minLimit: 20, maxLimit: 10 }), /maxLimit/);
  assert.throws(() => factory.adaptiveConcurrency({ ...adaptiveOptions('invalid-target'), targetP95Ms: 0 }), /targetP95Ms/);
  const work = factory.concurrency({ name: 'outside-initial-limit', limit: 10 });
  assert.throws(() => factory.adaptiveConcurrency({ ...adaptiveOptions('outside-control'), controller: work, minLimit: 20, maxLimit: 30 }), /initial controller limit/);
});

test('updates safe runtime fields atomically and preserves adaptive history', () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'runtime-work', limit: 20 });
  const adaptive = factory.adaptiveConcurrency({ ...adaptiveOptions('runtime-control'), controller: work });
  adaptive.evaluate({ timestamp: 1, currentLimit: 20, active: 20, queued: 0, throughput: 100, p95Ms: 20, errorRate: 0 });
  const historyBefore = adaptive.stats().history.length;

  adaptive.updateConfig({ maxLimit: 40, targetP95Ms: 150 });
  const updated = adaptive.snapshot();
  assert.equal(updated.controller.minLimit, 10);
  assert.equal(updated.controller.maxLimit, 40);
  assert.equal(updated.controller.targetP95Ms, 150);
  assert.equal(adaptive.stats().history.length, historyBefore);

  assert.throws(() => adaptive.updateConfig({ minLimit: 50, maxLimit: 40 }), /maxLimit/);
  const unchanged = adaptive.snapshot();
  assert.equal(unchanged.controller.minLimit, 10);
  assert.equal(unchanged.controller.maxLimit, 40);
  assert.equal(unchanged.controller.targetP95Ms, 150);
  assert.equal(work.getLimit(), 21);
});

test('reconciles the linked limit to lowered maximum and raised minimum bounds', () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'reconcile-work', limit: 50 });
  const adaptive = factory.adaptiveConcurrency({ ...adaptiveOptions('reconcile-control'), controller: work });
  adaptive.updateConfig({ maxLimit: 30 });
  assert.equal(work.getLimit(), 30);
  assert.equal(adaptive.snapshot().currentLimit, 30);
  adaptive.updateConfig({ minLimit: 35, maxLimit: 50 });
  assert.equal(work.getLimit(), 35);
  assert.equal(adaptive.snapshot().currentLimit, 35);
});

test('lowering a limit keeps active and queued work intact until capacity naturally frees', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'drain-work', limit: 2 });
  const adaptive = factory.adaptiveConcurrency({ ...adaptiveOptions('drain-control'), controller: work, minLimit: 1, maxLimit: 3 });
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const first = work.run(async () => firstGate);
  const second = work.run(async () => secondGate);
  let queuedStarted = false;
  const queued = work.run(async () => { queuedStarted = true; });

  adaptive.updateConfig({ maxLimit: 1 });
  assert.equal(work.getLimit(), 1);
  assert.equal(work.stats().active, 2);
  assert.equal(work.stats().queued, 1);

  releaseFirst?.();
  await first;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(work.stats().active, 1);
  assert.equal(work.stats().queued, 1);
  assert.equal(queuedStarted, false);

  releaseSecond?.();
  await Promise.all([second, queued]);
  assert.equal(queuedStarted, true);
  assert.equal(work.stats().queued, 0);
});

test('an unused runtime configuration API leaves existing adaptive behavior unchanged', () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'unchanged-work', limit: 10 });
  const adaptive = factory.adaptiveConcurrency({ ...adaptiveOptions('unchanged-control'), controller: work });
  const decision = adaptive.evaluate({ timestamp: 1, currentLimit: 10, active: 10, queued: 0, throughput: 100, p95Ms: 20, errorRate: 0 });
  assert.equal(decision.action, 'increase');
  assert.equal(work.getLimit(), 11);
});
