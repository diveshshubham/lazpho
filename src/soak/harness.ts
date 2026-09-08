import assert from 'node:assert/strict';
import { createFactory } from '../factory.js';
import { FixedConcurrencyController } from '../concurrency-controller.js';
import { BulkheadQueueFullError, ControllerAbortError, ControllerTimeoutError } from '../concurrency-errors.js';
import { createMetricsExporter } from '../observability.js';
import { createLazphoPreset } from '../config.js';

export interface SoakOptions {
  seed: number;
  cycles: number;
  tasksPerCycle: number;
}

export interface MemorySample {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export interface SoakResult {
  seed: number;
  cycles: number;
  logicalSubmissions: number;
  attempts: number;
  successes: number;
  failures: number;
  cancellations: number;
  timeouts: number;
  retryAttempts: number;
  breakerTrips: number;
  bulkheadRejections: number;
  peakActive: number;
  peakQueued: number;
  finalActive: number;
  finalQueued: number;
  warnings: number;
  maxListenerWarnings: number;
  unhandledRejections: number;
  uncaughtExceptions: number;
  invariantViolations: number;
  initialMemory: MemorySample;
  peakMemory: MemorySample;
  finalMemory: MemorySample;
  postGcMemory?: MemorySample;
  obviousMonotonicHeapGrowth: boolean;
  durationMs: number;
}

class SeededRandom {
  public constructor(private state: number) { }
  public next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  public integer(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
}

export async function runSoak(options: SoakOptions): Promise<SoakResult> {
  validateOptions(options);
  const startedAt = performance.now();
  const random = new SeededRandom(options.seed);
  const initialMemory = memorySample();
  const memorySamples: MemorySample[] = [initialMemory];
  const totals = {
    attempts: 0, successes: 0, failures: 0, cancellations: 0, timeouts: 0,
    retryAttempts: 0, breakerTrips: 0, bulkheadRejections: 0,
    peakActive: 0, peakQueued: 0, finalActive: 0, finalQueued: 0, invariantViolations: 0
  };
  let warnings = 0;
  let maxListenerWarnings = 0;
  let unhandledRejections = 0;
  let uncaughtExceptions = 0;
  const warningListener = (warning: Error) => {
    warnings += 1;
    if (warning.name === 'MaxListenersExceededWarning') maxListenerWarnings += 1;
  };
  const rejectionListener = () => { unhandledRejections += 1; };
  const exceptionListener = () => { uncaughtExceptions += 1; };
  process.on('warning', warningListener);
  process.on('unhandledRejection', rejectionListener);
  process.on('uncaughtExceptionMonitor', exceptionListener);

  try {
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      await runCycle(cycle, options, random, totals);
      const gc = (globalThis as { gc?: () => void }).gc;
      if (gc) gc();
      memorySamples.push(memorySample());
    }
  } finally {
    process.removeListener('warning', warningListener);
    process.removeListener('unhandledRejection', rejectionListener);
    process.removeListener('uncaughtExceptionMonitor', exceptionListener);
  }

  await immediate();
  const finalMemory = memorySample();
  memorySamples.push(finalMemory);
  const gc = (globalThis as { gc?: () => void }).gc;
  let postGcMemory: MemorySample | undefined;
  if (gc) {
    gc();
    postGcMemory = memorySample();
    memorySamples.push(postGcMemory);
  }
  const obviousMonotonicHeapGrowth = hasObviousMonotonicGrowth(memorySamples.slice(Math.min(3, memorySamples.length - 1)));
  assert.equal(totals.finalActive, 0);
  assert.equal(totals.finalQueued, 0);
  assert.equal(maxListenerWarnings, 0, 'soak emitted a MaxListenersExceededWarning');
  assert.equal(unhandledRejections, 0, 'soak observed an unhandled rejection');
  assert.equal(uncaughtExceptions, 0, 'soak observed an uncaught exception');
  assert.equal(obviousMonotonicHeapGrowth, false, 'soak detected obvious monotonic heap growth');
  assert.equal(totals.invariantViolations, 0, 'soak detected an internal invariant violation');

