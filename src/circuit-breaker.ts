import { CircuitBreakerOpenError, ControllerAbortError, ControllerLifecycleError, ControllerTimeoutError, QueueFullError, QueueWaitTimeoutError } from './concurrency-errors.js';
import type { CircuitBreakerMetrics, CircuitBreakerOptions, CircuitBreakerState } from './types.js';

export class CircuitBreaker {
  private stateValue: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probes = 0;
  private trips = 0;
  private rejected = 0;
  private halfOpenAttempts = 0;
  private recoveries = 0;
  private readonly halfOpenMaxAttempts: number;

  public constructor(private readonly name: string, private readonly options: Required<CircuitBreakerOptions>) {
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts;
  }

  public allow(): 'closed' | 'probe' | false {
    this.refresh();
    if (this.stateValue === 'open') { this.rejected += 1; return false; }
    if (this.stateValue === 'half_open') {
      if (this.probes >= this.halfOpenMaxAttempts) { this.rejected += 1; return false; }
      this.probes += 1;
      this.halfOpenAttempts += 1;
      return 'probe';
    }
    return 'closed';
  }

  public succeeded(): void {
    if (this.stateValue === 'half_open') {
      if (this.probes >= this.halfOpenMaxAttempts) this.close();
      return;
    }
    this.consecutiveFailures = 0;
  }

  public failed(error: unknown, callerCancelled: boolean): void {
    if (!qualifies(error, callerCancelled)) return;
    if (this.stateValue === 'half_open') { this.open(); return; }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) this.open();
  }

  public error(): CircuitBreakerOpenError { return new CircuitBreakerOpenError(this.name); }

  public snapshot(): CircuitBreakerMetrics {
    this.refresh();
    return { enabled: true, state: this.stateValue, consecutiveFailures: this.consecutiveFailures, breakerTrips: this.trips, breakerRejected: this.rejected, halfOpenAttempts: this.halfOpenAttempts, breakerRecoveries: this.recoveries };
  }

  private refresh(): void {
    if (this.stateValue === 'open' && Date.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.stateValue = 'half_open';
      this.probes = 0;
    }
  }

  private open(): void {
    this.stateValue = 'open';
    this.openedAt = Date.now();
    this.probes = 0;
    this.trips += 1;
  }

  private close(): void {
    this.stateValue = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probes = 0;
    this.recoveries += 1;
  }
}

export function circuitBreakerOptions(value: CircuitBreakerOptions | undefined): Required<CircuitBreakerOptions> | undefined {
  if (!value) return undefined;
  const halfOpenMaxAttempts = value.halfOpenMaxAttempts ?? 1;
  if (!Number.isInteger(value.failureThreshold) || value.failureThreshold <= 0) throw new RangeError('circuitBreaker.failureThreshold must be a positive integer.');
  if (!Number.isFinite(value.resetTimeoutMs) || value.resetTimeoutMs <= 0) throw new RangeError('circuitBreaker.resetTimeoutMs must be a positive finite number.');
  if (!Number.isInteger(halfOpenMaxAttempts) || halfOpenMaxAttempts <= 0) throw new RangeError('circuitBreaker.halfOpenMaxAttempts must be a positive integer.');
  return { ...value, halfOpenMaxAttempts };
}

function qualifies(error: unknown, callerCancelled: boolean): boolean {
  return !callerCancelled
    && (!(error instanceof ControllerAbortError) || error instanceof ControllerTimeoutError)
    && !(error instanceof QueueFullError)
    && !(error instanceof QueueWaitTimeoutError)
    && !(error instanceof ControllerLifecycleError);
}
