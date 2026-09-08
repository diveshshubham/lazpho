import { createFactory } from '../index.js';

const ITERATIONS = 1_000_000;
const factory = createFactory();
const controller = factory.adaptiveConcurrency({
  name: 'benchmark',
  minLimit: 10,
  maxLimit: 200,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  evaluationIntervalMs: 1,
  healthyEvaluations: 1
});

const heapBefore = process.memoryUsage().heapUsed;
const startedAt = performance.now();
for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
  controller.evaluate({
    timestamp: iteration,
    currentLimit: 50,
    active: 50,
    queued: 0,
    throughput: 1_000 + iteration % 10,
    p95Ms: 100,
    errorRate: 0
  });
}
const durationMs = performance.now() - startedAt;
const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
factory.close();
console.log(`Adaptive decisions: ${ITERATIONS}`);
console.log(`Duration: ${durationMs.toFixed(2)} ms`);
console.log(`Decisions per second: ${(ITERATIONS / (durationMs / 1_000)).toFixed(0)}`);
console.log(`Average evaluation: ${(durationMs / ITERATIONS * 1_000).toFixed(3)} microseconds`);
console.log(`Heap delta: ${heapDeltaBytes} bytes`);
