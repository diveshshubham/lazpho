import {
  BulkheadQueueFullError,
  CircuitBreakerOpenError,
  ControllerAbortError,
  ControllerLifecycleError,
  ControllerLimitError,
  ControllerTimeoutError,
  DuplicateControllerNameError,
  QueueAbortedError,
  QueueFullError,
  QueueWaitTimeoutError,
  UnknownBulkheadError
} from './concurrency-errors.js';

export type LazphoError = QueueFullError | BulkheadQueueFullError | UnknownBulkheadError
  | ControllerTimeoutError | ControllerAbortError | QueueAbortedError | QueueWaitTimeoutError
  | ControllerLifecycleError | CircuitBreakerOpenError | DuplicateControllerNameError | ControllerLimitError;

export type LazphoErrorKind = 'queue_full' | 'bulkhead_queue_full' | 'unknown_bulkhead'
  | 'timeout' | 'aborted' | 'queue_aborted' | 'queue_wait_timeout' | 'lifecycle'
  | 'breaker_open' | 'duplicate_controller' | 'controller_limit';

export function isLazphoError(error: unknown): error is LazphoError {
  return classifyLazphoError(error) !== undefined;
}

export function classifyLazphoError(error: unknown): LazphoErrorKind | undefined {
  if (error instanceof BulkheadQueueFullError) return 'bulkhead_queue_full';
  if (error instanceof QueueFullError) return 'queue_full';
  if (error instanceof UnknownBulkheadError) return 'unknown_bulkhead';
  if (error instanceof ControllerTimeoutError) return 'timeout';
  if (error instanceof ControllerAbortError) return 'aborted';
  if (error instanceof QueueAbortedError) return 'queue_aborted';
  if (error instanceof QueueWaitTimeoutError) return 'queue_wait_timeout';
  if (error instanceof ControllerLifecycleError) return 'lifecycle';
  if (error instanceof CircuitBreakerOpenError) return 'breaker_open';
  if (error instanceof DuplicateControllerNameError) return 'duplicate_controller';
  if (error instanceof ControllerLimitError) return 'controller_limit';
  return undefined;
}
