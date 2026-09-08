import assert from 'node:assert/strict';
import test from 'node:test';
import * as factoryNode from '../index.js';
import type {
  AdaptiveBackpressureSnapshot,
  AdaptiveRuntimeConfigUpdate,
  ConcurrencyController,
  RunContext,
  RunOptions,
  LazphoErrorKind
} from '../index.js';

test('the built public entry supports fixed and adaptive consumer workflows', async () => {
  const factory = factoryNode.createFactory();
  const fixed: ConcurrencyController = factory.concurrency({ name: 'public-fixed', limit: 1 });
  const options: RunOptions = { timeoutMs: 100 };
  const value = await fixed.run(async (_context: RunContext) => 'completed', options);
  assert.equal(value, 'completed');

  const adaptive = factory.adaptiveConcurrency({
    name: 'public-adaptive',
    controller: fixed,
    minLimit: 1,
    maxLimit: 5,
    targetP95Ms: 100,
    maxErrorRate: 0.01,
    mode: 'auto'
  });
  const update: AdaptiveRuntimeConfigUpdate = { maxLimit: 4 };
  adaptive.updateConfig(update);
  const snapshot: AdaptiveBackpressureSnapshot = adaptive.snapshot();
  assert.equal(snapshot.controller.maxLimit, 4);
  assert.equal(adaptive.lifecycle(), 'running');
  await adaptive.close();
  assert.equal(adaptive.lifecycle(), 'closed');

  const aborted = new factoryNode.ControllerAbortError('public-fixed');
  const timedOut = new factoryNode.ControllerTimeoutError('public-fixed', 1);
  assert.equal(aborted.code, 'FACTORY_CONTROLLER_ABORTED');
  assert.equal(timedOut.code, 'FACTORY_CONTROLLER_TIMEOUT');
  assert.equal('Ewma' in factoryNode, false);
  assert.equal('clampAdaptiveLimit' in factoryNode, false);
  const partitioned = factory.concurrency({
    name: 'public-bulkheads', limit: 2, bulkheads: { payments: { maxConcurrent: 1, maxQueue: 2 } }
  });
  assert.equal(await partitioned.run(() => 'paid', { bulkhead: 'payments' }), 'paid');
  assert.equal(partitioned.stats().bulkheads.payments.maxConcurrent, 1);
  assert.equal(new factoryNode.BulkheadQueueFullError('public-bulkheads', 'payments', 2).code, 'FACTORY_BULKHEAD_QUEUE_FULL');
  const protectedCall = factoryNode.createProtectedFunction(partitioned, async ({ signal }, input: { id: number }) => {
    assert.equal(signal.aborted, false);
    return String(input.id);
  }, { bulkhead: 'payments', timeoutMs: 100, retry: { attempts: 1 } });
  const protectedValue: string = await protectedCall({ id: 42 });
  assert.equal(protectedValue, '42');
  const kind: LazphoErrorKind | undefined = factoryNode.classifyLazphoError(new factoryNode.CircuitBreakerOpenError('public-fixed'));
  assert.equal(kind, 'breaker_open');
  const unknown: unknown = new factoryNode.QueueFullError('public-fixed', 1);
  if (factoryNode.isLazphoError(unknown)) assert.equal(typeof unknown.code, 'string');
  factory.close();
});
