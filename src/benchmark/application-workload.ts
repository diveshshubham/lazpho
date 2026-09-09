import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ControllerAbortError,
  ControllerTimeoutError,
  QueueAbortedError,
  QueueFullError,
  QueueWaitTimeoutError,
  createFactory
} from '../index.js';
import type { AdaptiveDecision, ConcurrencyController, ConcurrencyMetrics } from '../index.js';

type Strategy = 'Unlimited' | 'Fixed' | 'Adaptive';
type Phase = 'healthy' | 'saturation' | 'slowdown' | 'recovery';
type Outcome = 'success' | 'queueRejected' | 'queueTimedOut' | 'executionTimedOut' | 'downstreamFailed' | 'cancelled';

interface PhaseConfig { name: Phase; durationMs: number; offersPerTick: number; }
interface TimelineEntry {
  elapsedMs: number;
  phase: Phase;
  limit: number | null;
  active: number;
  queued: number;
  accepted: number;
  completed: number;
  failed: number;
  rejected: number;
  queueTimedOut: number;
  executionTimedOut: number;
  queueP95Ms: number;
  executionP95Ms: number;
  totalP95Ms: number;
  throughput: number;
  action: AdaptiveDecision['action'] | '-';
  reason: AdaptiveDecision['reason'] | '-';
}
interface StrategyResult {
  strategy: Strategy;
  submitted: number;
  successful: number;
  successRps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  queueRejected: number;
  queueTimedOut: number;
  executionTimedOut: number;
  downstreamFailed: number;
  cancelled: number;
  downstreamPeak: number;
  averageLimit: number | null;
  peakLimit: number | null;
  finalLimit: number | null;
  increases: number;
  decreases: number;
  finalActive: number;
  finalQueued: number;
  timeline: TimelineEntry[];
}

class DownstreamFailure extends Error { public constructor(public readonly status: number) { super(`Downstream HTTP ${status}`); } }
class DirectTimeoutError extends Error {}

const evaluationIntervalMs = 200;
const sampleIntervalMs = 250;
const offerIntervalMs = 25;
const initialLimit = 4;
const maxQueueSize = 512;
const maxQueueWaitMs = 1_200;
const executionTimeoutMs = 450;
const phases: readonly PhaseConfig[] = [
  { name: 'healthy', durationMs: 1_500, offersPerTick: 10 },
  { name: 'saturation', durationMs: 1_500, offersPerTick: 30 },
  { name: 'slowdown', durationMs: 1_500, offersPerTick: 10 },
  { name: 'recovery', durationMs: 3_500, offersPerTick: 2 }
];
const adaptiveConfig = {
  minLimit: 2,
  maxLimit: 16,
  targetP95Ms: 75,
  maxErrorRate: 0.05,
  mode: 'auto' as const,
  evaluationIntervalMs,
  increaseStep: 2,
  decreaseFactor: 0.75,
  errorDecreaseFactor: 0.5,
  ewmaAlpha: 0.5,
  healthyEvaluations: 1,
  unhealthyEvaluations: 1,
  minThroughputImprovementRatio: 0.01,
  queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 800, maxRejectionRate: 0.05, maxTimeoutRate: 0.05 }
};

