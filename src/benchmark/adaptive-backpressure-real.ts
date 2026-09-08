import { QueueFullError, QueueWaitTimeoutError, createFactory } from '../index.js';

async function run(strategy: 'Latency-only' | 'Queue-aware') {
  const factory = createFactory();
  const controller = factory.concurrency({ name: `${strategy}-work`, limit: 10, maxQueueSize: 100, maxQueueWaitMs: 120 });
  const adaptive = factory.adaptiveConcurrency({ name: strategy, controller, minLimit: 10, maxLimit: 100, targetP95Ms: 80, maxErrorRate: .01, mode: 'auto', evaluationIntervalMs: 1, increaseStep: 10, healthyEvaluations: 1, unhealthyEvaluations: 1, ewmaAlpha: 1, queuePressure: strategy === 'Queue-aware' ? { maxUtilization: .8, maxQueueWaitP95Ms: 80, maxRejectionRate: .01, maxTimeoutRate: .01 } : undefined });
  let resourceActive = 0, submitted = 0, successful = 0, rejected = 0, timedOut = 0, errors = 0, maxActive = 0, maxQueue = 0;
  const latencies: number[] = [], limits: number[] = [], utilizations: number[] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  for (let window = 1; window <= 18; window += 1) {
    const spike = window >= 6 && window <= 10, slowdown = window >= 13 && window <= 15;
    const offered = spike ? 220 : 45, multiplier = slowdown ? 2.5 : 1;
    const work = Array.from({ length: offered }, async (_, index) => {
      submitted += 1; const started = performance.now();
      try { await controller.run(async () => { resourceActive += 1; const active = resourceActive; maxActive = Math.max(maxActive, active); let delay = 5; if (active > 30 && active <= 50) delay += (active - 30) * .5; else if (active > 50 && active <= 70) delay = 15 + (active - 50) * 1.5; else if (active > 70) delay = 45 + (active - 70) * 2; await new Promise<void>((resolve) => setTimeout(resolve, delay * multiplier)); resourceActive -= 1; if (active > 70 && index % 7 === 0) throw new Error('saturated'); }); successful += 1; }
      catch (error) { if (error instanceof QueueFullError) rejected += 1; else if (error instanceof QueueWaitTimeoutError) timedOut += 1; else errors += 1; }
      finally { latencies.push(performance.now() - started); }
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const metrics = controller.stats();
    maxQueue = Math.max(maxQueue, metrics.queued);
    utilizations.push(metrics.queueUtilization);
    limits.push(controller.getLimit());
    adaptive.evaluateFromMetrics(window);
    await Promise.all(work);
  }
  const stats = controller.stats(), control = adaptive.stats(), sorted = [...latencies].sort((a, b) => a - b), p = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
  const result = { strategy, submitted, successful, p50: p(.5), p95: p(.95), p99: p(.99), queueWaitP95: stats.queueWait.p95Ms, rejected, timedOut, errors, maxActive, maxQueue, avgQueueUtilization: utilizations.reduce((a,b)=>a+b,0)/utilizations.length, maxQueueUtilization: Math.max(...utilizations), avgLimit: limits.reduce((a,b)=>a+b,0)/limits.length, peakLimit: Math.max(...limits), limitChanges: control.limitChanges, increases: control.increases, decreases: control.decreases, holds: control.holds, heapBefore, heapAfter: process.memoryUsage().heapUsed, heapDelta: process.memoryUsage().heapUsed - heapBefore };
  factory.close(); return result;
}

console.table([await run('Latency-only'), await run('Queue-aware')]);
