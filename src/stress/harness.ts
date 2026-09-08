import assert from 'node:assert/strict';
import {
  BulkheadQueueFullError,
  ControllerAbortError,
  ControllerLifecycleError,
  ControllerTimeoutError,
  QueueFullError,
  createFactory
} from '../index.js';
import { createMetricsExporter } from '../observability.js';
import { createLazphoPreset } from '../config.js';

export interface StressScenarioOptions {
  seed: number;
  tasks: number;
}

export interface StressResult {
  seed: number;
  submitted: number;
  totalAttempts: number;
  retryAttempts: number;
  retrySuccesses: number;
  retryExhausted: number;
  success: number;
  taskFailure: number;
  cancelled: number;
  timedOut: number;
  rejected: number;
  bulkheadRejected: number;
  breakerRejected: number;
  lifecycleRejected: number;
  peakActive: number;
  peakQueue: number;
  finalActive: number;
  finalQueue: number;
  finalLimit: number;
  invariantViolations: number;
  durationMs: number;
  partitions: Record<string, PartitionStressResult>;
}

export interface PartitionStressResult {
  submissions: number;
  executions: number;
  successes: number;
  failures: number;
  rejections: number;
  peakActive: number;
  peakQueued: number;
}

class SeededRandom {
  public constructor(private state: number) { }

