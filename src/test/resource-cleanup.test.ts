import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedConcurrencyController } from '../concurrency-controller.js';
import { BulkheadQueueFullError, CircuitBreakerOpenError, ControllerAbortError, ControllerTimeoutError } from '../concurrency-errors.js';

interface Gate { wait: Promise<void>; open(): void }

function gate(): Gate {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function assertClean(controller: FixedConcurrencyController): void {
  const state = controller.debugStateForTests();
  assert.equal(state.active, 0);
  assert.equal(state.queued, 0);
  assert.equal(state.linkedQueueNodes, 0);
  assert.equal(state.executionTimers, 0);
  assert.equal(state.queueTimers, 0);
  assert.equal(state.retryTimers, 0);
  assert.equal(state.abortListeners, 0);
  assert.equal(state.pendingRetryChains, 0);
  for (const partition of state.partitions) {
    assert.equal(partition.active, 0);
    assert.equal(partition.queued, 0);
    assert.equal(partition.hasHead, false);
    assert.equal(partition.hasTail, false);
  }
}

test('execution timers and active abort listeners are released on success, failure, cancellation, and timeout', async () => {
  const controller = new FixedConcurrencyController('cleanup-execution', { limit: 1 });
  const successAbort = new AbortController();
  await controller.run(() => undefined, { signal: successAbort.signal, timeoutMs: 20 });
  await assert.rejects(controller.run(() => { throw new Error('failure'); }, { signal: new AbortController().signal, timeoutMs: 20 }), /failure/);

  const cancel = new AbortController();
  const cancelled = controller.run(async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { signal: cancel.signal, timeoutMs: 20 });
  cancel.abort();
  await assert.rejects(cancelled, ControllerAbortError);

  await assert.rejects(controller.run(async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 2 }), ControllerTimeoutError);
  await controller.close();
  assertClean(controller);
});

test('queued cancellation removes its timer, listener, and exact linked node', async () => {
  const controller = new FixedConcurrencyController('cleanup-queued', {
    limit: 1, maxQueueWaitMs: 50, bulkheads: { A: { maxConcurrent: 1, maxQueue: 4 }, B: { maxConcurrent: 1, maxQueue: 4 } }
  });
  const release = gate();
  const active = controller.run(() => release.wait, { bulkhead: 'A' });
  const abort = new AbortController();
  const cancelled = controller.run(() => undefined, { bulkhead: 'A', signal: abort.signal });
  const other = controller.run(() => undefined, { bulkhead: 'B' });
  assert.equal(controller.debugStateForTests().linkedQueueNodes, 2);
  abort.abort();
  await assert.rejects(cancelled, ControllerAbortError);
  assert.equal(controller.debugStateForTests().linkedQueueNodes, 1);
  release.open();
  await Promise.all([active, other]);
  await controller.close();
  assertClean(controller);
});

test('queue wait timeout releases queue node and timer without callback execution', async () => {
  const controller = new FixedConcurrencyController('cleanup-queue-timeout', { limit: 1, maxQueueWaitMs: 2 });
  const release = gate();
  const active = controller.run(() => release.wait);
  let ran = false;
  await assert.rejects(controller.run(() => { ran = true; }), /maxQueueWaitMs/);
  assert.equal(ran, false);
  assert.equal(controller.debugStateForTests().queueTimers, 0);
  assert.equal(controller.debugStateForTests().linkedQueueNodes, 0);
  release.open();
  await active;
  await controller.close();
  assertClean(controller);
});

test('cancelling retry delay clears its timer and abort listener', async () => {
  const controller = new FixedConcurrencyController('cleanup-retry-cancel', { limit: 1 });
  const abort = new AbortController();
  const run = controller.run(() => { throw new Error('retry'); }, { signal: abort.signal, retry: { attempts: 2, delayMs: 50 } });
  await flush();
  assert.equal(controller.debugStateForTests().retryTimers, 1);
  abort.abort();
  await assert.rejects(run, ControllerAbortError);
  await controller.close();
  assertClean(controller);
});

