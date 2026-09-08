import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BulkheadQueueFullError,
  CircuitBreakerOpenError,
  ControllerAbortError,
  ControllerLifecycleError,
  QueueFullError,
  QueueWaitTimeoutError,
  UnknownBulkheadError,
  createFactory
} from '../index.js';

interface Gate { wait: Promise<void>; open(): void }

function gate(): Gate {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, open: release };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test('validates construction-time bulkhead configuration', () => {
  const factory = createFactory();
  assert.throws(() => factory.concurrency({ name: 'empty-bulkhead', limit: 1, bulkheads: { '': { maxConcurrent: 1, maxQueue: 1 } } }), /Bulkhead name/);
  assert.throws(() => factory.concurrency({ name: 'bad-concurrency', limit: 1, bulkheads: { A: { maxConcurrent: 0, maxQueue: 1 } } }), /maxConcurrent/);
  assert.throws(() => factory.concurrency({ name: 'bad-queue', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: -1 } } }), /maxQueue/);
});

test('enforces local and global concurrency limits across bulkheads', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-limits', limit: 5, bulkheads: { A: { maxConcurrent: 2, maxQueue: 20 }, B: { maxConcurrent: 3, maxQueue: 20 } }
  });
  let activeA = 0;
  let activeB = 0;
  let peakA = 0;
  let peakB = 0;
  let peakGlobal = 0;
  const run = (bulkhead: 'A' | 'B') => work.run(async () => {
    if (bulkhead === 'A') activeA += 1; else activeB += 1;
    peakA = Math.max(peakA, activeA);
    peakB = Math.max(peakB, activeB);
    peakGlobal = Math.max(peakGlobal, activeA + activeB);
    await delay(2);
    if (bulkhead === 'A') activeA -= 1; else activeB -= 1;
  }, { bulkhead });
  await Promise.all([...Array.from({ length: 10 }, () => run('A')), ...Array.from({ length: 10 }, () => run('B'))]);
  assert.ok(peakA <= 2);
  assert.ok(peakB <= 3);
  assert.ok(peakGlobal <= 5);
});

test('locally blocked queue cannot head-of-line block another partition', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-hol', limit: 2, bulkheads: { A: { maxConcurrent: 1, maxQueue: 5 }, B: { maxConcurrent: 1, maxQueue: 5 } }
  });
  const releaseA = gate();
  const releaseB = gate();
  const started: string[] = [];
  const a1 = work.run(async () => { started.push('A1'); await releaseA.wait; }, { bulkhead: 'A' });
  const a2 = work.run(() => { started.push('A2'); }, { bulkhead: 'A' });
  const b1 = work.run(async () => { started.push('B1'); await releaseB.wait; }, { bulkhead: 'B' });
  await flush();
  assert.deepEqual(started, ['A1', 'B1']);
  assert.equal(work.stats().bulkheads.A.queued, 1);
  releaseB.open();
  await b1;
  assert.deepEqual(started, ['A1', 'B1']);
  releaseA.open();
  await Promise.all([a1, a2]);
});

test('rotating runnable selection gives continuously queued partitions progress', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-rotation', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: 20 }, B: { maxConcurrent: 1, maxQueue: 20 } }
  });
  const firstGate = gate();
  const first = work.run(() => firstGate.wait, { bulkhead: 'A' });
  const order: string[] = [];
  const queued = [
    ...Array.from({ length: 5 }, () => work.run(() => { order.push('A'); }, { bulkhead: 'A' })),
    ...Array.from({ length: 5 }, () => work.run(() => { order.push('B'); }, { bulkhead: 'B' }))
  ];
  firstGate.open();
  await Promise.all([first, ...queued]);
  assert.ok(order.slice(0, 5).includes('A'));
  assert.ok(order.slice(0, 5).includes('B'));
  assert.equal(order.filter((value) => value === 'A').length, 5);
  assert.equal(order.filter((value) => value === 'B').length, 5);
});

