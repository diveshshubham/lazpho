import { createFactory } from '../index.js';

const SUBMITTED = 1_000;

async function run(name: string, maxQueueSize: number, maxQueueWaitMs?: number) {
  const factory = createFactory();
  const controller = factory.concurrency({ name, limit: 50, maxQueueSize, maxQueueWaitMs });
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  let completed = 0;
  await Promise.all(Array.from({ length: SUBMITTED }, async () => {
    try {
      await controller.run(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      completed += 1;
    } catch { }
  }));
  const durationMs = performance.now() - startedAt;
  const stats = controller.stats();
  const result = {
    strategy: name,
    completed,
    throughput: completed / (durationMs / 1_000),
    p95QueueWaitMs: stats.queueWait.p95Ms,
    maxQueueSize,
    rejected: stats.rejectedQueueFull,
    timedOut: stats.queueTimedOut,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    recoveryMs: durationMs
  };
  factory.close();
  return result;
}

console.table([
  await run('Large queue', SUBMITTED),
  await run('Bounded backpressure', 100, 100)
]);
