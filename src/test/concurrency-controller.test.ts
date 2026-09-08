import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueAbortedError, QueueFullError, QueueWaitTimeoutError, createFactory } from '../index.js';

interface Gate {
  wait: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, open: release };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('never exceeds its fixed concurrency limit', async () => {
  const controller = createFactory().concurrency({ name: 'limited', limit: 2 });
  const release = gate();
  let active = 0;
  let maximum = 0;
  const operations = Array.from({ length: 5 }, () => controller.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await release.wait;
    active -= 1;
  }));
  await flush();
  assert.equal(active, 2);
  assert.equal(controller.stats().queued, 3);
  release.open();
  await Promise.all(operations);
  assert.equal(maximum, 2);
  assert.equal(controller.stats().completed, 5);
});

test('starts queued operations in FIFO order', async () => {
  const controller = createFactory().concurrency({ name: 'fifo', limit: 1 });
  const release = gate();
  const started: number[] = [];
  const first = controller.run(async () => { started.push(1); await release.wait; });
  const second = controller.run(() => { started.push(2); });
  const third = controller.run(() => { started.push(3); });
  await flush();
  assert.deepEqual(started, [1]);
  release.open();
  await Promise.all([first, second, third]);
  assert.deepEqual(started, [1, 2, 3]);
});

test('releases slots when operations fail and propagates the error', async () => {
  const controller = createFactory().concurrency({ name: 'errors', limit: 1 });
  const failure = controller.run(() => { throw new Error('expected'); });
  const afterFailure = controller.run(() => 'continued');
  await assert.rejects(failure, /expected/);
  assert.equal(await afterFailure, 'continued');
  const stats = controller.stats();
  assert.equal(stats.completed, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.active, 0);
});

test('increasing a limit immediately starts queued work', async () => {
  const controller = createFactory().concurrency({ name: 'increase', limit: 1 });
  const release = gate();
  let active = 0;
  const first = controller.run(async () => { active += 1; await release.wait; active -= 1; });
  const second = controller.run(async () => { active += 1; await release.wait; active -= 1; });
  const third = controller.run(async () => { active += 1; await release.wait; active -= 1; });
  await flush();
  assert.equal(active, 1);
  controller.setLimit(3);
  await flush();
  assert.equal(active, 3);
  release.open();
  await Promise.all([first, second, third]);
});

test('decreasing a limit lets active work finish but holds queued work', async () => {
  const controller = createFactory().concurrency({ name: 'decrease', limit: 4 });
  const releases = [gate(), gate(), gate(), gate(), gate()];
  const fifthStarted = gate();
  const started: number[] = [];
  const operations = releases.map((release, index) => controller.run(async () => {
    started.push(index);
    if (index === 4) fifthStarted.open();
    await release.wait;
  }));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  controller.setLimit(2);
  releases[0].open();
  releases[1].open();
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases[2].open();
  await fifthStarted.wait;
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases[3].open();
  releases[4].open();
  await Promise.all(operations);
});

test('rejects additional work when the bounded queue is full', async () => {
  const controller = createFactory().concurrency({ name: 'bounded', limit: 1, maxQueueSize: 1 });
  const release = gate();
  const first = controller.run(() => release.wait);
  const second = controller.run(() => undefined);
  await assert.rejects(controller.run(() => undefined), QueueFullError);
  assert.equal(controller.stats().rejected, 1);
  release.open();
  await Promise.all([first, second]);
});

test('removes an aborted queued operation without using a slot', async () => {
  const controller = createFactory().concurrency({ name: 'abort', limit: 1 });
  const release = gate();
  const signal = new AbortController();
  const first = controller.run(() => release.wait);
  const cancelled = controller.run(() => 'never', { signal: signal.signal });
  signal.abort();
  await assert.rejects(cancelled, QueueAbortedError);
  assert.equal(controller.stats().queued, 0);
  assert.equal(controller.stats().rejected, 1);
  release.open();
  await first;
});

test('rejects queued work after its configured maximum wait without running it', async () => {
  const controller = createFactory().concurrency({ name: 'timeout', limit: 1, maxQueueSize: 2, maxQueueWaitMs: 20 });
  const release = gate();
  let timedOutOperationRan = false;
  const first = controller.run(() => release.wait);
  const timedOut = controller.run(() => { timedOutOperationRan = true; });
  await assert.rejects(timedOut, (error: unknown) => error instanceof QueueWaitTimeoutError && error.code === 'FACTORY_QUEUE_WAIT_TIMEOUT');
  assert.equal(timedOutOperationRan, false);
  assert.equal(controller.stats().queued, 0);
  assert.equal(controller.stats().queueTimedOut, 1);
  release.open();
  await first;
});

test('reports bounded backpressure metrics and distinct full-queue errors', async () => {
  const controller = createFactory().concurrency({ name: 'backpressure', limit: 1, maxQueueSize: 1 });
  const release = gate();
  const first = controller.run(() => release.wait);
  const queued = controller.run(() => undefined);
  await assert.rejects(controller.run(() => undefined), (error: unknown) => error instanceof QueueFullError && error.code === 'FACTORY_BACKPRESSURE_REJECTED');
  const stats = controller.stats();
  assert.equal(stats.maxQueueSize, 1);
  assert.equal(stats.queueUtilization, 1);
  assert.equal(stats.rejectedQueueFull, 1);
  assert.ok(stats.queueRejectionRate > 0);
  release.open();
  await Promise.all([first, queued]);
});

test('keeps controller metrics independent and exposes them globally', async () => {
  const factory = createFactory();
  const orders = factory.concurrency({ name: 'orders', limit: 1 });
  const payments = factory.concurrency({ name: 'payments', limit: 2 });
  await Promise.all([orders.run(() => undefined), payments.run(() => undefined), payments.run(() => undefined)]);
  assert.equal(factory.getConcurrencyMetrics('orders')?.completed, 1);
  assert.equal(factory.getMetrics().controllers.payments?.completed, 2);
  assert.equal(orders.stats().limit, 1);
});

test('records concurrency timing metrics', async () => {
  const controller = createFactory().concurrency({ name: 'timing', limit: 1 });
  const release = gate();
  const first = controller.run(() => release.wait);
  const second = controller.run(() => undefined);
  await flush();
  release.open();
  await Promise.all([first, second]);
  const stats = controller.stats();
  assert.equal(stats.completed, 2);
  assert.ok(stats.execution.averageMs >= 0);
  assert.ok(stats.total.averageMs >= stats.execution.averageMs);
  assert.ok(stats.queueWait.p50Ms >= 0);
});

test('stress test preserves the configured limits', async () => {
  for (const limit of [10, 50, 100, 500]) {
    const controller = createFactory().concurrency({ name: `stress-${limit}`, limit, maxQueueSize: 1_000 });
    let active = 0;
    let maximum = 0;
    const operations = Array.from({ length: 1_000 }, () => controller.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    }));
    await Promise.all(operations);
    assert.ok(maximum <= limit);
    assert.equal(controller.stats().completed, 1_000);
    assert.equal(controller.stats().failed, 0);
  }
});