test('close waits for an accepted retry delay and leaves no retry resources', async () => {
  const controller = new FixedConcurrencyController('cleanup-retry-close', { limit: 1 });
  let attempts = 0;
  const run = controller.run(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('retry');
  }, { retry: { attempts: 1, delayMs: 4 } });
  await flush();
  const closing = controller.close();
  assert.equal(controller.lifecycle(), 'draining');
  await Promise.all([run, closing]);
  assert.equal(attempts, 2);
  assertClean(controller);
});

test('breaker-open queued cleanup releases every partition endpoint and permits close', async () => {
  const controller = new FixedConcurrencyController('cleanup-breaker', {
    limit: 1,
    bulkheads: { A: { maxConcurrent: 1, maxQueue: 3 }, B: { maxConcurrent: 1, maxQueue: 3 } },
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 50 }
  });
  const release = gate();
  const failing = controller.run(async () => { await release.wait; throw new Error('down'); }, { bulkhead: 'A' });
  const a = controller.run(() => undefined, { bulkhead: 'A' });
  const b = controller.run(() => undefined, { bulkhead: 'B' });
  release.open();
  await assert.rejects(failing, /down/);
  await assert.rejects(a, CircuitBreakerOpenError);
  await assert.rejects(b, CircuitBreakerOpenError);
  await controller.close();
  assertClean(controller);
});

test('local rejection does not allocate queue nodes, listeners, or timers', async () => {
  const controller = new FixedConcurrencyController('cleanup-local-reject', {
    limit: 1, maxQueueWaitMs: 50, bulkheads: { A: { maxConcurrent: 1, maxQueue: 0 } }
  });
  const release = gate();
  const active = controller.run(() => release.wait, { bulkhead: 'A' });
  await assert.rejects(controller.run(() => undefined, { bulkhead: 'A', signal: new AbortController().signal }), BulkheadQueueFullError);
  const state = controller.debugStateForTests();
  assert.equal(state.linkedQueueNodes, 0);
  assert.equal(state.queueTimers, 0);
  assert.equal(state.abortListeners, 0);
  release.open();
  await active;
  await controller.close();
  assertClean(controller);
});

test('repeated create, mixed work, and close cycles return all internal resources to zero', async () => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const controller = new FixedConcurrencyController(`cleanup-cycle-${cycle}`, {
      limit: 3, maxQueueSize: 20, maxQueueWaitMs: 20, bulkheads: { fast: { maxConcurrent: 2, maxQueue: 10 }, slow: { maxConcurrent: 1, maxQueue: 10 } }
    });
    const work = Array.from({ length: 20 }, (_value, id) => controller.run(async () => {
      if (id % 7 === 0) throw new Error('expected');
      await Promise.resolve();
    }, { bulkhead: id % 3 === 0 ? 'slow' : 'fast', timeoutMs: 20, retry: { attempts: id % 7 === 0 ? 1 : 0 } }));
    await Promise.allSettled(work);
    await controller.close();
    assertClean(controller);
  }
});

test('each logical promise settles once and each retry attempt executes at most once', async () => {
  const controller = new FixedConcurrencyController('cleanup-settlement', { limit: 4, maxQueueSize: 100 });
  const attempts = new Set<string>();
  const settlements = new Map<number, number>();
  const work = Array.from({ length: 100 }, (_value, id) => controller.run(({ attempt }) => {
    const key = `${id}:${attempt}`;
    assert.equal(attempts.has(key), false);
    attempts.add(key);
    if (id % 5 === 0 && attempt === 1) throw new Error('retry');
    return id;
  }, { retry: { attempts: 1 } }).then(
    () => settlements.set(id, (settlements.get(id) ?? 0) + 1),
    () => settlements.set(id, (settlements.get(id) ?? 0) + 1)
  ));
  await Promise.all(work);
  assert.equal(settlements.size, 100);
  for (const count of settlements.values()) assert.equal(count, 1);
  await controller.close();
  assertClean(controller);
});

test('breaker cooldown remains timer-free through repeated open and recovery cycles', async () => {
  const controller = new FixedConcurrencyController('cleanup-breaker-cycles', {
    limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 2 }
  });
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await assert.rejects(controller.run(() => { throw new Error('down'); }), /down/);
    assert.equal(controller.debugStateForTests().executionTimers, 0);
    await delay(3);
    await controller.run(() => undefined);
  }
  await controller.close();
  assertClean(controller);
});
