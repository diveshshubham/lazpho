import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { BulkheadQueueFullError, CircuitBreakerOpenError, ControllerAbortError, ControllerLifecycleError, ControllerTimeoutError, QueueFullError } from '../concurrency-errors.js';
import { createLazphoRequestContext, mapLazphoErrorToHttp } from '../adapters/framework-common.js';

test('request context respects framework and caller cancellation and cleans composed signals', async () => {
  const controller = createFactory().concurrency({ name: 'signals', limit: 1 });
  const requestAbort = new AbortController();
  const callerAbort = new AbortController();
  const context = createLazphoRequestContext(controller, requestAbort.signal, 'express');
  let operationSignal: AbortSignal | undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const running = context.run(({ signal }) => {
    operationSignal = signal;
    markStarted();
    return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { signal: callerAbort.signal });
  await started;
  callerAbort.abort(new Error('caller stopped'));
  await assert.rejects(running, ControllerAbortError);
  assert.equal(operationSignal?.aborted, true);

  const second = context.run(({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  requestAbort.abort(new Error('request stopped'));
  await assert.rejects(second, ControllerAbortError);
  await controller.close();
});

test('request context applies a configured bulkhead while explicit options take precedence', async () => {
  const controller = createFactory().concurrency({
    name: 'framework-bulkheads', limit: 2,
    bulkheads: { payments: { maxConcurrent: 1, maxQueue: 0 }, search: { maxConcurrent: 1, maxQueue: 0 } }
  });
  const context = createLazphoRequestContext(controller, new AbortController().signal, 'fastify', 'payments');
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const active = controller.run(() => new Promise<void>((resolve) => { release = resolve; started(); }), { bulkhead: 'payments' });
  await admitted;
  await assert.rejects(context.run(() => undefined), BulkheadQueueFullError);
  assert.equal(await context.run(() => 'search', { bulkhead: 'search' }), 'search');
  release();
  await active;
  await controller.close();
});

test('HTTP mapping is conservative, stable, and does not expose messages', () => {
  assert.deepEqual(mapLazphoErrorToHttp(new QueueFullError('x', 1)), { statusCode: 503, code: 'FACTORY_BACKPRESSURE_REJECTED' });
  assert.deepEqual(mapLazphoErrorToHttp(new BulkheadQueueFullError('x', 'a', 0)), { statusCode: 503, code: 'FACTORY_BULKHEAD_QUEUE_FULL' });
  assert.deepEqual(mapLazphoErrorToHttp(new CircuitBreakerOpenError('x')), { statusCode: 503, code: 'FACTORY_CIRCUIT_BREAKER_OPEN' });
  assert.deepEqual(mapLazphoErrorToHttp(new ControllerLifecycleError('x', 'run work')), { statusCode: 503, code: 'FACTORY_CONTROLLER_CLOSED' });
  assert.deepEqual(mapLazphoErrorToHttp(new ControllerTimeoutError('x', 1)), { statusCode: 504, code: 'FACTORY_CONTROLLER_TIMEOUT' });
  assert.equal(mapLazphoErrorToHttp(new ControllerAbortError('x')), undefined);
  assert.equal(mapLazphoErrorToHttp(new Error('task failed')), undefined);
});

test('one request helper call delegates once while retries remain controller-owned', async () => {
  const controller = createFactory().concurrency({ name: 'framework-retry', limit: 1 });
  let controllerRuns = 0;
  const observed = new Proxy(controller, {
    get(target, property, receiver) {
      if (property !== 'run') return Reflect.get(target, property, receiver);
      return (...arguments_: Parameters<typeof controller.run>) => {
        controllerRuns += 1;
        return controller.run(...arguments_);
      };
    }
  });
  const context = createLazphoRequestContext(observed, new AbortController().signal, 'nestjs');
  let attempts = 0;
  const result = await context.run(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient');
    return 'ok';
  }, { retry: { attempts: 1 } });
  assert.equal(result, 'ok');
  assert.equal(controllerRuns, 1);
  assert.equal(attempts, 2);
  await controller.close();
});