test('local queue capacity rejects independently from aggregate capacity', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-local-queue', limit: 1, maxQueueSize: 100, bulkheads: { A: { maxConcurrent: 1, maxQueue: 2 } } });
  const release = gate();
  const a1 = work.run(() => release.wait, { bulkhead: 'A' });
  const a2 = work.run(() => undefined, { bulkhead: 'A' });
  const a3 = work.run(() => undefined, { bulkhead: 'A' });
  await assert.rejects(work.run(() => undefined, { bulkhead: 'A' }), BulkheadQueueFullError);
  assert.equal(work.stats().bulkheadRejected, 1);
  assert.equal(work.stats().bulkheads.A.rejected, 1);
  assert.equal(work.stats().queued, 2);
  release.open();
  await Promise.all([a1, a2, a3]);
});

test('global queue capacity remains aggregate across local queues', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-global-queue', limit: 1, maxQueueSize: 3, bulkheads: { A: { maxConcurrent: 1, maxQueue: 10 }, B: { maxConcurrent: 1, maxQueue: 10 } }
  });
  const release = gate();
  const active = work.run(() => release.wait, { bulkhead: 'A' });
  const queued = [
    work.run(() => undefined, { bulkhead: 'A' }),
    work.run(() => undefined, { bulkhead: 'B' }),
    work.run(() => undefined, { bulkhead: 'B' })
  ];
  await assert.rejects(work.run(() => undefined, { bulkhead: 'A' }), QueueFullError);
  assert.equal(work.stats().queued, 3);
  release.open();
  await Promise.all([active, ...queued]);
});

test('unknown bulkheads reject without executing or changing admission counters', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-unknown', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: 1 } } });
  let ran = false;
  await assert.rejects(work.run(() => { ran = true; }, { bulkhead: 'missing' }), UnknownBulkheadError);
  assert.equal(ran, false);
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().queued, 0);
  assert.equal(work.stats().accepted, 0);
});

test('queued cancellation unlinks only its partition and preserves other FIFO queues', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-queued-cancel', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: 5 }, B: { maxConcurrent: 1, maxQueue: 5 } }
  });
  const release = gate();
  const active = work.run(() => release.wait, { bulkhead: 'A' });
  const abort = new AbortController();
  let cancelledRan = false;
  const cancelled = work.run(() => { cancelledRan = true; }, { bulkhead: 'A', signal: abort.signal });
  const order: string[] = [];
  const b1 = work.run(() => { order.push('B1'); }, { bulkhead: 'B' });
  const b2 = work.run(() => { order.push('B2'); }, { bulkhead: 'B' });
  abort.abort();
  await assert.rejects(cancelled, ControllerAbortError);
  assert.equal(work.stats().bulkheads.A.queued, 0);
  assert.equal(work.stats().bulkheads.B.queued, 2);
  release.open();
  await Promise.all([active, b1, b2]);
  assert.equal(cancelledRan, false);
  assert.deepEqual(order, ['B1', 'B2']);
});

test('active cancellation retains global and local slots until underlying settlement', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-active-cancel', limit: 2, bulkheads: { A: { maxConcurrent: 1, maxQueue: 2 } } });
  const abort = new AbortController();
  const release = gate();
  const active = work.run(async ({ signal }) => { await release.wait; throw signal.reason; }, { bulkhead: 'A', signal: abort.signal });
  await flush();
  abort.abort();
  assert.equal(work.stats().active, 1);
  assert.equal(work.stats().bulkheads.A.active, 1);
  release.open();
  await assert.rejects(active, ControllerAbortError);
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().bulkheads.A.active, 0);
});

test('queue wait timeout removes the exact local node', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-queue-timeout', limit: 1, maxQueueWaitMs: 5, bulkheads: { A: { maxConcurrent: 1, maxQueue: 2 } } });
  const release = gate();
  const active = work.run(() => release.wait, { bulkhead: 'A' });
  let ran = false;
  const queued = work.run(() => { ran = true; }, { bulkhead: 'A' });
  await assert.rejects(queued, QueueWaitTimeoutError);
  assert.equal(ran, false);
  assert.equal(work.stats().queued, 0);
  assert.equal(work.stats().bulkheads.A.queued, 0);
  release.open();
  await active;
});

