import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { Ewma } from '../ewma.js';
import type { AdaptiveConcurrencyOptions, ConcurrencyObservation } from '../index.js';

const options: AdaptiveConcurrencyOptions = {
  name: 'orders',
  minLimit: 10,
  maxLimit: 100,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  evaluationIntervalMs: 1,
  increaseStep: 5,
  ewmaAlpha: 1,
  healthyEvaluations: 2,
  unhealthyEvaluations: 1
};

function observation(timestamp: number, currentLimit = 20, overrides: Partial<ConcurrencyObservation> = {}): ConcurrencyObservation {
  return {
    timestamp,
    currentLimit,
    active: currentLimit,
    queued: 0,
    throughput: 100,
    p95Ms: 80,
    errorRate: 0,
    ...overrides
  };
}

test('EWMA initializes and smooths values', () => {
  const ewma = new Ewma(0.25);
  assert.equal(ewma.current(), undefined);
  assert.equal(ewma.update(100), 100);
  assert.equal(ewma.update(200), 125);
  assert.throws(() => ewma.update(Number.NaN), RangeError);
  assert.throws(() => new Ewma(0), RangeError);
});

test('increases for healthy throughput-improving observations', () => {
  const controller = createFactory().adaptiveConcurrency(options);
  const warmup = controller.evaluate(observation(1, 10, { throughput: 100 }));
  const decision = controller.evaluate(observation(2, 15, { throughput: 120 }));
  assert.equal(warmup.action, 'increase');
  assert.equal(warmup.reason, 'warmup');
  assert.equal(decision.action, 'increase');
  assert.equal(decision.reason, 'healthy_and_throughput_improving');
  assert.equal(decision.proposedLimit, 20);
});

test('backs off for latency and error violations', () => {
  const latency = createFactory().adaptiveConcurrency(options);
  const latencyDecision = latency.evaluate(observation(1, 50, { p95Ms: 250 }));
  assert.equal(latencyDecision.action, 'decrease');
  assert.equal(latencyDecision.reason, 'latency_above_target');
  assert.equal(latencyDecision.proposedLimit, 40);

  const errors = createFactory().adaptiveConcurrency(options);
  const errorDecision = errors.evaluate(observation(1, 50, { errorRate: 0.02 }));
  assert.equal(errorDecision.action, 'decrease');
  assert.equal(errorDecision.reason, 'error_rate_above_threshold');
  assert.equal(errorDecision.proposedLimit, 25);
});

test('holds healthy work when throughput is no longer improving', () => {
  const controller = createFactory().adaptiveConcurrency(options);
  controller.evaluate(observation(1, 10, { throughput: 100 }));
  const decision = controller.evaluate(observation(2, 15, { throughput: 100 }));
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'throughput_not_improving');
});

test('clamps every proposal to configured safety boundaries', () => {
  const upper = createFactory().adaptiveConcurrency({ ...options, maxLimit: 20, healthyEvaluations: 1 });
  const upperDecision = upper.evaluate(observation(1, 20));
  assert.equal(upperDecision.action, 'hold');
  assert.equal(upperDecision.reason, 'at_max_limit');
  assert.equal(upperDecision.proposedLimit, 20);

  const lower = createFactory().adaptiveConcurrency(options);
  const lowerDecision = lower.evaluate(observation(1, 10, { p95Ms: 300 }));
  assert.equal(lowerDecision.action, 'hold');
  assert.equal(lowerDecision.reason, 'at_min_limit');
  assert.equal(lowerDecision.proposedLimit, 10);
});

test('uses interval gating and hysteresis to avoid noisy oscillation', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, unhealthyEvaluations: 2, healthyEvaluations: 2 });
  controller.evaluate(observation(10, 10));
  const decisions = [
    controller.evaluate(observation(11, 15, { p95Ms: 250 })),
    controller.evaluate(observation(12, 15, { p95Ms: 80 })),
    controller.evaluate(observation(13, 15, { p95Ms: 250 })),
    controller.evaluate(observation(14, 15, { p95Ms: 80 }))
  ];
  assert.ok(decisions.every((decision) => decision.action !== 'decrease'));
  const gated = controller.evaluate(observation(14, 15, { p95Ms: 300 }));
  assert.equal(gated.action, 'hold');
  assert.equal(gated.reason, 'insufficient_data');
});

