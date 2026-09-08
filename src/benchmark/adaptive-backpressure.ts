import { createFactory } from '../index.js';

const CYCLES = 10_000;

function run(name: string, queueAware: boolean) {
  const factory = createFactory();
  const work = factory.concurrency({ name: `${name}-work`, limit: 10, maxQueueSize: 100 });
  const adaptive = factory.adaptiveConcurrency({
    name, controller: work, minLimit: 10, maxLimit: 100, targetP95Ms: 80, maxErrorRate: 0.01,
    mode: 'auto', evaluationIntervalMs: 1, increaseStep: 10, healthyEvaluations: 1, unhealthyEvaluations: 1, ewmaAlpha: 1,
    queuePressure: queueAware ? { maxUtilization: 0.8, maxQueueWaitP95Ms: 80, maxRejectionRate: 0.01, maxTimeoutRate: 0.01 } : undefined
  });
  const heapBefore = process.memoryUsage().heapUsed;
  let peak = 10; let min = 100; let pressureAction: number | null = null; let latencyAction: number | null = null;
  for (let window = 1; window <= CYCLES; window += 1) {
    const phase = window % 100;
    const spike = phase >= 30 && phase < 50;
    const slowdown = phase >= 70 && phase < 85;
    const limit = work.getLimit();
    const utilization = spike ? 0.95 : slowdown ? 0.85 : 0.2;
    const p95Ms = slowdown ? 120 : spike ? 60 : 30;
    const rejection = spike ? 0.03 : 0;
    const decision = adaptive.evaluate({ timestamp: window, currentLimit: limit, active: limit, queued: Math.round(utilization * 100), throughput: spike ? 800 : limit * 100, p95Ms, errorRate: 0, queueUtilization: utilization, queueWaitP95Ms: spike ? 100 : 10, queueRejectionRate: rejection, queueTimeoutRate: 0 });
    if (spike && decision.action !== 'hold' && pressureAction === null) pressureAction = window;
    if (p95Ms > 80 && decision.action === 'decrease' && latencyAction === null) latencyAction = window;
    peak = Math.max(peak, work.getLimit()); min = Math.min(min, work.getLimit());
    if (!Number.isFinite(work.getLimit()) || work.getLimit() < 10 || work.getLimit() > 100) throw new Error('invalid limit');
  }
  const stats = adaptive.stats();
  const result = { strategy: name, finalLimit: work.getLimit(), peak, min, changes: stats.limitChanges, increases: stats.increases, decreases: stats.decreases, holds: stats.holds, history: stats.history.length, heapDelta: process.memoryUsage().heapUsed - heapBefore, firstPressureAction: pressureAction, firstLatencyBackoff: latencyAction };
  factory.close(); return result;
}

const started = performance.now();
const latencyOnly = run('Latency-only', false);
const queueAware = run('Queue-aware', true);
const elapsed = performance.now() - started;
console.table([latencyOnly, queueAware]);
console.log(`Stability cycles per strategy: ${CYCLES}; total evaluation cost: ${(elapsed / (CYCLES * 2) * 1000).toFixed(3)} microseconds/evaluation`);
console.log(`Queue-aware protective action lead: ${latencyOnly.firstLatencyBackoff === null || queueAware.firstPressureAction === null ? 'n/a' : latencyOnly.firstLatencyBackoff - queueAware.firstPressureAction} windows`);
