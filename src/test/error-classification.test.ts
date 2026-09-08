import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BulkheadQueueFullError, CircuitBreakerOpenError, ControllerAbortError, ControllerLifecycleError,
  ControllerLimitError, ControllerTimeoutError, DuplicateControllerNameError, QueueAbortedError,
  QueueFullError, QueueWaitTimeoutError, UnknownBulkheadError, classifyLazphoError, isLazphoError
} from '../index.js';

test('all public controller errors retain classes and expose stable codes and classifications', () => {
  const cases = [
    [new QueueFullError('work', 10), 'FACTORY_BACKPRESSURE_REJECTED', 'queue_full'],
    [new BulkheadQueueFullError('work', 'A', 2), 'FACTORY_BULKHEAD_QUEUE_FULL', 'bulkhead_queue_full'],
    [new UnknownBulkheadError('work', 'missing'), 'FACTORY_UNKNOWN_BULKHEAD', 'unknown_bulkhead'],
    [new ControllerTimeoutError('work', 5), 'FACTORY_CONTROLLER_TIMEOUT', 'timeout'],
    [new ControllerAbortError('work'), 'FACTORY_CONTROLLER_ABORTED', 'aborted'],
    [new QueueAbortedError('work'), 'FACTORY_QUEUE_ABORTED', 'queue_aborted'],
    [new QueueWaitTimeoutError('work', 5), 'FACTORY_QUEUE_WAIT_TIMEOUT', 'queue_wait_timeout'],
    [new ControllerLifecycleError('work', 'accept work'), 'FACTORY_CONTROLLER_CLOSED', 'lifecycle'],
    [new CircuitBreakerOpenError('work'), 'FACTORY_CIRCUIT_BREAKER_OPEN', 'breaker_open'],
    [new DuplicateControllerNameError('work'), 'FACTORY_DUPLICATE_CONTROLLER', 'duplicate_controller'],
    [new ControllerLimitError(10), 'FACTORY_CONTROLLER_LIMIT', 'controller_limit']
  ] as const;
  for (const [error, code, kind] of cases) {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(isLazphoError(error), true);
    assert.equal(classifyLazphoError(error), kind);
  }
  assert.equal(isLazphoError(new Error('other')), false);
  assert.equal(classifyLazphoError('other'), undefined);
  const bulkhead = cases[1][0];
  assert.equal(bulkhead.controller, 'work');
  assert.equal(bulkhead.bulkhead, 'A');
  assert.equal(bulkhead.maxQueue, 2);

  assert.deepEqual(
    cases.map(([error]) => Object.keys(error).filter((key) => key !== 'name' && key !== 'message').sort()),
    [
      ['code', 'controller', 'maxQueueSize'],
      ['bulkhead', 'code', 'controller', 'maxQueue'],
      ['bulkhead', 'code', 'controller'],
      ['code', 'controller', 'timeoutMs'],
      ['code', 'controller'],
      ['code', 'controller'],
      ['code', 'controller', 'maxQueueWaitMs'],
      ['code', 'controller', 'operation'],
      ['code', 'controller'],
      ['code', 'controller'],
      ['code', 'maxControllers']
    ]
  );
  assert.ok(cases[3][0] instanceof ControllerAbortError);
  assert.ok(cases[3][0] instanceof QueueAbortedError);
  assert.ok(cases[4][0] instanceof QueueAbortedError);
});
