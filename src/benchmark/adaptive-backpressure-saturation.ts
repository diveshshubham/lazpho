import assert from 'node:assert/strict';
import { QueueFullError, QueueWaitTimeoutError, createFactory } from '../index.js';
import type { AdaptiveDecision } from '../index.js';

type Strategy = 'Latency-only' | 'Queue-aware';
type Phase = 'healthy' | 'spike' | 'spike-recovery' | 'dependency-slowdown' | 'dependency-recovery' | 'resume';

interface WindowResult {
  window: number;
  phase: Phase;
  limitBefore: number;
  limitAfter: number;
  action: AdaptiveDecision['action'];
  reason: AdaptiveDecision['reason'];
  p95Ms: number;
  queueUtilization: number;
  queued: number;
  drained: boolean;
}

interface Result {
  strategy: Strategy;
  submitted: number;
  successful: number;
  successRps: number;
  p50: number;
  p95: number;
  p99: number;
  queueWaitP95: number;
  rejected: number;
  timedOut: number;
  errors: number;
  peakLimit: number;
  avgLimit: number;
  increases: number;
  decreases: number;
  holds: number;
  directionReversals: number;
  maxQueueUtilization: number;
  windowsAboveQueueThreshold: number;
  spikeRecovery: string;
  dependencyRecovery: string;
  timeline: WindowResult[];
}

const minLimit = 10;
const maxLimit = 100;
const queueThreshold = 0.8;

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function phaseFor(window: number): { phase: Phase; offered: number; multiplier: number } {
  if (window <= 6) return { phase: 'healthy', offered: 60, multiplier: 1 };
  if (window <= 9) return { phase: 'spike', offered: 300, multiplier: 1 };
  if (window <= 17) return { phase: 'spike-recovery', offered: 60, multiplier: 1 };
  if (window <= 22) return { phase: 'dependency-slowdown', offered: 120, multiplier: 3 };
  if (window <= 32) return { phase: 'dependency-recovery', offered: 60, multiplier: 1 };
  return { phase: 'resume', offered: 60, multiplier: 1 };
}