  return {
    seed: options.seed,
    cycles: options.cycles,
    logicalSubmissions: options.cycles * options.tasksPerCycle,
    ...totals,
    warnings,
    maxListenerWarnings,
    unhandledRejections,
    uncaughtExceptions,
    initialMemory,
    peakMemory: peakMemory(memorySamples),
    finalMemory,
    postGcMemory,
    obviousMonotonicHeapGrowth,
    durationMs: performance.now() - startedAt
  };
}

async function runCycle(
  cycle: number,
  options: SoakOptions,
  random: SeededRandom,
  totals: Omit<SoakResult, 'seed' | 'cycles' | 'logicalSubmissions' | 'warnings' | 'maxListenerWarnings' | 'unhandledRejections' | 'uncaughtExceptions' | 'initialMemory' | 'peakMemory' | 'finalMemory' | 'postGcMemory' | 'obviousMonotonicHeapGrowth' | 'durationMs'>
): Promise<void> {
  const factory = createFactory({ eventLoopResolutionMs: 5 });
  const preset = createLazphoPreset('conservative', {
    concurrency: {
      limit: 4, maxQueueSize: 24, maxQueueWaitMs: 12, latencySampleSize: 64,
      bulkheads: {
        fast: { maxConcurrent: 3, maxQueue: 12 },
        slow: { maxConcurrent: 1, maxQueue: 8 },
        flaky: { maxConcurrent: 2, maxQueue: 8 }
      },
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 2, halfOpenMaxAttempts: 1 }
    },
    adaptive: {
      minLimit: 2, maxLimit: 8, targetP95Ms: 15, maxErrorRate: 0.2,
      mode: 'auto', evaluationIntervalMs: 1, increaseStep: 1,
      healthyEvaluations: 2, unhealthyEvaluations: 2, decreaseFactor: 0.8,
      errorDecreaseFactor: 0.5, ewmaAlpha: 0.2, minThroughputImprovementRatio: 0.01,
      decisionHistorySize: 50, queuePressure: undefined
    }
  });
  const controller = factory.concurrency({ ...preset.concurrency, name: `soak-work-${cycle}` }) as FixedConcurrencyController;
  const adaptive = factory.adaptiveConcurrency({
    ...preset.adaptive,
    name: `soak-adaptive-${cycle}`,
    controller,
  });
  let exported = 0;
  const exporter = createMetricsExporter(controller, {
    adaptive,
    export: () => {
      exported += 1;
      if (cycle % 7 === 0) throw new Error('simulated soak exporter failure');
    }
  });

  // Exercise the lazy breaker lifecycle without adding cooldown timers.
  await assert.rejects(controller.run(() => { throw new Error('breaker-down-1'); }, { bulkhead: 'flaky' }));
  await assert.rejects(controller.run(() => { throw new Error('breaker-down-2'); }, { bulkhead: 'flaky' }));
  await assert.rejects(controller.run(() => undefined, { bulkhead: 'fast' }));
  await delay(3);
  await controller.run(() => undefined, { bulkhead: 'fast' });

  const attempts = new Set<string>();
  const settlements = new Map<number, number>();
  const submissions: Promise<void>[] = [];
  let cyclePeakActive = 0;
  let cyclePeakQueued = 0;
  for (let id = 0; id < options.tasksPerCycle; id += 1) {
    const mode = (id + cycle + random.integer(11)) % 11;
    const bulkhead = mode < 5 ? 'fast' : mode < 8 ? 'slow' : 'flaky';
    const abort = new AbortController();
    if (mode === 0) abort.abort();
    const logicalId = cycle * options.tasksPerCycle + id;
    const run = controller.run(async ({ signal, attempt }) => {
      const attemptId = `${logicalId}:${attempt}`;
      assert.equal(attempts.has(attemptId), false, `attempt ${attemptId} executed more than once`);
      attempts.add(attemptId);
      if (mode === 1 || mode === 2) await cancellableDelay(mode === 1 ? 4 : 3, signal);
      else if (mode === 3 && attempt === 1) throw new Error('transient');
      else if (mode === 4) throw new Error('persistent');
      else if (mode >= 7) await cancellableDelay(1 + random.integer(3), signal);
    }, {
      bulkhead,
      signal: abort.signal,
      timeoutMs: mode === 2 ? 1 : 20,
      retry: { attempts: mode === 3 || mode === 4 ? 1 : 0, delayMs: 2 }
    }).then(
      () => { totals.successes += 1; settle(settlements, logicalId); },
      (error: unknown) => {
        if (error instanceof ControllerTimeoutError) totals.timeouts += 1;
        else if (error instanceof ControllerAbortError) totals.cancellations += 1;
        else if (error instanceof BulkheadQueueFullError) totals.bulkheadRejections += 1;
        else totals.failures += 1;
        settle(settlements, logicalId);
      }
    );
    submissions.push(run);
    const current = controller.stats();
    cyclePeakActive = Math.max(cyclePeakActive, current.active);
    cyclePeakQueued = Math.max(cyclePeakQueued, current.queued);
    if (mode === 1) setTimeout(() => abort.abort(), 0);
  }

