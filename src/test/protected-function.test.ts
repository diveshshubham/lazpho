import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory, createProtectedFunction } from '../index.js';
import { BulkheadQueueFullError, ControllerAbortError, ControllerTimeoutError } from '../concurrency-errors.js';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test('protected function preserves arguments, return type, defaults, and per-call overrides', async () => {
  const controller = createFactory().concurrency({ name: 'protect-args', limit: 2, bulkheads: { payments: { maxConcurrent: 1, maxQueue: 2 } } });
  const calls: Array<[string, number]> = [];
  const protectedCall = createProtectedFunction(controller, async (_context, value: string, count: number) => {
    calls.push([value, count]);
    return { value, count };
  }, { bulkhead: 'payments', timeoutMs: 50, retry: { attempts: 1 } });
  const result: { value: string; count: number } = await protectedCall('invoice', 2);
  const overridden = await protectedCall.run({ timeoutMs: 100 }, 'refund', 1);
  assert.deepEqual(result, { value: 'invoice', count: 2 });
  assert.deepEqual(overridden, { value: 'refund', count: 1 });
  assert.deepEqual(calls, [['invoice', 2], ['refund', 1]]);
});

test('protected function preserves explicit method binding and original errors', async () => {
  const controller = createFactory().concurrency({ name: 'protect-this', limit: 1 });
  const client = {
    prefix: 'client',
    request(this: { prefix: string }, _context: unknown, value: string): string {
      if (value === 'fail') throw new Error(`${this.prefix}-failure`);
      return `${this.prefix}:${value}`;
    }
  };
  const protectedMethod = createProtectedFunction(controller, client.request, { thisArg: client });
  assert.equal(await protectedMethod('ok'), 'client:ok');
  await assert.rejects(protectedMethod('fail'), /client-failure/);
});

test('protected function delegates retry, timeout, bulkhead, and cancellation to the controller', async () => {
  const controller = createFactory().concurrency({ name: 'protect-semantics', limit: 2, bulkheads: { A: { maxConcurrent: 1, maxQueue: 0 } } });
  let attempts = 0;
  const retrying = createProtectedFunction(controller, ({ attempt }) => {
    attempts += 1;
    if (attempt === 1) throw new Error('temporary');
    return 'done';
  }, { bulkhead: 'A', retry: { attempts: 1 } });
  assert.equal(await retrying(), 'done');
  assert.equal(attempts, 2);

  const blocking = createProtectedFunction(controller, async () => delay(20), { bulkhead: 'A' });
  const active = blocking();
  await assert.rejects(blocking(), BulkheadQueueFullError);
  await active;

  const timed = createProtectedFunction(controller, async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 2 });
  await assert.rejects(timed(), ControllerTimeoutError);

  const abort = new AbortController();
  const cancellable = createProtectedFunction(controller, async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancelled = cancellable.run({ signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, ControllerAbortError);
});