let downstreamPhase: Phase = 'healthy';
let downstreamActive = 0;
let downstreamPeak = 0;
let downstreamSequence = 0;
const server = createServer(async (_request, response) => {
  downstreamActive += 1;
  downstreamPeak = Math.max(downstreamPeak, downstreamActive);
  const activeAtStart = downstreamActive;
  const sequence = ++downstreamSequence;
  try {
    const delayMs = Math.min(600, downstreamPhase === 'slowdown'
      ? 85 + Math.max(0, activeAtStart - 5) * 22
      : 18 + Math.max(0, activeAtStart - 12) * 8);
    await sleep(delayMs);
    if (response.destroyed) return;
    response.statusCode = downstreamPhase === 'slowdown' && sequence % 17 === 0 ? 503 : 200;
    response.end(response.statusCode === 200 ? 'ok' : 'dependency failure');
  } finally {
    downstreamActive -= 1;
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as AddressInfo;
const dependencyUrl = `http://127.0.0.1:${address.port}/dependency`;

const processFailures: unknown[] = [];
const onUnhandled = (error: unknown) => processFailures.push(error);
process.on('unhandledRejection', onUnhandled);
process.on('uncaughtExceptionMonitor', onUnhandled);

try {
  const results: StrategyResult[] = [];
  for (const strategy of ['Unlimited', 'Fixed', 'Adaptive'] as const) results.push(await runStrategy(strategy));
  console.log('Application benchmark configuration');
  console.table([{ initialLimit, maxQueueSize, maxQueueWaitMs, executionTimeoutMs, ...adaptiveConfig }]);
  console.log('\nStrategy comparison');
  console.table(results.map(({ timeline: _timeline, ...result }) => ({
    ...result,
    successRps: round(result.successRps),
    p50Ms: round(result.p50Ms),
    p95Ms: round(result.p95Ms),
    p99Ms: round(result.p99Ms),
    averageLimit: result.averageLimit === null ? null : round(result.averageLimit)
  })));
  const adaptive = results.find((result) => result.strategy === 'Adaptive')!;
  console.log('\nAdaptive limit timeline');
  console.table(adaptive.timeline.map((entry) => ({
    time: `${(entry.elapsedMs / 1_000).toFixed(2)}s`, phase: entry.phase, limit: entry.limit,
    active: entry.active, queued: entry.queued, accepted: entry.accepted, completed: entry.completed,
    failed: entry.failed, rejected: entry.rejected, queueTimeouts: entry.queueTimedOut,
    executionTimeouts: entry.executionTimedOut, queueP95: round(entry.queueP95Ms),
    executionP95: round(entry.executionP95Ms), totalP95: round(entry.totalP95Ms),
    throughput: round(entry.throughput), action: entry.action, reason: entry.reason
  })));
  assert.equal(processFailures.length, 0, 'benchmark must not emit unhandled process failures');
} finally {
  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtExceptionMonitor', onUnhandled);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runStrategy(strategy: Strategy): Promise<StrategyResult> {
  const factory = createFactory();
  const controller = strategy === 'Unlimited' ? undefined : factory.concurrency({
    name: `${strategy.toLowerCase()}-application-benchmark`, limit: initialLimit, maxQueueSize, maxQueueWaitMs, latencySampleSize: 96
  });
  const adaptive = strategy === 'Adaptive' ? factory.adaptiveConcurrency({
    name: 'adaptive-application-benchmark', controller, ...adaptiveConfig
  }) : undefined;
  const outcomes: Record<Outcome, number> = { success: 0, queueRejected: 0, queueTimedOut: 0, executionTimedOut: 0, downstreamFailed: 0, cancelled: 0 };
  const latencies: number[] = [];
  const timeline: TimelineEntry[] = [];
  const limits: number[] = [];
  let submitted = 0;
  let operationActive = 0;
  let operationPeak = 0;
  const startedAt = performance.now();
  let previousCompleted = 0;
  let previousSampleAt = startedAt;
  downstreamPeak = 0;
  downstreamSequence = 0;
  adaptive?.evaluateFromMetrics(Date.now()); // establish the delta baseline before traffic

  const submitOne = async () => {
    submitted += 1;
    const requestStartedAt = performance.now();
    try {
      if (controller) {
        await controller.run(async ({ signal }) => {
          operationActive += 1;
          operationPeak = Math.max(operationPeak, operationActive);
          try { await callDependency(signal); } finally { operationActive -= 1; }
        }, { timeoutMs: executionTimeoutMs });
      } else {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), executionTimeoutMs);
        try { await callDependency(timeout.signal); }
        catch (error) { if (timeout.signal.aborted) throw new DirectTimeoutError(); throw error; }
        finally { clearTimeout(timer); }
      }
      outcomes.success += 1;
    } catch (error) {
      outcomes[classify(error)] += 1;
    } finally {
      latencies.push(performance.now() - requestStartedAt);
    }
  };

  for (const phase of phases) {
    assert.equal(downstreamActive, 0, 'downstream must be drained before a new phase');
    downstreamPhase = phase.name;
    const pending: Promise<void>[] = [];
    const phaseStartedAt = performance.now();
    const stopAt = phaseStartedAt + phase.durationMs;
    let nextOfferAt = phaseStartedAt;
    let nextSampleAt = phaseStartedAt + sampleIntervalMs;
    while (true) {
      const now = performance.now();
      while (nextOfferAt < stopAt && now >= nextOfferAt) {
        for (let index = 0; index < phase.offersPerTick; index += 1) pending.push(submitOne());
        nextOfferAt += offerIntervalMs;
      }
      if (now >= nextSampleAt) {
      const sampledAt = performance.now();
      const stats = controller?.stats();
      const decision = adaptive?.evaluateFromMetrics(Date.now());
      const completed = stats?.completed ?? outcomes.success + outcomes.downstreamFailed + outcomes.executionTimedOut;
      const throughput = (completed - previousCompleted) / Math.max(0.001, (sampledAt - previousSampleAt) / 1_000);
      previousCompleted = completed;
      previousSampleAt = sampledAt;
      const entry = timelineEntry(phase.name, sampledAt - startedAt, controller, stats, outcomes, throughput, decision);
      timeline.push(entry);
      if (entry.limit !== null) limits.push(entry.limit);
        nextSampleAt += sampleIntervalMs;
      }
      if (now >= stopAt) break;
      await sleep(Math.max(1, Math.min(nextOfferAt, nextSampleAt, stopAt) - performance.now()));
    }
    await Promise.all(pending);
    await waitForDownstreamDrain();
  }

  const stats = controller?.stats();
  const control = adaptive?.stats();
  assert.equal(operationActive, 0, `${strategy} operations must drain`);
  assert.equal(stats?.active ?? 0, 0, `${strategy} controller active work must drain`);
  assert.equal(stats?.queued ?? 0, 0, `${strategy} controller queue must drain`);
  if (controller) assert.ok(operationPeak <= Math.max(initialLimit, ...limits), `${strategy} admitted concurrency must remain within its granted peak limit`);
  if (adaptive) {
    const healthyPeak = Math.max(...timeline.filter((entry) => entry.phase === 'healthy').map((entry) => entry.limit ?? initialLimit));
    const unhealthyMinimum = Math.min(...timeline.filter((entry) => entry.phase === 'saturation' || entry.phase === 'slowdown').map((entry) => entry.limit ?? initialLimit));
    const recovery = timeline.filter((entry) => entry.phase === 'recovery');
    assert.ok(healthyPeak > initialLimit, 'sustained healthy demand must permit additive growth');
    assert.ok(unhealthyMinimum < healthyPeak, 'saturation or slowdown must reduce the healthy peak');
    assert.ok(control && control.decreases > 0, 'unhealthy evidence must produce a decrease');
    if (!recovery.some((entry) => entry.action === 'increase')) {
      console.table(recovery.map(({ phase, limit, action, reason, executionP95Ms, queueP95Ms, throughput }) => ({ phase, limit, action, reason, executionP95Ms, queueP95Ms, throughput })));
      assert.fail('recovery must resume cautious probing');
    }
  }
  if (adaptive) await adaptive.close(); else await controller?.close();
  assert.equal(controller?.lifecycle() ?? 'closed', 'closed');
  factory.close();
  const durationSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000);
  return {
    strategy, submitted, successful: outcomes.success, successRps: outcomes.success / durationSeconds,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99),
    queueRejected: outcomes.queueRejected, queueTimedOut: outcomes.queueTimedOut,
    executionTimedOut: outcomes.executionTimedOut, downstreamFailed: outcomes.downstreamFailed,
    cancelled: outcomes.cancelled, downstreamPeak, averageLimit: limits.length ? average(limits) : null,
    peakLimit: limits.length ? Math.max(...limits) : null, finalLimit: controller?.getLimit() ?? null,
    increases: control?.increases ?? 0, decreases: control?.decreases ?? 0,
    finalActive: stats?.active ?? 0, finalQueued: stats?.queued ?? 0, timeline
  };
}

