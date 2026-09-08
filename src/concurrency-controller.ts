import { BulkheadQueueFullError, CircuitBreakerOpenError, ControllerAbortError, ControllerLifecycleError, ControllerTimeoutError, QueueFullError, QueueWaitTimeoutError, UnknownBulkheadError } from './concurrency-errors.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { normalizeConcurrencyOptions } from './configuration-validation.js';
import { ConcurrencyMetricAggregator } from './concurrency-metrics.js';
import { PartitionScheduler } from './partition-scheduler.js';
import type { PartitionState, ScheduledEntry } from './partition-scheduler.js';
import type { ConcurrencyController, ConcurrencyMetrics, ConcurrencyOptions, LifecycleState, RetryOptions, RunContext, RunOptions } from './types.js';

interface QueueEntry<T> extends ScheduledEntry {
  operation: (context: RunContext) => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  options: RunOptions;
  attempt: number;
  breakerChecked: boolean;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
}

type NormalizedRetryOptions = Required<Pick<RetryOptions, 'attempts' | 'delayMs'>> & Pick<RetryOptions, 'shouldRetry'>;

export interface ControllerDebugState {
  executionTimers: number;
  queueTimers: number;
  retryTimers: number;
  abortListeners: number;
  pendingRetryChains: number;
  active: number;
  queued: number;
  linkedQueueNodes: number;
  partitions: ReadonlyArray<{ name: string | undefined; active: number; queued: number; hasHead: boolean; hasTail: boolean }>;
}

export class FixedConcurrencyController implements ConcurrencyController {
  private limit: number;
  private readonly maxQueueSize: number;
  private readonly maxQueueWaitMs: number | undefined;
  private readonly metrics: ConcurrencyMetricAggregator;
  private readonly scheduler: PartitionScheduler;
  private lifecycleState: LifecycleState = 'running';
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private pendingRetryChains = 0;
  private readonly breaker: CircuitBreaker | undefined;
  private drainingScheduler = false;
  private executionTimers = 0;
  private queueTimers = 0;
  private retryTimers = 0;
  private abortListeners = 0;

  public constructor(private readonly name: string, options: ConcurrencyOptions) {
    const config = normalizeConcurrencyOptions(options);
    this.limit = config.limit;
    this.maxQueueSize = config.maxQueueSize;
    this.maxQueueWaitMs = config.maxQueueWaitMs;
    this.scheduler = new PartitionScheduler(this.maxQueueSize, config.bulkheads);
    this.metrics = new ConcurrencyMetricAggregator(name, config.latencySampleSize);
    this.breaker = config.circuitBreaker && new CircuitBreaker(name, config.circuitBreaker);
  }

  public run<T>(operation: (context: RunContext) => Promise<T> | T, options: RunOptions = {}): Promise<T> {
    this.validateRunOptions(options);
    const partition = this.scheduler.resolve(options.bulkhead);
    if (!partition) {
      this.metrics.rejected();
      return Promise.reject(new UnknownBulkheadError(this.name, options.bulkhead ?? ''));
    }
    const retry = retryOptions(options.retry);
    return retry.attempts === 0
      ? this.admit(operation, options, partition, 1, false)
      : this.runWithRetry(operation, options, partition, retry);
  }

