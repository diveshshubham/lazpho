import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreakerOpenError, ControllerAbortError, ControllerTimeoutError, createFactory } from '../index.js';

const breaker = { failureThreshold: 2, resetTimeoutMs: 10 };
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('breaker is disabled by default and successes reset consecutive failures', async () => {
  const work = createFactory().concurrency({ name: 'breaker-default', limit: 1 });
  await assert.rejects(work.run(() => { throw new Error('one'); }), /one/);
  await work.run(() => undefined);
  await assert.rejects(work.run(() => { throw new Error('two'); }), /two/);
  assert.equal(work.stats().circuitBreaker, undefined);
});

test('consecutive qualifying failures trip open and fail fast without callback execution', async () => {
  const work = createFactory().concurrency({ name: 'breaker-open', limit: 1, circuitBreaker: breaker });
  await assert.rejects(work.run(() => { throw new Error('one'); }), /one/);
  await assert.rejects(work.run(() => { throw new Error('two'); }), /two/);
  let ran = false;
  await assert.rejects(work.run(() => { ran = true; }), CircuitBreakerOpenError);
  assert.equal(ran, false);
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().queued, 0);
  assert.equal(work.stats().circuitBreaker?.breakerTrips, 1);
});

test('caller cancellation and local queue rejection do not count as breaker failures', async () => {
  const work = createFactory().concurrency({ name: 'breaker-exclusions', limit: 1, maxQueueSize: 0, circuitBreaker: breaker });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(work.run(() => undefined, { signal: abort.signal }), ControllerAbortError);
  const active = work.run(() => wait(20));
  await assert.rejects(work.run(() => undefined));
  await active;
  assert.equal(work.stats().circuitBreaker?.consecutiveFailures, 0);
});

test('execution timeout is a qualifying breaker failure', async () => {
  const work = createFactory().concurrency({ name: 'breaker-timeout', limit: 1, circuitBreaker: { ...breaker, failureThreshold: 1 } });
  await assert.rejects(work.run(async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 3 }), ControllerTimeoutError);
  assert.equal(work.stats().circuitBreaker?.state, 'open');
});

test('cooldown permits one half-open probe, successful probe closes, and failed probe reopens', async () => {
  // Leave enough post-probe observation margin for parallel CI workers: snapshot()
  // correctly advances an expired open state lazily, so a 5 ms window was flaky.
  const resetTimeoutMs = 250;
  const work = createFactory().concurrency({ name: 'breaker-recovery', limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs } });
  await assert.rejects(work.run(() => { throw new Error('down'); }), /down/);
  await wait(resetTimeoutMs + 25);
  assert.equal(await work.run(() => 'recovered'), 'recovered');
  assert.equal(work.stats().circuitBreaker?.state, 'closed');
  await assert.rejects(work.run(() => { throw new Error('down again'); }), /down again/);
  await wait(resetTimeoutMs + 25);
  await assert.rejects(work.run(() => { throw new Error('probe failed'); }), /probe failed/);
  assert.equal(work.stats().circuitBreaker?.state, 'open');
});

test('half-open admission is synchronous and strictly bounds concurrent probes', async () => {
  const work = createFactory().concurrency({ name: 'breaker-half-open-race', limit: 4, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 5, halfOpenMaxAttempts: 1 } });
  await assert.rejects(work.run(() => { throw new Error('down'); }), /down/);
  await wait(8);
  let probes = 0;
  const calls = Array.from({ length: 10 }, () => work.run(async () => { probes += 1; await wait(5); }));
  const results = await Promise.allSettled(calls);
  assert.equal(probes, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 9);
});

test('queued accepted work is rejected before callback execution once the breaker opens', async () => {
  const work = createFactory().concurrency({ name: 'breaker-queued', limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 50 } });
  let release: () => void = () => undefined;
  const first = work.run(() => new Promise<void>((resolve) => { release = resolve; }).then(() => { throw new Error('down'); }));
  let queuedRan = false;
  const queued = work.run(() => { queuedRan = true; });
  await flush();
  release();
  await assert.rejects(first, /down/);
  await assert.rejects(queued, CircuitBreakerOpenError);
  assert.equal(queuedRan, false);
  assert.equal(work.stats().queued, 0);
});

test('retry attempts cannot bypass an opened breaker and close drains queued breaker rejections', async () => {
  const factory = createFactory();
  const work = factory.concurrency({ name: 'breaker-retry-drain', limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 50 } });
  const retrying = work.run(() => { throw new Error('down'); }, { retry: { attempts: 1, delayMs: 5 } });
  await assert.rejects(retrying, CircuitBreakerOpenError);
  const closing = work.close();
  await closing;
  assert.equal(work.lifecycle(), 'closed');
});