async function run(strategy: Strategy): Promise<Result> {
  const factory = createFactory();
  const controller = factory.concurrency({
    name: `${strategy}-saturation`,
    limit: minLimit,
    maxQueueSize: 250,
    maxQueueWaitMs: 1_000,
    latencySampleSize: 256
  });
  const adaptive = factory.adaptiveConcurrency({
    name: `${strategy}-saturation`,
    controller,
    minLimit,
    maxLimit,
    targetP95Ms: 80,
    maxErrorRate: 0.01,
    mode: 'auto',
    evaluationIntervalMs: 1,
    increaseStep: 10,
    healthyEvaluations: 1,
    unhealthyEvaluations: 1,
    ewmaAlpha: 1,
    queuePressure: strategy === 'Queue-aware'
      ? { maxUtilization: queueThreshold, maxQueueWaitP95Ms: 80, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 }
      : undefined
  });

  let resourceActive = 0;
  let submitted = 0;
  let successful = 0;
  let rejected = 0;
  let timedOut = 0;
  let errors = 0;
  const requestLatencies: number[] = [];
  const limits: number[] = [];
  const timeline: WindowResult[] = [];
  const startedAt = performance.now();

  for (let window = 1; window <= 36; window += 1) {
    const { phase, offered, multiplier } = phaseFor(window);
    const limitBefore = controller.getLimit();
    const work = Array.from({ length: offered }, async (_, index) => {
      submitted += 1;
      const requestStartedAt = performance.now();
      try {
        await controller.run(async () => {
          resourceActive += 1;
          const active = resourceActive;
          try {
            let delayMs = 5;
            if (active > 30 && active <= 40) delayMs = 10 + (active - 30) * 2;
            else if (active > 40 && active <= 50) delayMs = 35 + (active - 40) * 8;
            else if (active > 50) delayMs = 120 + (active - 50) * 12;
            await sleep(delayMs * multiplier);
            if (active > 60 && index % 9 === 0) throw new Error('simulated saturated dependency failure');
          } finally {
            resourceActive -= 1;
          }
        });
        successful += 1;
      } catch (error) {
        if (error instanceof QueueFullError) rejected += 1;
        else if (error instanceof QueueWaitTimeoutError) timedOut += 1;
        else errors += 1;
      } finally {
        requestLatencies.push(performance.now() - requestStartedAt);
      }
    });

    await sleep(35);
    const sampled = controller.stats();
    const decision = adaptive.evaluateFromMetrics(Date.now());
    const limitAfter = controller.getLimit();
    limits.push(limitAfter);
    await Promise.all(work);
    const drained = controller.stats().active === 0 && controller.stats().queued === 0;
    timeline.push({
      window,
      phase,
      limitBefore,
      limitAfter,
      action: decision.action,
      reason: decision.reason,
      p95Ms: sampled.execution.p95Ms,
      queueUtilization: sampled.queueUtilization,
      queued: sampled.queued,
      drained
    });
  }

  const stats = controller.stats();
  const control = adaptive.stats();
  const actions = timeline.filter((entry) => entry.action !== 'hold').map((entry) => entry.action);
  const directionReversals = actions.slice(1).filter((action, index) => action !== actions[index]).length;
  const firstDrainedAfter = (window: number) => timeline.find((entry) => entry.window > window && entry.drained);
  const firstIncreaseAfter = (window: number) => timeline.find((entry) => entry.window > window && entry.action === 'increase');
  const spikeDrained = firstDrainedAfter(9);
  const dependencyDrained = firstDrainedAfter(22);
  const resumedProbe = firstIncreaseAfter(22);
  assert.ok(control.increases > 0, `${strategy} must perform an adaptive increase.`);
  assert.ok(control.decreases > 0, `${strategy} must perform a protective adaptive decrease.`);
  assert.ok(timeline.some((entry) => entry.action === 'decrease' && ['latency_above_target', 'error_rate_above_threshold', 'queue_rejections_high', 'queue_timeouts_high'].includes(entry.reason)), `${strategy} decrease must be driven by saturation evidence.`);
  assert.ok(spikeDrained, `${strategy} queue must drain after the spike.`);
  assert.ok(dependencyDrained, `${strategy} queue must drain after dependency recovery.`);
  assert.ok(resumedProbe, `${strategy} must resume probing after dependency recovery.`);
  assert.ok(limits.every((limit) => limit >= minLimit && limit <= maxLimit), `${strategy} limits must remain bounded.`);

  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000);
  const result: Result = {
    strategy,
    submitted,
    successful,
    successRps: successful / elapsedSeconds,
    p50: percentile(requestLatencies, 0.5),
    p95: percentile(requestLatencies, 0.95),
    p99: percentile(requestLatencies, 0.99),
    queueWaitP95: stats.queueWait.p95Ms,
    rejected,
    timedOut,
    errors,
    peakLimit: Math.max(...limits),
    avgLimit: limits.reduce((total, limit) => total + limit, 0) / limits.length,
    increases: control.increases,
    decreases: control.decreases,
    holds: control.holds,
    directionReversals,
    maxQueueUtilization: Math.max(...timeline.map((entry) => entry.queueUtilization)),
    windowsAboveQueueThreshold: timeline.filter((entry) => entry.queueUtilization > queueThreshold).length,
    spikeRecovery: `spike ends W9; drained W${spikeDrained!.window} (${(spikeDrained!.window - 9) * 35}ms)`,
    dependencyRecovery: `dependency returns W23; drained W${dependencyDrained!.window}; next increase W${resumedProbe!.window}`,
    timeline
  };
  factory.close();
  return result;
}

const results = [await run('Latency-only'), await run('Queue-aware')];
console.table(results.map(({ timeline: _timeline, ...summary }) => summary));
for (const result of results) {
  console.log(`\n${result.strategy} limit timeline`);
  console.table(result.timeline.map((entry) => ({
    window: entry.window,
    phase: entry.phase,
    limit: `${entry.limitBefore}->${entry.limitAfter}`,
    action: entry.action,
    reason: entry.reason,
    p95Ms: Math.round(entry.p95Ms),
    queueUtilization: Number(entry.queueUtilization.toFixed(2)),
    queued: entry.queued,
    drained: entry.drained
  })));
}