test('retries retain their original bulkhead identity and local concurrency', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-retry', limit: 3, bulkheads: { A: { maxConcurrent: 1, maxQueue: 5 } } });
  let attempts = 0;
  let peakA = 0;
  const retrying = work.run(async () => {
    attempts += 1;
    peakA = Math.max(peakA, work.stats().bulkheads.A.active);
    if (attempts === 1) throw new Error('retry');
  }, { bulkhead: 'A', retry: { attempts: 1, delayMs: 2 } });
  await retrying;
  assert.equal(attempts, 2);
  assert.equal(peakA, 1);
  assert.equal(work.stats().retriesAttempted, 1);
});

test('a retry cannot bypass a saturated zero-length local queue', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-retry-full', limit: 2, bulkheads: { A: { maxConcurrent: 1, maxQueue: 0 } } });
  let attempts = 0;
  const retrying = work.run(() => {
    attempts += 1;
    throw new Error('retry');
  }, { bulkhead: 'A', retry: { attempts: 1, delayMs: 10 } });
  await delay(2);
  const release = gate();
  const occupying = work.run(() => release.wait, { bulkhead: 'A' });
  await assert.rejects(retrying, BulkheadQueueFullError);
  assert.equal(attempts, 1);
  release.open();
  await occupying;
});

test('breaker-open queued partitions release accounting and do not stall close', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-breaker-queued',
    limit: 1,
    bulkheads: { A: { maxConcurrent: 1, maxQueue: 3 }, B: { maxConcurrent: 1, maxQueue: 3 } },
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 100 }
  });
  const release = gate();
  const failing = work.run(async () => { await release.wait; throw new Error('down'); }, { bulkhead: 'A' });
  let aRan = false;
  let bRan = false;
  const queuedA = work.run(() => { aRan = true; }, { bulkhead: 'A' });
  const queuedB = work.run(() => { bRan = true; }, { bulkhead: 'B' });
  const closing = work.close();
  release.open();
  await assert.rejects(failing, /down/);
  await assert.rejects(queuedA, CircuitBreakerOpenError);
  await assert.rejects(queuedB, CircuitBreakerOpenError);
  await closing;
  assert.equal(aRan, false);
  assert.equal(bRan, false);
  assert.equal(work.stats().queued, 0);
  assert.equal(work.lifecycle(), 'closed');
});

test('runtime limit lowering pauses all partitions until global capacity is safe', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-lower-limit', limit: 3, bulkheads: { A: { maxConcurrent: 3, maxQueue: 5 }, B: { maxConcurrent: 3, maxQueue: 5 } }
  });
  const releases = [gate(), gate(), gate()];
  const active = releases.map((release, index) => work.run(() => release.wait, { bulkhead: index === 2 ? 'B' : 'A' }));
  let queuedRan = false;
  const queued = work.run(() => { queuedRan = true; }, { bulkhead: 'B' });
  work.setLimit(1);
  releases[0].open();
  releases[1].open();
  await flush();
  assert.equal(queuedRan, false);
  releases[2].open();
  await Promise.all(active);
  await queued;
  assert.equal(queuedRan, true);
});

test('shutdown drains default and named partitions with one lifecycle', async () => {
  const work = createFactory().concurrency({
    name: 'bulkhead-close', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: 5 }, B: { maxConcurrent: 1, maxQueue: 5 } }
  });
  const release = gate();
  const accepted = [work.run(() => release.wait), work.run(() => undefined, { bulkhead: 'A' }), work.run(() => undefined, { bulkhead: 'B' })];
  const closing = work.close();
  assert.equal(work.close(), closing);
  await assert.rejects(work.run(() => undefined, { bulkhead: 'A' }), ControllerLifecycleError);
  release.open();
  await Promise.all(accepted);
  await closing;
  const stats = work.stats();
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.bulkheads.A.active + stats.bulkheads.B.active, 0);
  assert.equal(stats.bulkheads.A.queued + stats.bulkheads.B.queued, 0);
  assert.equal(work.lifecycle(), 'closed');
});

test('bulkhead metric snapshots are detached and immutable', async () => {
  const work = createFactory().concurrency({ name: 'bulkhead-stats', limit: 1, bulkheads: { A: { maxConcurrent: 1, maxQueue: 2 } } });
  const snapshot = work.stats().bulkheads;
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.A));
  assert.throws(() => { (snapshot.A as { active: number }).active = 99; }, TypeError);
  assert.equal(work.stats().bulkheads.A.active, 0);
});
