import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import type { AdaptiveBackpressureSnapshot, AdaptiveDecisionEvent } from '../index.js';

function options(name: string) {
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
    ewmaAlpha: 1,
    increaseStep: 10
  };
}

test('snapshot exposes current queue state, counters, and an immutable decision copy', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'snapshot-work', limit: 10 });
  const adaptive = factory.adaptiveConcurrency({ ...options('snapshot-control'), controller: work });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = Array.from({ length: 10 }, () => work.run(async () => gate));
  const queued = work.run(async () => undefined);

  const pending = adaptive.snapshot();
  assert.equal(pending.currentLimit, 10);
  assert.equal(pending.active, 10);
  assert.equal(pending.queued, 1);
  assert.equal(pending.totalAccepted, 11);
  assert.equal(pending.totalCompleted, 0);

  release?.();
  await Promise.all([...running, queued]);
  const increase = adaptive.evaluate({ timestamp: 1, currentLimit: 10, active: 0, queued: 0, throughput: 100, p95Ms: 10, errorRate: 0 });
  const snapshot = adaptive.snapshot();
  assert.equal(increase.reason, 'warmup');
  assert.equal(snapshot.currentLimit, 20);
  assert.equal(snapshot.totalCompleted, 11);
  assert.equal(snapshot.lastDecision?.reason, 'warmup');
  assert.equal(snapshot.lastDecision?.previousLimit, 10);
  assert.equal(snapshot.lastDecision?.nextLimit, 20);

  snapshot.controller.minLimit = 999;
  if (snapshot.lastDecision) snapshot.lastDecision.reason = 'at_max_limit';
  const fresh = adaptive.snapshot();
  assert.equal(fresh.controller.minLimit, 10);
  assert.equal(fresh.lastDecision?.reason, 'warmup');
});

test('decision and metrics hooks receive real decisions and current snapshots', () => {
  const decisions: AdaptiveDecisionEvent[] = [];
  const snapshots: AdaptiveBackpressureSnapshot[] = [];
  const factory = createFactory();
  const work = factory.concurrency({ name: 'hook-work', limit: 10 });
  const adaptive = factory.adaptiveConcurrency({
    ...options('hook-control'),
    controller: work,
    onDecision: (event) => decisions.push(event),
    onMetrics: (snapshot) => snapshots.push(snapshot)
  });

  adaptive.evaluate({ timestamp: 1, currentLimit: 10, active: 10, queued: 0, throughput: 100, p95Ms: 10, errorRate: 0 });
  adaptive.evaluate({ timestamp: 2, currentLimit: 20, active: 20, queued: 3, throughput: 50, p95Ms: 120, errorRate: 0 });
  adaptive.evaluate({ timestamp: 3, currentLimit: 16, active: 0, queued: 0, throughput: 50, p95Ms: 20, errorRate: 0 });

  assert.deepEqual(decisions.map((event) => event.action), ['increase', 'decrease', 'hold']);
  assert.equal(decisions[0]?.reason, 'warmup');
  assert.equal(decisions[1]?.reason, 'latency_above_target');
  assert.equal(decisions[1]?.previousLimit, 20);
  assert.equal(decisions[1]?.nextLimit, 16);
  assert.ok(decisions.every((event) => event.timestamp > 0));
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[1]?.lastDecision?.reason, 'latency_above_target');
  assert.equal(snapshots[1]?.controller.mode, 'auto');
});

test('throwing observability hooks do not affect adaptive decisions or work execution', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'safe-hook-work', limit: 10 });
  const adaptive = factory.adaptiveConcurrency({
    ...options('safe-hook-control'),
    controller: work,
    onDecision: () => { throw new Error('decision consumer failed'); },
    onMetrics: () => { throw new Error('metrics consumer failed'); }
  });

  const decision = adaptive.evaluate({ timestamp: 1, currentLimit: 10, active: 10, queued: 0, throughput: 100, p95Ms: 10, errorRate: 0 });
  await work.run(async () => 'completed');
  assert.equal(decision.action, 'increase');
  assert.equal(work.getLimit(), 20);
  assert.equal(adaptive.snapshot().totalCompleted, 1);
});

test('controllers without observability hooks retain normal adaptive behavior', () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'no-hook-work', limit: 10 });
  const adaptive = factory.adaptiveConcurrency({ ...options('no-hook-control'), controller: work });
  const decision = adaptive.evaluate({ timestamp: 1, currentLimit: 10, active: 10, queued: 0, throughput: 100, p95Ms: 10, errorRate: 0 });
  assert.equal(decision.action, 'increase');
  assert.equal(work.getLimit(), 20);
});