test('transitions warmup to probing, stable, backing off, and probing again', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, healthyEvaluations: 1 });
  controller.evaluate(observation(1, 10, { throughput: 100 }));
  assert.equal(controller.state().state, 'probing');
  controller.evaluate(observation(2, 15, { throughput: 100 }));
  assert.equal(controller.state().state, 'stable');
  controller.evaluate(observation(3, 15, { p95Ms: 300 }));
  assert.equal(controller.state().state, 'backing_off');
  controller.evaluate(observation(4, 12, { throughput: 200, p95Ms: 50 }));
  assert.equal(controller.state().state, 'probing');
});

test('supports observe, recommend, and auto modes without applying a limit', () => {
  for (const mode of ['observe', 'recommend', 'auto'] as const) {
    const controller = createFactory().adaptiveConcurrency({ ...options, name: mode, mode });
    const decision = controller.evaluate(observation(1, 10));
    assert.equal(decision.mode, mode);
    assert.equal(decision.willApply, false);
  }
});

test('validates configuration and observations', () => {
  const factory = createFactory();
  assert.throws(() => factory.adaptiveConcurrency({ ...options, name: 'invalid-limits', minLimit: 20, maxLimit: 10 }), RangeError);
  assert.throws(() => factory.adaptiveConcurrency({ ...options, name: 'invalid-rate', maxErrorRate: 2 }), RangeError);
  assert.throws(() => factory.adaptiveConcurrency({ ...options, name: 'invalid-target', targetP95Ms: 0 }), RangeError);
  const controller = factory.adaptiveConcurrency({ ...options, name: 'validated' });
  assert.throws(() => controller.evaluate(observation(1, 10, { throughput: Number.NaN })), RangeError);
});

test('capacity simulation converges back to the healthy operating region', () => {
  const controller = createFactory().adaptiveConcurrency({
    ...options,
    name: 'simulation',
    minLimit: 10,
    maxLimit: 70,
    increaseStep: 10,
    healthyEvaluations: 1,
    ewmaAlpha: 1
  });
  let limit = 10;
  const decisions = [];
  for (let timestamp = 1; timestamp <= 12; timestamp += 1) {
    const degraded = limit >= 60;
    const decision = controller.evaluate(observation(timestamp, limit, {
      throughput: degraded ? 500 : limit * 10,
      p95Ms: degraded ? 260 : 70 + limit
    }));
    decisions.push(decision);
    if (decision.action !== 'hold') limit = decision.proposedLimit;
  }
  assert.ok(decisions.some((decision) => decision.reason === 'latency_above_target'));
  assert.ok(limit >= 40 && limit <= 50);
  assert.equal(controller.state().state, 'stable');
});

test('allows healthy probing when configured queue pressure is low', () => {
  const controller = createFactory().adaptiveConcurrency({
    ...options,
    name: 'queue-healthy',
    queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 100, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 }
  });
  const decision = controller.evaluate(observation(1, 10, { queueUtilization: 0.2, queueWaitP95Ms: 10, queueRejectionRate: 0, queueTimeoutRate: 0 }));
  assert.equal(decision.action, 'increase');
});

test('probes additively under demand pressure with healthy latency and improving throughput', () => {
  const controller = createFactory().adaptiveConcurrency({
    ...options,
    name: 'queue-pressure',
    healthyEvaluations: 1,
    queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 100, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 }
  });
  controller.evaluate(observation(1, 10, { throughput: 100, queueUtilization: 0.1 }));
  const probe = controller.evaluate(observation(2, 20, { active: 20, throughput: 120, p95Ms: 40, queueUtilization: 0.9, queueWaitP95Ms: 10, queueRejectionRate: 0, queueTimeoutRate: 0 }));
  assert.equal(probe.action, 'increase');
  assert.equal(probe.reason, 'queue_demand_probe');
  assert.equal(probe.proposedLimit, 25);
});