  public next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  public integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

function immediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function delayFor(task: number): number {
  const phase = Math.floor(task / 40) % 6;
  if (phase === 0) return 0;
  if (phase === 1) return 2;
  if (phase === 2) return 8;
  if (phase === 3) return 1;
  if (phase === 4) return 4;
  return 1;
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

export async function runStressScenario({ seed, tasks }: StressScenarioOptions): Promise<StressResult> {
  if (!Number.isInteger(seed) || !Number.isInteger(tasks) || tasks <= 0) throw new RangeError('Stress seed and tasks must be positive integers.');
  const random = new SeededRandom(seed);
  const factory = createFactory();
  const preset = createLazphoPreset('balanced', {
    concurrency: {
      limit: 6, maxQueueSize: 48, maxQueueWaitMs: undefined, latencySampleSize: 128,
      bulkheads: {
        fast: { maxConcurrent: 4, maxQueue: 20 },
        slow: { maxConcurrent: 2, maxQueue: 20 },
        flaky: { maxConcurrent: 2, maxQueue: 16 }
      }
    },
    adaptive: {
      minLimit: 2, maxLimit: 16, targetP95Ms: 20, maxErrorRate: 0.1,
      mode: 'auto', evaluationIntervalMs: 1, increaseStep: 1,
      healthyEvaluations: 1, unhealthyEvaluations: 1, ewmaAlpha: 1,
      queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 20, maxRejectionRate: 0.02, maxTimeoutRate: 0.02 }
    }
  });
  const work = factory.concurrency({ ...preset.concurrency, name: `stress-work-${seed}` });
  const adaptive = factory.adaptiveConcurrency({
    ...preset.adaptive,
    name: `stress-control-${seed}`,
    controller: work,
  });
  let exportedSnapshots = 0;
  let exporterErrors = 0;
  const exporter = createMetricsExporter(work, {
    adaptive,
    export: () => {
      exportedSnapshots += 1;
      if (exportedSnapshots % 11 === 0) throw new Error('simulated exporter failure');
    },
    onError: () => { exporterErrors += 1; }
  });
  const startedAt = performance.now();
  const executions = new Map<number, number>();
  const outcomes = { success: 0, taskFailure: 0, cancelled: 0, timedOut: 0, rejected: 0, bulkheadRejected: 0, lifecycleRejected: 0 };
  const partitions: Record<string, PartitionStressResult> = {
    fast: partitionResult(),
    slow: partitionResult(),
    flaky: partitionResult()
  };
  let observedActive = 0;
  let peakActive = 0;
  let peakQueue = 0;
  let invariantViolations = 0;
  let closing: Promise<void> | undefined;
  const submissions: Promise<void>[] = [];

  const check = (): void => {
    exporter.export();
    const metrics = work.stats();
    const snapshot = adaptive.snapshot();
    try {
      assert.ok(metrics.active >= 0, `seed ${seed}: active became negative`);
      assert.ok(metrics.queued >= 0 && metrics.queued <= metrics.maxQueueSize, `seed ${seed}: queue bounds violated`);
      let partitionActive = 0;
      let partitionQueued = 0;
      for (const [name, bulkhead] of Object.entries(metrics.bulkheads)) {
        assert.ok(bulkhead.active >= 0 && bulkhead.active <= bulkhead.maxConcurrent, `seed ${seed}: ${name} active bounds violated`);
        assert.ok(bulkhead.queued >= 0 && bulkhead.queued <= bulkhead.maxQueue, `seed ${seed}: ${name} queue bounds violated`);
        partitionActive += bulkhead.active;
        partitionQueued += bulkhead.queued;
        partitions[name].peakActive = Math.max(partitions[name].peakActive, bulkhead.active);
        partitions[name].peakQueued = Math.max(partitions[name].peakQueued, bulkhead.queued);
      }
      assert.equal(partitionActive, metrics.active, `seed ${seed}: partition/global active accounting diverged`);
      assert.equal(partitionQueued, metrics.queued, `seed ${seed}: partition/global queue accounting diverged`);
      assert.ok(snapshot.currentLimit >= snapshot.controller.minLimit && snapshot.currentLimit <= snapshot.controller.maxLimit, `seed ${seed}: current limit escaped bounds`);
      assert.ok(Number.isInteger(snapshot.currentLimit) && Number.isFinite(snapshot.currentLimit), `seed ${seed}: invalid limit`);
      assert.ok((snapshot.lastDecision?.latencyEwmaMs ?? 0) >= 0 && Number.isFinite(snapshot.lastDecision?.latencyEwmaMs ?? 0), `seed ${seed}: invalid EWMA`);
      assert.ok(adaptive.stats().history.length <= 50, `seed ${seed}: decision history exceeded bound`);
    } catch (error) {
      invariantViolations += 1;
      throw error;
    }
    peakQueue = Math.max(peakQueue, metrics.queued);
  };

  for (let task = 0; task < tasks; task += 1) {
    const traffic = random.integer(100);
    const partition = traffic < 10 ? 'fast' : traffic < 80 ? 'slow' : 'flaky';
    partitions[partition].submissions += 1;
    const abort = new AbortController();
    const cancelBeforeSubmit = random.integer(29) === 0;
    const timeoutMs = random.integer(7) === 0 ? 2 + random.integer(3) : undefined;
    if (cancelBeforeSubmit) abort.abort();
    const submission = work.run(async ({ signal, attempt }) => {
      partitions[partition].executions += 1;
      const executionCount = (executions.get(task) ?? 0) + 1;
      assert.ok(executionCount <= 3, `seed ${seed}: task ${task} exceeded its retry bound`);
      executions.set(task, executionCount);
      observedActive += 1;
      peakActive = Math.max(peakActive, observedActive);
      try {
        const partitionDelay = partition === 'fast' ? 0 : partition === 'slow' ? 8 + delayFor(task) : 2 + delayFor(task);
        await cancellableDelay(partitionDelay, signal);
        const phase = Math.floor(task / 40) % 6;
        const retryStormFailure = (phase === 1 || phase === 2) && task % 5 !== 0;
        if (retryStormFailure && (phase === 1 || attempt === 1)) throw new Error('simulated retry-storm failure');
        if (task % 31 === 0 || (partition === 'flaky' && task % 7 === 0)) throw new Error('simulated dependency failure');
      } finally {
        observedActive -= 1;
      }
    }, {
      signal: abort.signal,
      timeoutMs,
      retry: { attempts: 2, delayMs: 1 },
      bulkhead: partition
    }).then(
      () => { outcomes.success += 1; partitions[partition].successes += 1; },
      (error: unknown) => {
        if (error instanceof ControllerTimeoutError) outcomes.timedOut += 1;
        else if (error instanceof ControllerAbortError) outcomes.cancelled += 1;
        else if (error instanceof QueueFullError) outcomes.rejected += 1;
        else if (error instanceof BulkheadQueueFullError) outcomes.bulkheadRejected += 1;
        else if (error instanceof ControllerLifecycleError) outcomes.lifecycleRejected += 1;
        else outcomes.taskFailure += 1;
        if (error instanceof QueueFullError || error instanceof BulkheadQueueFullError || error instanceof ControllerLifecycleError) partitions[partition].rejections += 1;
        else partitions[partition].failures += 1;
      }
    );
    submissions.push(submission);

    if (!cancelBeforeSubmit && random.integer(11) === 0) setTimeout(() => abort.abort(), random.integer(2));
    if (task % 13 === 0) {
      const before = adaptive.snapshot().controller;
      assert.throws(
        () => adaptive.updateConfig({ minLimit: 20, maxLimit: 5 }),
        closing ? ControllerLifecycleError : /maxLimit/
      );
      assert.deepEqual(adaptive.snapshot().controller, before, `seed ${seed}: invalid config partially committed`);
    }
    if (task % 17 === 0 && !closing) {
      const profile = random.integer(3);
      adaptive.updateConfig(profile === 0
        ? { minLimit: 2, maxLimit: 8, targetP95Ms: 15 }
        : profile === 1
          ? { minLimit: 4, maxLimit: 12, targetP95Ms: 25 }
          : { minLimit: 2, maxLimit: 16, targetP95Ms: 20 });
    }
    if (task === Math.floor(tasks * 0.7)) {
      closing = adaptive.close();
      for (let caller = 0; caller < 12; caller += 1) assert.equal(adaptive.close(), closing, `seed ${seed}: close promise was not shared`);
    }
    if (task % 9 === 0) adaptive.evaluateFromMetrics(Date.now());
    check();
    if (task % 8 === 7) await immediate();
  }

  await Promise.all(submissions);
  await closing;
  adaptive.evaluateFromMetrics(Date.now());
  check();
  const metrics = work.stats();
  const finalSnapshot = adaptive.snapshot();
  assert.equal(observedActive, 0, `seed ${seed}: observed active work leaked`);
  assert.equal(metrics.active, 0, `seed ${seed}: controller active work leaked`);
  assert.equal(metrics.queued, 0, `seed ${seed}: controller queue leaked`);
  assert.equal(adaptive.lifecycle(), 'closed', `seed ${seed}: lifecycle did not close`);
  assert.ok(
    [...executions.values()].reduce((total, count) => total + count, 0) <= metrics.completed,
    `seed ${seed}: task execution exceeded completed accounting`
  );
  assert.equal(
    metrics.accepted,
    metrics.completed + metrics.abortedWhileQueued,
    `seed ${seed}: accepted work was lost or double-settled`
  );
  assert.equal(
    tasks,
    outcomes.success + outcomes.taskFailure + outcomes.cancelled + outcomes.timedOut + outcomes.rejected + outcomes.bulkheadRejected + outcomes.lifecycleRejected,
    `seed ${seed}: a submission was lost`
  );
  assert.equal(invariantViolations, 0, `seed ${seed}: invariant violations detected`);
  assert.ok(exportedSnapshots > 0, `seed ${seed}: observability exporter received no snapshots`);
  assert.ok(exporterErrors > 0, `seed ${seed}: exporter failure isolation was not exercised`);
  exporter.dispose();
  exporter.dispose();
  assert.ok(partitions.fast.executions > 0 && partitions.fast.successes > 0, `seed ${seed}: healthy fast partition made no progress`);
  const breakerRejected = await exerciseBreaker(seed);
  factory.close();
  return {
    seed,
    submitted: tasks,
    totalAttempts: metrics.completed,
    retryAttempts: metrics.retriesAttempted,
    retrySuccesses: metrics.retrySuccesses,
    retryExhausted: metrics.retryExhausted,
    ...outcomes,
    breakerRejected,
    peakActive,
    peakQueue,
    finalActive: metrics.active,
    finalQueue: metrics.queued,
    finalLimit: finalSnapshot.currentLimit,
    invariantViolations,
    durationMs: performance.now() - startedAt,
    partitions
  };
}

function partitionResult(): PartitionStressResult {
  return { submissions: 0, executions: 0, successes: 0, failures: 0, rejections: 0, peakActive: 0, peakQueued: 0 };
}

async function exerciseBreaker(seed: number): Promise<number> {
  const factory = createFactory();
  const work = factory.concurrency({
    name: `stress-breaker-${seed}`,
    limit: 1,
    maxQueueSize: 4,
    bulkheads: { fast: { maxConcurrent: 1, maxQueue: 2 }, flaky: { maxConcurrent: 1, maxQueue: 2 } },
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 3, halfOpenMaxAttempts: 1 }
  });
  const release = deferred();
  const failing = work.run(async () => { await release.wait; throw new Error('breaker stress failure'); }, { bulkhead: 'flaky' });
  const queuedFast = work.run(() => undefined, { bulkhead: 'fast' });
  const queuedFlaky = work.run(() => undefined, { bulkhead: 'flaky' });
  release.open();
  await Promise.allSettled([failing, queuedFast, queuedFlaky]);
  await delay(5);
  await work.run(() => undefined, { bulkhead: 'fast' });
  await work.close();
  const metrics = work.stats();
  assert.equal(metrics.active, 0, `seed ${seed}: breaker exercise leaked active work`);
  assert.equal(metrics.queued, 0, `seed ${seed}: breaker exercise leaked queued work`);
  assert.ok(metrics.circuitBreaker?.breakerRecoveries === 1, `seed ${seed}: breaker did not recover`);
  factory.close();
  return metrics.circuitBreaker?.breakerRejected ?? 0;
}

function deferred(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
