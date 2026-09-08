import { createFactory } from '../index.js';

const BATCHES = 18;
const BATCH_SIZE = 100;
const TARGET_P95_MS = 90;

interface Result {
  strategy: string;
  throughput: number;
  successfulThroughput: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  maximumConcurrency: number;
  averageConcurrency: number;
  queueWaitP95Ms: number;
  limitChanges: number;
  convergenceEvaluation: number | null;
  oscillations: number;
  heapDeltaBytes: number;
}

async function run(strategy: 'Fixed low' | 'Fixed high' | 'Adaptive', initialLimit: number): Promise<Result> {
  const factory = createFactory();
  const controller = factory.concurrency({ name: strategy, limit: initialLimit, maxQueueSize: BATCH_SIZE * 2 });
  const adaptive = strategy === 'Adaptive'
    ? factory.adaptiveConcurrency({
      name: 'adaptive',
      controller,
      minLimit: 10,
      maxLimit: 100,
      targetP95Ms: TARGET_P95_MS,
      maxErrorRate: 0.01,
      mode: 'auto',
      increaseStep: 10,
      decreaseFactor: 0.8,
      errorDecreaseFactor: 0.5,
      ewmaAlpha: 1,
      evaluationIntervalMs: 1,
      healthyEvaluations: 1,
      unhealthyEvaluations: 1
    })
    : undefined;
  const latencies: number[] = [];
  const activeSamples: number[] = [];
  const directions: string[] = [];
  let resourceActive = 0;
  let maximumConcurrency = 0;
  let successful = 0;
  let failures = 0;
  let convergenceEvaluation: number | null = null;
  let timestamp = 0;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  for (let batch = 1; batch <= BATCHES; batch += 1) {
    const batchStartedAt = performance.now();
    await Promise.all(Array.from({ length: BATCH_SIZE }, async () => {
      try {
        await controller.run(async () => {
          resourceActive += 1;
          activeSamples.push(resourceActive);
          maximumConcurrency = Math.max(maximumConcurrency, resourceActive);
          const activeAtStart = resourceActive;
          const delayMs = activeAtStart <= 50 ? 4 : 4 + (activeAtStart - 50) * 2;
          const shouldFail = activeAtStart > 80;
          const operationStartedAt = performance.now();
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          resourceActive -= 1;
          latencies.push(performance.now() - operationStartedAt);
          if (shouldFail) throw new Error('simulated downstream saturation');
          successful += 1;
        });
      } catch {
        failures += 1;
      }
    }));
    timestamp += Math.max(1, Math.round(performance.now() - batchStartedAt));
    const decision = adaptive?.evaluateFromMetrics(timestamp);
    if (decision && decision.action !== 'hold') directions.push(decision.action);
    if (adaptive && convergenceEvaluation === null && controller.getLimit() >= 40 && controller.getLimit() <= 60) {
      convergenceEvaluation = batch;
    }
  }

  const durationMs = performance.now() - startedAt;
  const stats = controller.stats();
  const adaptiveStats = adaptive?.stats();
  const result: Result = {
    strategy,
    throughput: BATCHES * BATCH_SIZE / (durationMs / 1_000),
    successfulThroughput: successful / (durationMs / 1_000),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    errorRate: failures / (successful + failures),
    maximumConcurrency,
    averageConcurrency: average(activeSamples),
    queueWaitP95Ms: stats.queueWait.p95Ms,
    limitChanges: adaptiveStats?.limitChanges ?? 0,
    convergenceEvaluation,
    oscillations: countOscillations(directions),
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore
  };
  factory.close();
  return result;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function countOscillations(directions: string[]): number {
  let count = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] !== directions[index - 1]) count += 1;
  }
  return count;
}

function measureControllerOverhead(): void {
  const iterations = 1_000_000;
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'overhead-work', limit: 10 });
  const directStartedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) controller.stats();
  const directMs = performance.now() - directStartedAt;
  const adaptive = factory.adaptiveConcurrency({
    name: 'overhead-adaptive',
    controller,
    minLimit: 10,
    maxLimit: 100,
    targetP95Ms: 200,
    maxErrorRate: 0.01,
    mode: 'observe',
    evaluationIntervalMs: 1,
    healthyEvaluations: 1,
    decisionHistorySize: 50
  });
  const adaptiveStartedAt = performance.now();
  for (let iteration = 1; iteration <= iterations; iteration += 1) adaptive.evaluateFromMetrics(iteration);
  const adaptiveMs = performance.now() - adaptiveStartedAt;
  factory.close();
  console.log(`Phase 2A stats: ${(directMs / iterations * 1_000).toFixed(3)} microseconds/evaluation`);
  console.log(`Phase 2A + adaptive loop: ${(adaptiveMs / iterations * 1_000).toFixed(3)} microseconds/evaluation`);
  console.log(`Closed-loop evaluation overhead: ${((adaptiveMs - directMs) / directMs * 100).toFixed(2)}%`);
}

const results = [
  await run('Fixed low', 20),
  await run('Fixed high', 100),
  await run('Adaptive', 10)
];

console.table(results.map((result) => ({
  Strategy: result.strategy,
  Throughput: result.throughput.toFixed(1),
  SuccessRps: result.successfulThroughput.toFixed(1),
  P50ms: result.p50Ms.toFixed(1),
  P95ms: result.p95Ms.toFixed(1),
  P99ms: result.p99Ms.toFixed(1),
  ErrorRate: `${(result.errorRate * 100).toFixed(1)}%`,
  MaxConcurrency: result.maximumConcurrency,
  AvgConcurrency: result.averageConcurrency.toFixed(1),
  QueueWaitP95ms: result.queueWaitP95Ms.toFixed(1),
  LimitChanges: result.limitChanges,
  Convergence: result.convergenceEvaluation ?? 'n/a',
  Oscillations: result.oscillations,
  HeapDeltaBytes: result.heapDeltaBytes
})));

measureControllerOverhead();
