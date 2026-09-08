import assert from 'node:assert/strict';
import test from 'node:test';
import { ControllerAbortError, ControllerTimeoutError, createFactory } from '../index.js';

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

function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test('already-aborted work rejects without entering execution or the queue', async () => {
  const controller = createFactory().concurrency({ name: 'already-aborted', limit: 1 });
  const abort = new AbortController();
  abort.abort();
  let executed = false;
  await assert.rejects(
    controller.run(() => { executed = true; }, { signal: abort.signal }),
    ControllerAbortError
  );
  assert.equal(executed, false);
  assert.equal(controller.stats().active, 0);
  assert.equal(controller.stats().queued, 0);
  assert.equal(controller.stats().rejected, 1);
});

test('queued cancellation removes work immediately and preserves FIFO order', async () => {
  const controller = createFactory().concurrency({ name: 'queued-cancellation', limit: 1 });
  const releaseFirst = gate();
  const releaseSecond = gate();
  const started: string[] = [];
  const first = controller.run(async () => { started.push('A'); await releaseFirst.wait; });
  const second = controller.run(async () => { started.push('B'); await releaseSecond.wait; });
  const cancelMiddle = new AbortController();
  let middleRan = false;
  const middle = controller.run(() => { middleRan = true; }, { signal: cancelMiddle.signal });
  const fourth = controller.run(() => { started.push('D'); });
  await flush();
  cancelMiddle.abort();
  await assert.rejects(middle, ControllerAbortError);
  assert.equal(middleRan, false);
  assert.equal(controller.stats().queued, 2);
  releaseFirst.open();
  await first;
  await flush();
  assert.deepEqual(started, ['A', 'B']);
  releaseSecond.open();
  await Promise.all([second, fourth]);
  assert.deepEqual(started, ['A', 'B', 'D']);
  assert.equal(controller.stats().active, 0);
  assert.equal(controller.stats().queued, 0);
});

test('active cancellation is cooperative and retains its slot until task settlement', async () => {
  const controller = createFactory().concurrency({ name: 'active-cancellation', limit: 1 });
  const abort = new AbortController();
  const release = gate();
  let signal: AbortSignal | undefined;
  const task = controller.run(async (context) => {
    signal = context.signal;
    await release.wait;
    throw context.signal.reason;
  }, { signal: abort.signal });
  await flush();
  abort.abort();
  assert.equal(signal?.aborted, true);
  assert.equal(controller.stats().active, 1);
  release.open();
  await assert.rejects(task, ControllerAbortError);
  assert.equal(controller.stats().active, 0);
  assert.equal(controller.stats().failed, 0);
});

test('execution timeout aborts only after admission and retains the slot until settlement', async () => {
  const controller = createFactory().concurrency({ name: 'execution-timeout', limit: 1 });
  const release = gate();
  const active = controller.run(() => release.wait);
  let started = false;
  const timed = controller.run(async ({ signal }) => {
    started = true;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 10 });
  await wait(20);
  assert.equal(started, false);
  assert.equal(controller.stats().queued, 1);
  release.open();
  await active;
  await assert.rejects(timed, ControllerTimeoutError);
  assert.equal(controller.stats().active, 0);
  assert.equal(controller.stats().failed, 1);
});

test('normal completion and caller cancellation clean up execution timeout resources', async () => {
  const controller = createFactory().concurrency({ name: 'timeout-cleanup', limit: 1 });
  let completedSignal: AbortSignal | undefined;
  await controller.run(({ signal }) => {
    completedSignal = signal;
  }, { timeoutMs: 10 });
  await wait(20);
  assert.equal(completedSignal?.aborted, false);

  const abort = new AbortController();
  let cancelledSignal: AbortSignal | undefined;
  const cancelled = controller.run(async ({ signal }) => {
    cancelledSignal = signal;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { signal: abort.signal, timeoutMs: 30 });
  await flush();
  abort.abort();
  await assert.rejects(cancelled, ControllerAbortError);
  await wait(40);
  assert.ok(cancelledSignal?.reason instanceof ControllerAbortError);
  assert.ok(!(cancelledSignal?.reason instanceof ControllerTimeoutError));
});

test('cancellation composes with graceful drain and existing zero-argument tasks', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'drain-cancellation-work', limit: 1 });
  const limiter = factory.adaptiveConcurrency({ name: 'drain-cancellation-control', controller: work, minLimit: 1, maxLimit: 5, targetP95Ms: 100, maxErrorRate: 0.01 });
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const release = gate();
  let activeSignal: AbortSignal | undefined;
  const active = work.run(async ({ signal }) => {
    activeSignal = signal;
    await release.wait;
    if (signal.aborted) throw signal.reason;
  }, { signal: activeAbort.signal });
  const queued = work.run(() => 'never', { signal: queuedAbort.signal });
  const closing = limiter.close();
  queuedAbort.abort();
  await assert.rejects(queued, ControllerAbortError);
  activeAbort.abort();
  assert.equal(activeSignal?.aborted, true);
  let closed = false;
  void closing.then(() => { closed = true; });
  await flush();
  assert.equal(closed, false);
  release.open();
  await assert.rejects(active, ControllerAbortError);
  await closing;
  assert.equal(limiter.lifecycle(), 'closed');
  assert.equal(await createFactory().concurrency({ name: 'compatible', limit: 1 }).run(() => 'ok'), 'ok');
});

test('rejects invalid execution timeouts before accepting work', () => {
  const controller = createFactory().concurrency({ name: 'invalid-timeout', limit: 1 });
  assert.throws(() => controller.run(() => undefined, { timeoutMs: 0 }), /timeoutMs/);
  assert.equal(controller.stats().accepted, 0);
});