  adaptive.updateConfig(cycle % 2 === 0
    ? { minLimit: 2, maxLimit: 6, targetP95Ms: 12 }
    : { minLimit: 3, maxLimit: 8, targetP95Ms: 18 });
  adaptive.evaluateFromMetrics(Date.now());
  exporter.export();
  await immediate();
  const closing = adaptive.close();
  await Promise.all(submissions);
  await closing;
  exporter.export();
  exporter.dispose();
  exporter.dispose();
  assert.equal(exporter.export(), false);
  assert.equal(exported, 2);

  assert.equal(settlements.size, options.tasksPerCycle, `cycle ${cycle}: logical operation did not settle`);
  for (const count of settlements.values()) assert.equal(count, 1, `cycle ${cycle}: logical operation settled more than once`);
  const metrics = controller.stats();
  const debug = controller.debugStateForTests();
  try {
    assert.equal(controller.lifecycle(), 'closed');
    assert.equal(metrics.active, 0);
    assert.equal(metrics.queued, 0);
    assert.equal(debug.active, 0);
    assert.equal(debug.queued, 0);
    assert.equal(debug.linkedQueueNodes, 0);
    assert.equal(debug.executionTimers + debug.queueTimers + debug.retryTimers, 0);
    assert.equal(debug.abortListeners, 0);
    assert.equal(debug.pendingRetryChains, 0);
    for (const partition of debug.partitions) {
      assert.equal(partition.active, 0);
      assert.equal(partition.queued, 0);
      assert.equal(partition.hasHead, false);
      assert.equal(partition.hasTail, false);
    }
    for (const value of [metrics.completed, metrics.failed, metrics.cancelled, metrics.timedOut, metrics.executionTimedOut,
      metrics.rejected, metrics.retriesAttempted, metrics.retryExhausted, metrics.bulkheadRejected]) {
      assert.ok(Number.isFinite(value) && value >= 0);
    }
  } catch (error) {
    totals.invariantViolations += 1;
    throw error;
  } finally {
    factory.close();
  }
  totals.attempts += metrics.completed;
  totals.retryAttempts += metrics.retriesAttempted;
  totals.breakerTrips += metrics.circuitBreaker?.breakerTrips ?? 0;
  totals.peakActive = Math.max(totals.peakActive, cyclePeakActive);
  totals.peakQueued = Math.max(totals.peakQueued, cyclePeakQueued);
  totals.finalActive = metrics.active;
  totals.finalQueued = metrics.queued;
}

function settle(settlements: Map<number, number>, id: number): void {
  settlements.set(id, (settlements.get(id) ?? 0) + 1);
}

async function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function memorySample(): MemorySample {
  const memory = process.memoryUsage();
  return { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss, external: memory.external };
}

function peakMemory(samples: MemorySample[]): MemorySample {
  return samples.reduce((peak, sample) => ({
    heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
    heapTotal: Math.max(peak.heapTotal, sample.heapTotal),
    rss: Math.max(peak.rss, sample.rss),
    external: Math.max(peak.external, sample.external)
  }), { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 });
}

function hasObviousMonotonicGrowth(samples: MemorySample[]): boolean {
  if (samples.length < 8) return false;
  let consecutiveGrowth = 0;
  let runStart = samples[0].heapUsed;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].heapUsed >= samples[index - 1].heapUsed) consecutiveGrowth += 1;
    else { consecutiveGrowth = 0; runStart = samples[index].heapUsed; }
    const growth = samples[index].heapUsed - runStart;
    if (consecutiveGrowth >= 8 && growth > Math.max(32 * 1024 * 1024, runStart * 0.75)) return true;
  }
  return false;
}

function validateOptions(options: SoakOptions): void {
  if (!Number.isInteger(options.seed) || !Number.isInteger(options.cycles) || !Number.isInteger(options.tasksPerCycle)
    || options.seed < 0 || options.cycles <= 0 || options.tasksPerCycle <= 0) {
    throw new RangeError('Soak seed must be non-negative; cycles and tasksPerCycle must be positive integers.');
  }
}

function immediate(): Promise<void> { return new Promise<void>((resolve) => setImmediate(resolve)); }
function delay(milliseconds: number): Promise<void> { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
