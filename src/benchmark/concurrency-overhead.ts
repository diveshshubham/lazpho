import { createFactory } from '../index.js';

const ITERATIONS = 50_000;
const LIMIT = 100;

async function benchmark(label: string, run: () => Promise<void>): Promise<{ durationMs: number; throughput: number; heapDeltaBytes: number }> {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  await run();
  const durationMs = performance.now() - startedAt;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const throughput = ITERATIONS / (durationMs / 1_000);
  console.log(`${label}: ${durationMs.toFixed(2)} ms, ${throughput.toFixed(0)} operations/s, heap delta ${heapDeltaBytes} bytes`);
  return { durationMs, throughput, heapDeltaBytes };
}

const baseline = await benchmark('Direct async execution', async () => {
  await Promise.all(Array.from({ length: ITERATIONS }, async () => undefined));
});

const factory = createFactory();
const controller = factory.concurrency({ name: 'benchmark', limit: LIMIT, maxQueueSize: ITERATIONS });
const controlled = await benchmark(`Controlled execution (limit ${LIMIT})`, async () => {
  await Promise.all(Array.from({ length: ITERATIONS }, () => controller.run(async () => undefined)));
});
factory.close();

const overheadPercent = ((controlled.durationMs - baseline.durationMs) / baseline.durationMs) * 100;
console.log(`Controller overhead: ${overheadPercent.toFixed(2)}%`);
console.log('This benchmark measures controller cost in an unconstrained workload. A limiter protects constrained downstream resources; it does not inherently increase throughput.');