  private admit<T>(operation: (context: RunContext) => Promise<T> | T, options: RunOptions, partition: PartitionState, attempt: number, internal: boolean): Promise<T> {
    if (this.lifecycleState !== 'running' && (!internal || this.lifecycleState === 'closed')) {
      this.metrics.rejected();
      return Promise.reject(new ControllerLifecycleError(this.name, 'accept new work'));
    }
    const breakerAdmission = this.breakerAdmission();
    if (!breakerAdmission) return Promise.reject(this.breaker?.error());
    const mustQueue = this.scheduler.mustQueue(partition, this.limit);
    if (mustQueue && this.scheduler.queued() >= this.maxQueueSize) {
      this.metrics.queueFull();
      return Promise.reject(new QueueFullError(this.name, this.maxQueueSize));
    }
    if (mustQueue && partition.name !== undefined && partition.queued >= partition.maxQueue) {
      this.scheduler.reject(partition);
      this.metrics.bulkheadFull();
      return Promise.reject(new BulkheadQueueFullError(this.name, partition.name, partition.maxQueue));
    }
    if (options.signal?.aborted) {
      this.metrics.rejected();
      this.metrics.cancelled();
      return Promise.reject(new ControllerAbortError(this.name));
    }
    this.metrics.acceptedOperation();
    if (!mustQueue) return this.execute(operation, performance.now(), options, partition, attempt, true, false);

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<unknown> = {
        operation: operation as (context: RunContext) => Promise<unknown> | unknown,
        resolve: resolve as (value: unknown | PromiseLike<unknown>) => void,
        reject,
        enqueuedAt: performance.now(),
        options,
        attempt,
        partition,
        breakerChecked: breakerAdmission === 'probe'
      };
      if (entry.options.signal) {
        entry.abortListener = () => this.abort(entry);
        entry.options.signal.addEventListener('abort', entry.abortListener, { once: true });
        this.abortListeners += 1;
      }
      this.scheduler.enqueue(entry);
      this.metrics.enqueued();
      if (this.maxQueueWaitMs !== undefined) {
        this.queueTimers += 1;
        entry.timeout = setTimeout(() => {
          entry.timeout = undefined;
          this.queueTimers -= 1;
          this.timeout(entry);
        }, this.maxQueueWaitMs);
      }
      this.drain();
    });
  }

  private async runWithRetry<T>(operation: (context: RunContext) => Promise<T> | T, options: RunOptions, partition: PartitionState, retry: NormalizedRetryOptions): Promise<T> {
    this.pendingRetryChains += 1;
    let attempt = 1;
    try {
      while (true) {
        try {
          const value = await this.admit(operation, options, partition, attempt, attempt > 1);
          if (attempt > 1) this.metrics.retrySucceeded();
          return value;
        } catch (error) {
          if (!this.canRetry(error, options, retry, attempt)) {
            if (attempt > retry.attempts && isTaskFailure(error, options)) this.metrics.retryExhausted();
            throw error;
          }
          await this.retryDelay(retry.delayMs, options.signal);
          attempt += 1;
        }
      }
    } finally {
      this.pendingRetryChains = Math.max(0, this.pendingRetryChains - 1);
      this.finishCloseIfDrained();
    }
  }

  public setLimit(limit: number): void {
    this.limit = validPositiveInteger(limit, 'limit');
    this.drain();
  }

  public getLimit(): number { return this.limit; }

  public stats(): ConcurrencyMetrics {
    const metrics = this.metrics.snapshot(this.limit, this.maxQueueSize, this.scheduler.snapshot());
    return this.breaker ? { ...metrics, circuitBreaker: this.breaker.snapshot() } : metrics;
  }

  public lifecycle(): LifecycleState { return this.lifecycleState; }

  /** Package-internal diagnostic. It is intentionally absent from the public controller interface and entry point. */
  public debugStateForTests(): ControllerDebugState {
    const scheduler = this.scheduler.debugState();
    return {
      executionTimers: this.executionTimers,
      queueTimers: this.queueTimers,
      retryTimers: this.retryTimers,
      abortListeners: this.abortListeners,
      pendingRetryChains: this.pendingRetryChains,
      active: scheduler.active,
      queued: scheduler.queued,
      linkedQueueNodes: scheduler.linkedNodes,
      partitions: scheduler.partitions
    };
  }

  public close(): Promise<void> {
    if (this.lifecycleState === 'closed') return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = 'draining';
    this.closePromise = new Promise<void>((resolve) => { this.resolveClose = resolve; });
    this.drain();
    this.finishCloseIfDrained();
    return this.closePromise;
  }

  private execute<T>(operation: (context: RunContext) => Promise<T> | T, enqueuedAt: number, options: RunOptions, partition: PartitionState, attempt: number, breakerChecked: boolean, wasQueued: boolean): Promise<T> {
    if (!breakerChecked && !this.breakerAdmission()) return Promise.reject(this.breaker?.error());
    this.scheduler.started(partition);
    const startedAt = performance.now();
    this.metrics.started(startedAt - enqueuedAt, attempt > 1, wasQueued);
    const cancellation = new AbortController();
    let callerCancelled = false;
    const callerAbort = () => {
      callerCancelled = true;
      this.metrics.cancelled();
      cancellation.abort(new ControllerAbortError(this.name));
    };
    if (options.signal) {
      options.signal.addEventListener('abort', callerAbort, { once: true });
      this.abortListeners += 1;
    }
    if (options.signal?.aborted) callerAbort();
    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      this.executionTimers += 1;
      timeout = setTimeout(() => {
        timeout = undefined;
        this.executionTimers -= 1;
        this.metrics.executionTimedOut();
        cancellation.abort(new ControllerTimeoutError(this.name, options.timeoutMs ?? 0));
      }, options.timeoutMs);
    }
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
        this.executionTimers -= 1;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', callerAbort);
        this.abortListeners -= 1;
      }
    };
    return Promise.resolve()
      .then(() => {
        if (cancellation.signal.aborted) throw cancellation.signal.reason;
        return operation({ signal: cancellation.signal, attempt });
      })
      .then(
        (value) => {
          this.breaker?.succeeded();
          cleanup();
          this.finish(partition, startedAt, enqueuedAt, false);
          return value;
        },
        (error: unknown) => {
          this.breaker?.failed(error, callerCancelled);
          cleanup();
          this.finish(partition, startedAt, enqueuedAt, !callerCancelled);
          throw error;
        }
      );
  }

  private finish(partition: PartitionState, startedAt: number, enqueuedAt: number, failed: boolean): void {
    this.scheduler.finished(partition);
    const finishedAt = performance.now();
    this.metrics.finished(finishedAt - startedAt, finishedAt - enqueuedAt, failed);
    this.drain();
    this.finishCloseIfDrained();
  }

  private drain(): void {
    if (this.drainingScheduler) return;
    this.drainingScheduler = true;
    try {
      while (this.scheduler.active() < this.limit) {
        const scheduled = this.scheduler.nextRunnable(this.limit);
        if (!scheduled) break;
        const entry = scheduled as QueueEntry<unknown>;
        this.cleanupQueuedEntry(entry);
        if (entry.options.signal?.aborted) {
          this.metrics.abortedWhileQueued();
          entry.reject(new ControllerAbortError(this.name));
          continue;
        }
        if (!entry.breakerChecked && !this.breakerAdmission()) {
          this.metrics.rejected(true);
          entry.reject(this.breaker?.error());
          continue;
        }
        void this.execute(entry.operation, entry.enqueuedAt, entry.options, entry.partition, entry.attempt, true, true).then(entry.resolve, entry.reject);
      }
    } finally {
      this.drainingScheduler = false;
      this.finishCloseIfDrained();
    }
  }

  private abort(entry: QueueEntry<unknown>): void {
    if (!this.scheduler.remove(entry)) return;
    this.cleanupQueuedEntry(entry);
    this.metrics.abortedWhileQueued();
    entry.reject(new ControllerAbortError(this.name));
    this.drain();
    this.finishCloseIfDrained();
  }

  private timeout(entry: QueueEntry<unknown>): void {
    if (!this.scheduler.remove(entry)) return;
    this.cleanupQueuedEntry(entry);
    this.metrics.timedOut();
    entry.reject(new QueueWaitTimeoutError(this.name, this.maxQueueWaitMs ?? 0));
    this.drain();
    this.finishCloseIfDrained();
  }

  private cleanupQueuedEntry(entry: QueueEntry<unknown>): void {
    if (entry.options.signal && entry.abortListener) {
      entry.options.signal.removeEventListener('abort', entry.abortListener);
      this.abortListeners -= 1;
    }
    if (entry.timeout) {
      clearTimeout(entry.timeout);
      this.queueTimers -= 1;
    }
    entry.abortListener = undefined;
    entry.timeout = undefined;
  }

  private finishCloseIfDrained(): void {
    if (this.lifecycleState !== 'draining' || this.scheduler.active() !== 0 || this.scheduler.queued() !== 0 || this.pendingRetryChains !== 0) return;
    this.lifecycleState = 'closed';
    this.resolveClose?.();
    this.resolveClose = undefined;
  }

  private validateRunOptions(options: RunOptions): void {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError('timeoutMs must be a positive number.');
    }
    if (options.bulkhead !== undefined && (typeof options.bulkhead !== 'string' || options.bulkhead.length === 0 || options.bulkhead.length > 128)) {
      throw new RangeError('bulkhead must contain 1 to 128 characters.');
    }
    retryOptions(options.retry);
  }

  private canRetry(error: unknown, options: RunOptions, retry: NormalizedRetryOptions, attempt: number): boolean {
    if (attempt > retry.attempts || !isTaskFailure(error, options)) return false;
    try { return retry.shouldRetry?.(error, attempt) ?? true; } catch { return false; }
  }

  private breakerAdmission(): 'closed' | 'probe' | false { return this.breaker?.allow() ?? 'closed'; }

  private retryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      this.metrics.cancelled();
      return Promise.reject(new ControllerAbortError(this.name));
    }
    if (delayMs === 0) return Promise.resolve();
    this.retryTimers += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let listening = false;
      const finish = (error?: ControllerAbortError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.retryTimers -= 1;
        if (signal && listening) {
          signal.removeEventListener('abort', abort);
          this.abortListeners -= 1;
          listening = false;
        }
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => finish(), delayMs);
      const abort = () => {
        this.metrics.cancelled();
        finish(new ControllerAbortError(this.name));
      };
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        this.abortListeners += 1;
        listening = true;
      }
    });
  }
}

function validPositiveInteger(value: number, option: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${option} must be a positive integer.`);
  return value;
}

function retryOptions(value: RetryOptions | undefined): NormalizedRetryOptions {
  const attempts = value?.attempts ?? 0;
  const delayMs = value?.delayMs ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0) throw new RangeError('retry.attempts must be a non-negative integer.');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('retry.delayMs must be a finite non-negative number.');
  if (value?.shouldRetry !== undefined && typeof value.shouldRetry !== 'function') throw new TypeError('retry.shouldRetry must be a function.');
  return { attempts, delayMs, shouldRetry: value?.shouldRetry };
}

function isTaskFailure(error: unknown, options: RunOptions): boolean {
  return !options.signal?.aborted
    && !(error instanceof ControllerAbortError)
    && !(error instanceof ControllerTimeoutError)
    && !(error instanceof QueueFullError)
    && !(error instanceof BulkheadQueueFullError)
    && !(error instanceof UnknownBulkheadError)
    && !(error instanceof QueueWaitTimeoutError)
    && !(error instanceof CircuitBreakerOpenError)
    && !(error instanceof ControllerLifecycleError);
}
