export class QueueFullError extends Error {
  public readonly code = 'FACTORY_BACKPRESSURE_REJECTED';
  public constructor(public readonly controller: string, public readonly maxQueueSize: number) {
    super(`Concurrency controller "${controller}" queue is full (maxQueueSize: ${maxQueueSize}).`);
    this.name = 'QueueFullError';
  }
}

export class BulkheadQueueFullError extends Error {
  public readonly code = 'FACTORY_BULKHEAD_QUEUE_FULL';
  public constructor(public readonly controller: string, public readonly bulkhead: string, public readonly maxQueue: number) {
    super(`Concurrency controller "${controller}" bulkhead "${bulkhead}" queue is full (maxQueue: ${maxQueue}).`);
    this.name = 'BulkheadQueueFullError';
  }
}

export class UnknownBulkheadError extends Error {
  public readonly code = 'FACTORY_UNKNOWN_BULKHEAD';
  public constructor(public readonly controller: string, public readonly bulkhead: string) {
    super(`Concurrency controller "${controller}" has no bulkhead named "${bulkhead}".`);
    this.name = 'UnknownBulkheadError';
  }
}

export class QueueAbortedError extends Error {
  public readonly code: string = 'FACTORY_QUEUE_ABORTED';
  public constructor(public readonly controller: string) {
    super(`Queued operation for concurrency controller "${controller}" was aborted.`);
    this.name = 'QueueAbortedError';
  }
}

export class ControllerAbortError extends QueueAbortedError {
  public readonly code: string = 'FACTORY_CONTROLLER_ABORTED';

  public constructor(name: string) {
    super(name);
    this.message = `Concurrency controller "${name}" operation was cancelled.`;
    this.name = 'ControllerAbortError';
  }
}

export class ControllerTimeoutError extends ControllerAbortError {
  public readonly code: string = 'FACTORY_CONTROLLER_TIMEOUT';

  public constructor(name: string, public readonly timeoutMs: number) {
    super(name);
    this.message = `Concurrency controller "${name}" operation exceeded timeoutMs (${timeoutMs}ms).`;
    this.name = 'ControllerTimeoutError';
  }
}

export class QueueWaitTimeoutError extends Error {
  public readonly code = 'FACTORY_QUEUE_WAIT_TIMEOUT';

  public constructor(public readonly controller: string, public readonly maxQueueWaitMs: number) {
    super(`Queued operation for concurrency controller "${controller}" exceeded maxQueueWaitMs (${maxQueueWaitMs}ms).`);
    this.name = 'QueueWaitTimeoutError';
  }
}

export class ControllerLifecycleError extends Error {
  public readonly code = 'FACTORY_CONTROLLER_CLOSED';

  public constructor(public readonly controller: string, public readonly operation: string) {
    super(`Concurrency controller "${controller}" is shutting down and cannot ${operation}.`);
    this.name = 'ControllerLifecycleError';
  }
}

export class CircuitBreakerOpenError extends Error {
  public readonly code = 'FACTORY_CIRCUIT_BREAKER_OPEN';

  public constructor(public readonly controller: string) {
    super(`Concurrency controller "${controller}" circuit breaker is open.`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class DuplicateControllerNameError extends Error {
  public readonly code = 'FACTORY_DUPLICATE_CONTROLLER';
  public constructor(public readonly controller: string) {
    super(`A concurrency controller named "${controller}" already exists.`);
    this.name = 'DuplicateControllerNameError';
  }
}

export class ControllerLimitError extends Error {
  public readonly code = 'FACTORY_CONTROLLER_LIMIT';
  public constructor(public readonly maxControllers: number) {
    super(`The factory controller limit (${maxControllers}) has been reached.`);
    this.name = 'ControllerLimitError';
  }
}
