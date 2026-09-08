import { createFactory } from '../factory.js';
import { createMetricsExporter } from '../observability.js';

const operations = 25_000;
const rounds = 7;
await measure(false, 5_000);
await measure(true, 5_000);
const baselineSamples: number[] = [];
const instrumentedSamples: number[] = [];
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? [false, true] : [true, false];
  for (const withExporter of order) {
    const result = await measure(withExporter, operations);
    (withExporter ? instrumentedSamples : baselineSamples).push(result.durationMs);
  }
}
const baseline = summarize(baselineSamples);
const instrumented = summarize(instrumentedSamples);
const overhead = ((instrumented.durationMs / baseline.durationMs) - 1) * 100;
console.table([
  { mode: 'controller', operations, rounds, medianDurationMs: baseline.durationMs, medianOperationsPerSecond: baseline.operationsPerSecond },
  { mode: 'controller + attached exporter', operations, rounds, medianDurationMs: instrumented.durationMs, medianOperationsPerSecond: instrumented.operationsPerSecond }
]);
console.log(`Attached-but-idle observability median overhead: ${overhead.toFixed(2)}%`);
console.log('The exporter is not called by run(); attaching it adds no controller hot-path hook.');

async function measure(withExporter: boolean, count: number): Promise<{ durationMs: number; operationsPerSecond: number }> {
  const factory = createFactory();
  const controller = factory.concurrency({ name: withExporter ? 'observed' : 'baseline', limit: 100, maxQueueSize: count });
  const exporter = withExporter ? createMetricsExporter(controller, { export: () => undefined }) : undefined;
  const started = performance.now();
  await Promise.all(Array.from({ length: count }, () => controller.run(() => undefined)));
  const durationMs = performance.now() - started;
  exporter?.dispose();
  await controller.close();
  factory.close();
  return { durationMs, operationsPerSecond: count / (durationMs / 1_000) };
}

function summarize(samples: number[]): { durationMs: number; operationsPerSecond: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  const durationMs = ordered[Math.floor(ordered.length / 2)];
  return { durationMs, operationsPerSecond: operations / (durationMs / 1_000) };
}
