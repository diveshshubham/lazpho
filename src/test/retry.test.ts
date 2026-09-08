import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControllerAbortError,
  ControllerLifecycleError,
  ControllerTimeoutError,
  QueueFullError,
  createFactory
} from '../index.js';

function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('retries are opt-in and legacy zero-argument tasks remain unchanged', async () => {
  const work = createFactory().concurrency({ name: 'retry-default', limit: 1 });
  let calls = 0;
  await assert.rejects(work.run(() => { calls += 1; throw new Error('failed'); }), /failed/);
  assert.equal(calls, 1);
  assert.equal(await work.run(() => 'legacy'), 'legacy');
  assert.equal(work.stats().retriesAttempted, 0);
});

test('a normal task failure retries and a later success resolves once', async () => {
  const work = createFactory().concurrency({ name: 'retry-success', limit: 1 });
  const attempts: number[] = [];
  const result = await work.run(({ attempt }) => {
    attempts.push(attempt);
    if (attempt === 1) throw new Error('temporary');
    return 'recovered';
  }, { retry: { attempts: 2 } });
  assert.equal(result, 'recovered');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(work.stats().retriesAttempted, 1);
  assert.equal(work.stats().retrySuccesses, 1);
  assert.equal(work.stats().retryExhausted, 0);
});

test('retry exhaustion returns the final original task error with an exact bound', async () => {
  const work = createFactory().concurrency({ name: 'retry-exhaustion', limit: 1 });
  const failures = [new Error('first'), new Error('second'), new Error('final')];
  let calls = 0;
  await assert.rejects(
    work.run(() => { throw failures[calls++]; }, { retry: { attempts: 2 } }),
    (error: unknown) => error === failures[2]
  );
  assert.equal(calls, 3);
  assert.equal(work.stats().retriesAttempted, 2);
  assert.equal(work.stats().retryExhausted, 1);
});

test('retry predicate can decline a normal task failure', async () => {
  const work = createFactory().concurrency({ name: 'retry-predicate', limit: 1 });
  let calls = 0;
  await assert.rejects(work.run(() => { calls += 1; throw new Error('no retry'); }, {
    retry: { attempts: 3, shouldRetry: (_error, attempt) => attempt !== 1 }
  }), /no retry/);
  assert.equal(calls, 1);
});

test('caller cancellation is never retried', async () => {
  const work = createFactory().concurrency({ name: 'retry-cancel', limit: 1 });
  const abort = new AbortController();
  let calls = 0;
  const task = work.run(async ({ signal }) => {
    calls += 1;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { signal: abort.signal, retry: { attempts: 2 } });
  await flush();
  abort.abort();
  await assert.rejects(task, ControllerAbortError);
  assert.equal(calls, 1);
  assert.equal(work.stats().retriesAttempted, 0);
});

test('execution timeout is never retried by default', async () => {
  const work = createFactory().concurrency({ name: 'retry-timeout', limit: 1 });
  let calls = 0;
  await assert.rejects(work.run(async ({ signal }) => {
    calls += 1;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 5, retry: { attempts: 2 } }), ControllerTimeoutError);
  assert.equal(calls, 1);
  assert.equal(work.stats().retriesAttempted, 0);
});

test('retry delay releases capacity before the next attempt', async () => {
  const work = createFactory().concurrency({ name: 'retry-delay-capacity', limit: 1 });
  let calls = 0;
  const retrying = work.run(() => {
    calls += 1;
    if (calls === 1) throw new Error('temporary');
    return 'done';
  }, { retry: { attempts: 1, delayMs: 25 } });
  await wait(5);
  assert.equal(await work.run(() => 'other work'), 'other work');
  assert.equal(await retrying, 'done');
});

test('retry attempts obey concurrency limits', async () => {
  const work = createFactory().concurrency({ name: 'retry-concurrency', limit: 2 });
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 4 }, (_value, index) => work.run(async ({ attempt }) => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(2);
    active -= 1;
    if (attempt === 1 && index < 2) throw new Error('temporary');
    return index;
  }, { retry: { attempts: 1 } }));
  await Promise.all(jobs);
  assert.ok(peak <= 2);
  assert.equal(work.stats().retriesAttempted, 2);
});

test('a retry uses normal queue capacity and can reject when full', async () => {
  const work = createFactory().concurrency({ name: 'retry-queue-capacity', limit: 1, maxQueueSize: 1 });
  let firstAttempt = true;
  const retrying = work.run(() => {
    if (firstAttempt) {
      firstAttempt = false;
      throw new Error('temporary');
    }
  }, { retry: { attempts: 1, delayMs: 20 } });
  await wait(5);
  const active = work.run(() => wait(40));
  const queued = work.run(() => undefined);
  await assert.rejects(retrying, QueueFullError);
  await Promise.all([active, queued]);
  assert.equal(work.stats().retriesAttempted, 0);
});

test('cancelling during retry delay terminates the chain without another attempt', async () => {
  const work = createFactory().concurrency({ name: 'retry-delay-abort', limit: 1 });
  const abort = new AbortController();
  let calls = 0;
  const task = work.run(() => {
    calls += 1;
    throw new Error('temporary');
  }, { signal: abort.signal, retry: { attempts: 2, delayMs: 30 } });
  await wait(5);
  abort.abort();
  await assert.rejects(task, ControllerAbortError);
  assert.equal(calls, 1);
  await wait(35);
  assert.equal(calls, 1);
});

test('each admitted retry gets its own execution timeout', async () => {
  const work = createFactory().concurrency({ name: 'retry-attempt-timeout', limit: 1 });
  const attempts: number[] = [];
  await assert.rejects(work.run(async ({ attempt, signal }) => {
    attempts.push(attempt);
    if (attempt === 1) throw new Error('temporary');
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 5, retry: { attempts: 2 } }), ControllerTimeoutError);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(work.stats().retriesAttempted, 1);
});

test('close drains an accepted retry chain while new public submissions reject', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'retry-drain-work', limit: 1 });
  const limiter = factory.adaptiveConcurrency({
    name: 'retry-drain-control', controller: work, minLimit: 1, maxLimit: 2, targetP95Ms: 100, maxErrorRate: 0.01
  });
  let calls = 0;
  const retrying = work.run(() => {
    calls += 1;
    if (calls === 1) throw new Error('temporary');
    return 'drained';
  }, { retry: { attempts: 1, delayMs: 20 } });
  await wait(5);
  const closing = limiter.close();
  await assert.rejects(work.run(() => undefined), ControllerLifecycleError);
  assert.equal(await retrying, 'drained');
  await closing;
  assert.equal(limiter.lifecycle(), 'closed');
});

test('retry option validation rejects invalid bounded configurations before admission', () => {
  const work = createFactory().concurrency({ name: 'retry-validation', limit: 1 });
  assert.throws(() => work.run(() => undefined, { retry: { attempts: -1 } }), /retry.attempts/);
  assert.throws(() => work.run(() => undefined, { retry: { delayMs: Number.POSITIVE_INFINITY } }), /retry.delayMs/);
  assert.equal(work.stats().accepted, 0);
});