test('holds under queue pressure when throughput is flat and backs off for saturated rejections', () => {
  const controller = createFactory().adaptiveConcurrency({
    ...options,
    name: 'queue-plateau',
    queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 100, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 }
  });
  controller.evaluate(observation(1, 10, { throughput: 100, queueUtilization: 0.1 }));
  const held = controller.evaluate(observation(2, 20, { active: 20, throughput: 100, p95Ms: 40, queueUtilization: 0.9, queueWaitP95Ms: 10, queueRejectionRate: 0, queueTimeoutRate: 0 }));
  assert.equal(held.action, 'hold');
  assert.equal(held.reason, 'queue_pressure_hold');
  const backedOff = controller.evaluate(observation(3, 20, { active: 20, throughput: 50, p95Ms: 180, queueUtilization: 0.9, queueRejectionRate: 0.05, queueTimeoutRate: 0 }));
  assert.equal(backedOff.action, 'decrease');
  assert.equal(backedOff.reason, 'queue_rejections_high');
});

test('does not treat queue rejections as demand headroom', () => {
  const controller = createFactory().adaptiveConcurrency({
    ...options,
    name: 'queue-rejection-guardrail',
    healthyEvaluations: 1,
    queuePressure: { maxUtilization: 0.8, maxRejectionRate: 0.01 }
  });
  controller.evaluate(observation(1, 10, { throughput: 100, queueUtilization: 0.1 }));
  const decision = controller.evaluate(observation(2, 20, {
    active: 20,
    throughput: 120,
    p95Ms: 40,
    queueUtilization: 0.9,
    queueRejectionRate: 0.05
  }));
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'queue_pressure_hold');
});

test('stops demand probing near latency saturation and decreases on a hard violation', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, name: 'queue-saturation', healthyEvaluations: 1, queuePressure: { maxUtilization: 0.8 } });
  controller.evaluate(observation(1, 10, { throughput: 100, queueUtilization: 0.1 }));
  const nearTarget = controller.evaluate(observation(2, 20, { active: 20, throughput: 120, p95Ms: 175, queueUtilization: 0.9 }));
  assert.equal(nearTarget.action, 'hold');
  assert.equal(nearTarget.reason, 'throughput_not_improving');
  const violated = controller.evaluate(observation(3, 20, { active: 20, throughput: 110, p95Ms: 220, queueUtilization: 0.9 }));
  assert.equal(violated.action, 'decrease');
  assert.equal(violated.reason, 'latency_above_target');
});

test('keeps queue-demand probes additive and stops when throughput flattens', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, name: 'queue-additive', healthyEvaluations: 1, increaseStep: 10, queuePressure: { maxUtilization: 0.8 } });
  controller.evaluate(observation(1, 10, { throughput: 100, queueUtilization: 0.1 }));
  const first = controller.evaluate(observation(2, 20, { active: 20, throughput: 120, p95Ms: 40, queueUtilization: 0.9 }));
  const second = controller.evaluate(observation(3, 30, { active: 30, throughput: 140, p95Ms: 50, queueUtilization: 0.9 }));
  const stopped = controller.evaluate(observation(4, 40, { active: 40, throughput: 140, p95Ms: 60, queueUtilization: 0.9 }));
  assert.equal(first.proposedLimit, 30);
  assert.equal(second.proposedLimit, 40);
  assert.equal(stopped.action, 'hold');
  assert.equal(stopped.reason, 'queue_pressure_hold');
});

test('holds for queue wait pressure and backs off immediately for timeouts', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, name: 'queue-timeout', queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 100, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 } });
  const held = controller.evaluate(observation(1, 20, { queueUtilization: 0.4, queueWaitP95Ms: 150, queueTimeoutRate: 0, queueRejectionRate: 0 }));
  assert.equal(held.reason, 'queue_pressure_hold');
  const decrease = controller.evaluate(observation(2, 20, { throughput: 50, queueTimeoutRate: 0.05, queueRejectionRate: 0 }));
  assert.equal(decrease.action, 'decrease');
  assert.equal(decrease.reason, 'queue_timeouts_high');
});

test('noisy queue pressure and plateau never continue probing', () => {
  const controller = createFactory().adaptiveConcurrency({ ...options, name: 'queue-noise', queuePressure: { maxUtilization: 0.8 } });
  const actions = [0.77, 0.81, 0.79, 0.82, 0.78, 0.8].map((queueUtilization, index) =>
    controller.evaluate(observation(index + 1, 20, { throughput: 100, queueUtilization }))
  );
  assert.ok(actions.slice(1).every((decision) => decision.action === 'hold'));
});