function timelineEntry(phase: Phase, elapsedMs: number, controller: ConcurrencyController | undefined, stats: ConcurrencyMetrics | undefined, outcomes: Record<Outcome, number>, throughput: number, decision: AdaptiveDecision | undefined): TimelineEntry {
  return {
    elapsedMs, phase, limit: controller?.getLimit() ?? null, active: stats?.active ?? downstreamActive,
    queued: stats?.queued ?? 0, accepted: stats?.accepted ?? Object.values(outcomes).reduce((sum, value) => sum + value, 0),
    completed: stats?.completed ?? outcomes.success + outcomes.downstreamFailed + outcomes.executionTimedOut,
    failed: stats?.failed ?? outcomes.downstreamFailed, rejected: stats?.rejected ?? 0,
    queueTimedOut: stats?.queueTimedOut ?? 0, executionTimedOut: stats?.executionTimedOut ?? outcomes.executionTimedOut,
    queueP95Ms: stats?.queueWait.p95Ms ?? 0, executionP95Ms: stats?.execution.p95Ms ?? 0,
    totalP95Ms: stats?.total.p95Ms ?? 0, throughput, action: decision?.action ?? '-', reason: decision?.reason ?? '-'
  };
}

async function callDependency(signal: AbortSignal): Promise<void> {
  const response = await fetch(dependencyUrl, { signal });
  if (!response.ok) throw new DownstreamFailure(response.status);
  await response.text();
}

function classify(error: unknown): Outcome {
  if (error instanceof QueueFullError) return 'queueRejected';
  if (error instanceof QueueWaitTimeoutError) return 'queueTimedOut';
  if (error instanceof ControllerTimeoutError || error instanceof DirectTimeoutError) return 'executionTimedOut';
  if (error instanceof QueueAbortedError || error instanceof ControllerAbortError) return 'cancelled';
  return 'downstreamFailed';
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function waitForDownstreamDrain(): Promise<void> { while (downstreamActive > 0) await sleep(10); }
function percentile(values: readonly number[], ratio: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0; }
function average(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function round(value: number): number { return Number(value.toFixed(1)); }
