# Lazpho

**Keep Node.js services responsive when databases and downstream APIs are under pressure.**

Lazpho is a dependency-resilience library for Node.js. It places explicit concurrency and queue bounds around asynchronous work, helping an application avoid uncontrolled in-flight requests, growing backlogs, cascading latency, and memory pressure when a dependency slows down.

It combines fixed or adaptive concurrency, bounded backpressure, bulkhead isolation, circuit breaking, bounded retries, cooperative cancellation, and operational metrics in one zero-runtime-dependency package.

## Why Lazpho exists

Most applications behave well while their dependencies are healthy. Problems begin when demand exceeds the healthy capacity of a database, payment provider, AI API, storage service, or another finite resource. Without an admission boundary, more work continues to enter the system while existing work is already slowing down. Queues grow implicitly in sockets, connection pools, promises, and memory, often turning one slow dependency into an application-wide incident.

Lazpho makes that pressure explicit and bounded:

- **Protect dependency capacity.** Limit simultaneous work to a range the dependency can serve healthily.
- **Prevent unbounded waiting.** Use finite queues and queue-wait deadlines instead of allowing backlogs to grow invisibly.
- **Contain failures.** Isolate payment, search, email, AI, storage, and other workloads so one saturated dependency does not consume every available slot.
- **Recover predictably.** Circuit breaking, cancellation, timeouts, and graceful draining help the application stop adding harmful work and recover cleanly.
- **Adapt with guardrails.** Optional adaptive control can recommend or apply concurrency changes only within application-defined minimum and maximum bounds.
- **Observe the trade-offs.** Metrics distinguish accepted work, queue pressure, rejections, timeouts, failures, latency, and controller decisions.

The primary objective is **stability under pressure, not the largest possible requests-per-second result**. During overload, a protected application may deliberately reject excess work while completing admitted work with more predictable latency and recovering sooner. At healthy load, Lazpho adds coordination rather than capacity, so the visible benefit may be small.

## Where Lazpho fits best

Lazpho is most useful around asynchronous work whose concurrency directly affects a finite downstream resource.

| Scenario | How Lazpho helps |
| --- | --- |
| Database queries and writes | Keeps active operations aligned with the connection pool and the database's measured healthy capacity |
| Payment providers | Isolates payment traffic, bounds concurrent provider calls, and fails admission predictably during provider pressure |
| Email and notification APIs | Prevents a slow provider from consuming capacity needed by unrelated dependencies |
| AI and inference APIs | Bounds expensive, variable-latency requests and controls how much work may wait |
| Object storage and external HTTP APIs | Limits sockets and in-flight calls during throttling or degraded response times |
| Reports and background work | Stops expensive jobs from exhausting interactive application capacity |
| Variable-capacity dependencies | Adjusts concurrency within explicit bounds using observed latency, errors, throughput, and queue pressure |
| Graceful deployments | Stops new admission and drains work that was already accepted |

Create controllers around **real capacity pools**, not automatically around every route. Routes sharing one database normally share a database controller; independent services normally use separate controllers or bulkheads.

## When Lazpho is not the right tool

Do not use Lazpho around trivial synchronous code, cached property access, or work that has no constrained asynchronous dependency. It does not make CPU-bound JavaScript parallel; use worker threads or a separate compute service for that workload.

Lazpho also does not replace:

- database connection pools, query/index optimization, or caching;
- edge rate limiting, per-customer quotas, load balancing, or autoscaling;
- a durable broker or job queue such as BullMQ, Kafka, or SQS;
- cross-process or cross-host concurrency coordination;
- authorization, transaction design, payment idempotency, or reconciliation;
- a reverse proxy, service mesh, tracing backend, APM platform, or production load generator.

Controllers are process-local. For example, ten application replicas using a local limit of ten may collectively start approximately one hundred operations. Limits must therefore be chosen with replica count and downstream capacity in mind.

## Controlled rejection is a safety mechanism

When the configured queue is full, its wait deadline expires, or a circuit breaker is open, Lazpho rejects work explicitly instead of hiding overload in an ever-growing backlog. The application should map that outcome to an appropriate response, commonly `503 Service Unavailable`, and decide whether a bounded retry with backoff is safe.

Rejection should be exceptional overload behavior—not the normal state of a healthy application. Persistent rejection means the controller is too restrictive for the intended workload or the underlying dependency needs optimization, caching, additional capacity, or scaling. Increasing queue size alone only permits more waiting; it does not create capacity.

For payments and other critical mutations, combine Lazpho with an idempotency key and a durable workflow. Queue-admission failures occur before the submitted operation begins, but an execution timeout or lost client connection can be ambiguous because downstream work may already have started. Do not blindly retry an ambiguous mutation: query the provider using the idempotency key, process its webhook, or reconcile the durable pending record. Lazpho protects capacity; it does not provide delivery guarantees or transaction semantics.

## Install

Install the stable package:

```bash
npm install lazpho
```

Requires Node.js 18 or later. `lazpho` is ESM-only and has no runtime dependencies.

For a small end-to-end MongoDB + Express application, see the [Signalboard feedback SaaS](examples/feedback-board/README.md).

## Quick start

```ts
import { createFactory } from 'lazpho';

const factory = createFactory();
const work = factory.concurrency({ name: 'database', limit: 20, maxQueueSize: 200 });

const result = await work.run(({ signal }) => queryDatabase({ signal }));
await work.close();
factory.close();
```

Use `factory.adaptiveConcurrency(...)` when a fixed controller should adjust its limit from bounded controller metrics. Start with the [getting-started guide](docs/getting-started.md), follow the [adoption guide](docs/adoption-guide.md) for an existing application, and use the [testing guide](docs/testing.md) to verify real dependency bounds and recovery.

### Choose your path

| Goal | Read |
| --- | --- |
| Build a new Node.js application | [Getting started](docs/getting-started.md) |
| Add Lazpho to existing code | [Adoption guide](docs/adoption-guide.md) |
| Decide whether Lazpho fits | [Vision, fit, and limitations](docs/vision-and-usage.md) |
| Test an integration or contribute | [Testing guide](docs/testing.md) |
| See measured benefits and costs | [Signalboard example and comparison](docs/signalboard-comparison.md) |
| Operate and tune controllers | [Production operations](docs/operations.md) |
| Look up exact APIs | [API reference](docs/api.md) |

## Core API

```ts
import { createFactory } from 'lazpho';

const factory = createFactory({ enabled: true });

factory.recordRequest({
  route: '/users',
  method: 'GET',
  statusCode: 200,
  durationMs: 42
});

console.log(factory.getMetrics());
console.log(factory.getRouteMetrics('/users'));
```

Use `startRequest` when request lifecycle tracking is available:

```ts
const timer = factory.startRequest('/users', 'GET');
// Run application work.
timer.finish(200);
```

## Node HTTP adapter

```ts
import { createServer } from 'node:http';
import { createFactory } from 'lazpho';
import { instrumentNodeHttp } from 'lazpho/node-http';

const factory = createFactory();
const server = createServer(instrumentNodeHttp(factory, (_request, response) => {
  response.end('ok');
}));

server.listen(3000);
```

The adapter uses the pathname by default. In a framework adapter, supply the framework's matched route template (such as `/users/:id`) through its route callback to avoid high-cardinality URL paths.

## Metrics

`getMetrics()` returns global request statistics and a `routes` object. Each request metric includes `totalRequests`, `activeRequests`, `errors`, `requestsPerSecond`, `averageDurationMs`, `p50Ms`, `p95Ms`, and `p99Ms`. Resource metrics include event-loop lag, process memory bytes, and process CPU microseconds where Node exposes them.

Percentiles are calculated from a fixed-size circular sample (1,024 entries by default). Requests per second use a fixed 10-second rolling counter. Both can be configured, and per-route storage is capped at 100 distinct routes plus one `__other__` overflow bucket by default.

## Safety and overhead

- Request-path writes are constant time and allocation-light.
- Latency sorting happens only when metrics are read.
- All instrumentation operations are isolated so failures do not reach the host application.
- Request bodies and headers are never recorded.
- No synchronous filesystem or network operations occur in the request path.

Call `factory.close()` during application shutdown to disable event-loop monitoring.

## Concurrency control

Concurrency control bounds simultaneous asynchronous work. It protects a backend and its constrained dependencies from uncontrolled parallel demand; it does not magically add capacity or improve an unconstrained workload's throughput.

```ts
const orders = factory.concurrency({
  name: 'orders',
  limit: 50,
  maxQueueSize: 1_000
});

const order = await orders.run(() => createOrder());
```

At most `limit` operations run at once. Further operations wait in FIFO order. A controller has a default `maxQueueSize` of 1,000; a full queue rejects with `QueueFullError` rather than consuming unbounded memory.

Use `AbortSignal` to cancel work that has not begun. Cancellation does not interrupt already-running work.

```ts
await orders.run(() => createOrder(), { signal: request.signal });

orders.setLimit(80);
console.log(orders.getLimit());
console.log(orders.stats());
```

Increasing a limit immediately starts eligible queued work. Reducing a limit never cancels work already running; it prevents additional starts until active work falls below the new limit.

`stats()` returns `active`, `queued`, `completed`, `failed`, `rejected`, `limit`, plus bounded queue-wait, execution, and total-time averages and percentiles. Factory-wide metrics expose named controller snapshots in `getMetrics().controllers`, and `getConcurrencyMetrics(name)` retrieves one controller.

Controller names are developer-provided and capped at 100 per factory by default (`maxControllers`) to keep metrics cardinality bounded. They must be unique within a factory. The implementation is in-process only: it does not coordinate limits across Node processes, hosts, or replicas.

## Deterministic backpressure

Backpressure limits how much work may wait once execution capacity is occupied. It protects an in-process workload from an unlimited backlog; it is not a durable queue or a replacement for BullMQ, Kafka, SQS, or similar systems.

```ts
const orders = factory.concurrency({
  name: 'orders',
  limit: 50,
  maxQueueSize: 500,
  maxQueueWaitMs: 2_000
});
```

The queue is FIFO and bounded. When full, `run()` immediately rejects with `QueueFullError` (`FACTORY_BACKPRESSURE_REJECTED`). A queued operation that exceeds `maxQueueWaitMs` rejects with `QueueWaitTimeoutError` (`FACTORY_QUEUE_WAIT_TIMEOUT`) and is removed before it can run. AbortSignals similarly remove queued work without interrupting running work.

`controller.stats()` exposes queue capacity/utilization, accepted work, full-queue rejections, queue timeouts, queued aborts, and bounded queue-wait percentiles. Adaptive concurrency controls how much work executes; deterministic backpressure controls how much may wait. Rejected work is the application's responsibility to handle.

## Bulkhead isolation

Optional bulkheads isolate independent dependency workloads inside one controller. Each named bulkhead has its own FIFO queue and concurrency ceiling, while the controller's `limit` and `maxQueueSize` remain authoritative aggregate limits.

```ts
const dependencies = factory.concurrency({
  name: 'dependencies',
  limit: 12,
  maxQueueSize: 100,
  bulkheads: {
    payments: { maxConcurrent: 5, maxQueue: 20 },
    search: { maxConcurrent: 10, maxQueue: 50 }
  }
});

await dependencies.run(
  () => callPayments(),
  { bulkhead: 'payments' }
);
```

A named task starts only when both global and local concurrency are available. A waiting task is accepted only when both the aggregate queue and its local queue have space. Aggregate queue capacity is not multiplied by the number of bulkheads. Local saturation rejects with `BulkheadQueueFullError`; an unconfigured name rejects with `UnknownBulkheadError`; aggregate saturation continues to use `QueueFullError`.

Scheduling rotates across runnable partitions and preserves FIFO order within each one. Consequently, a saturated `payments` partition cannot leave runnable `search` work stuck behind its queue. Calls without `bulkhead` use an internal default partition and retain the original controller behavior; that internal partition is not exposed in metrics.

Retries keep their original bulkhead and re-enter normal global/local admission after releasing capacity for the retry delay. Queued cancellation and queue-wait timeout unlink only the selected partition entry. Active cancellation remains cooperative and retains both slots until the task settles. Breaker checks occur before public admission and again before queued execution, so breaker-rejected entries release queue accounting and cannot strand shutdown. Runtime limit reductions pause all partitions until aggregate active work is below the new limit, and `close()` continues draining accepted work across the default and all named partitions.

`stats().bulkheads` returns immutable snapshots containing `active`, `queued`, `maxConcurrent`, `maxQueue`, and `rejected` for each named bulkhead. Global stats add `bulkheadRejected`; global outcome counters are not duplicated per partition.

## Queue-Pressure-Aware Adaptive Concurrency

Adaptive concurrency controls how much work runs at once; backpressure controls how much may wait. Queue-aware adaptive concurrency uses queue pressure as additional evidence when deciding to increase, hold, or decrease execution concurrency.

```ts
const work = factory.concurrency({
  name: 'orders-work',
  limit: 10,
  maxQueueSize: 100
});

const adaptive = factory.adaptiveConcurrency({
  name: 'orders-control',
  controller: work,
  minLimit: 10,
  maxLimit: 100,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  queuePressure: {
    maxUtilization: 0.8,
    maxQueueWaitP95Ms: 150,
    maxRejectionRate: 0.01,
    maxTimeoutRate: 0.005
  },
  mode: 'auto'
});

adaptive.evaluateFromMetrics(); // call periodically at an application-owned boundary
```

Healthy queue signals allow normal probing. High queue utilization or queue wait causes a hold, while meaningful queue rejections or timeouts cause deterministic backoff. A high queue does not automatically mean concurrency should decrease: Factory evaluates pressure together with latency, throughput, and errors. `observe` and `recommend` remain read-only; only `auto` applies safe limit changes.

Queue capacity and maximum wait remain fixed. This is in-process control, not durable queuing, distributed coordination, server autoscaling, or a guarantee of better throughput than a correctly tuned fixed limit.

## Read-only adaptive decisions

The adaptive controller evaluates already-aggregated backend observations and recommends a safe next concurrency limit. It uses an exponentially weighted moving average (EWMA) for P95 latency, throughput, and error rate, then applies a deterministic additive-increase/multiplicative-decrease policy with hysteresis.

```ts
const adaptive = factory.adaptiveConcurrency({
  name: 'orders',
  minLimit: 10,
  maxLimit: 200,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  mode: 'recommend'
});

const decision = adaptive.evaluate({
  timestamp: Date.now(),
  currentLimit: 50,
  active: 47,
  queued: 12,
  throughput: 350,
  p95Ms: 120,
  errorRate: 0.002
});
```

Healthy, throughput-improving windows can increase by `increaseStep`. Latency and error violations back off multiplicatively; errors use the stronger `errorDecreaseFactor`. Every proposal is clamped between `minLimit` and `maxLimit`. Evaluation calls are interval-gated (default five seconds), and healthy/unhealthy evidence must persist for configurable consecutive evaluations before normal probing/backoff.

Defaults are `increaseStep: 1`, `decreaseFactor: 0.8`, `errorDecreaseFactor: 0.5`, `ewmaAlpha: 0.2`, `healthyEvaluations: 2`, `unhealthyEvaluations: 2`, and `minThroughputImprovementRatio: 0.01`.

`mode` may be `observe`, `recommend`, or `auto`. An adaptive controller without a linked fixed controller returns decisions with `willApply: false`; it cannot change application concurrency.

The controller starts in `warmup`, then exposes `probing`, `stable`, or `backing_off` state through `state()`. Decisions include a deterministic reason and smoothed signals for logging or inspection. It consumes aggregate observations only and creates no timers or background polling.

Read-only decisions are in-process and depend on caller-provided aggregate observations. Link a fixed controller to apply decisions as described next.

## Applying adaptive decisions

A linked adaptive evaluator can update an existing fixed controller. Call `evaluateFromMetrics()` at an application reporting boundary to derive aggregate observations from the controller's bounded metrics; interval gating prevents repeated decisions within a window.

Creating the adaptive controller does **not** start a background evaluation loop. The application must call `evaluateFromMetrics()` periodically (normally once per configured `evaluationIntervalMs`) for closed-loop changes to occur. Calls made sooner than the configured interval hold with `insufficient_data`; `recommend` remains read-only, while only a linked controller in `auto` mode can apply a new limit.

```ts
const work = factory.concurrency({ name: 'orders-work', limit: 10 });
const adaptive = factory.adaptiveConcurrency({
  name: 'orders-control',
  controller: work,
  minLimit: 10,
  maxLimit: 100,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  mode: 'auto'
});

adaptive.evaluateFromMetrics();
console.log(adaptive.stats());
```

`observe` and `recommend` modes always remain read-only. In `auto` mode, Factory applies only non-hold decisions whose proposed limit is independently clamped to the configured bounds and still matches the fixed controller's current limit. Failures in the adaptive layer safely hold the current limit. When a limit decreases, active operations continue while new work waits until the lower limit permits it.

`stats()` exposes current/proposed limit, increases, decreases, holds, bounded decision history (50 entries by default), controller state, last decision, and time at the current limit. This is application-level concurrency control, not server or Kubernetes autoscaling, and it cannot guarantee increased throughput.

## Adaptive backpressure observability

Closed-loop adaptive controllers expose an immutable point-in-time `snapshot()` for application logs and metrics bridges. Optional hooks run after each controller evaluation window; they receive copies and their failures are ignored, so observability cannot affect admission or controller decisions.

```ts
const limiter = factory.adaptiveConcurrency({
  name: 'orders-control',
  controller: orders,
  minLimit: 10,
  maxLimit: 100,
  targetP95Ms: 200,
  maxErrorRate: 0.01,
  mode: 'auto',
  onDecision(event) {
    console.log(event.action, event.reason, event.previousLimit, event.nextLimit);
  },
  onMetrics(snapshot) {
    console.log(snapshot.active, snapshot.queued, snapshot.latencyEwmaMs);
  }
});

console.log(limiter.snapshot());
```

The snapshot includes the current limit, active/queued work, accepted/rejected/completed/failed counters, latency and error EWMAs, controller bounds, and the last decision event. Hooks can later feed Prometheus, OpenTelemetry, Datadog, or application logs without adding dependencies to Lazpho.

## Runtime adaptive configuration

Closed-loop adaptive controllers can atomically update `minLimit`, `maxLimit`, and `targetP95Ms` at runtime. Other settings, including queue capacity, queue wait timeout, AIMD factors, EWMA tuning, and queue-pressure thresholds, require creating a new controller.

```ts
// During an operational event, temporarily cap a dependency at 40 operations.
limiter.updateConfig({ maxLimit: 40 });
```

Updates are fully validated before they are applied. Invalid updates throw and leave the previous configuration, limit, queue, adaptive EWMAs, counters, and decision history unchanged. If a new bound excludes the current limit, Factory clamps the linked fixed controller to the nearest valid limit. Lowering a limit never cancels active or queued work: active operations finish normally, and queued work starts only when capacity becomes available.

## Graceful limiter shutdown

Both fixed concurrency controllers and closed-loop adaptive limiters provide `close()`. Closing is idempotent and follows `running → draining → closed`: new work rejects with `ControllerLifecycleError`, while work accepted before closure—including queued work—continues until it settles.

```ts
await limiter.close();
console.log(limiter.snapshot().lifecycle); // "closed"
```

`close()` resolves only after active and queued work drains. Task failures retain their normal task-level errors and do not reject shutdown. Runtime `updateConfig()` calls are allowed only while the limiter is `running`; they reject during `draining` or `closed`. The library installs no process signal handlers or shutdown polling loops.

## Cancellation and execution timeouts

`run()` remains compatible with zero-argument tasks and may now receive a cooperative cancellation context. An external `AbortSignal` cancels queued work immediately or aborts the signal supplied to active work. Active JavaScript is never forcibly stopped and retains its concurrency slot until its promise settles.

```ts
const abort = new AbortController();
const result = work.run(
  async ({ signal }) => fetch(url, { signal }),
  { signal: abort.signal, timeoutMs: 5_000 }
);

abort.abort();
await result;
```

`timeoutMs` must be positive and begins only when the task enters active execution; queue wait does not consume it. A caller cancellation rejects with `ControllerAbortError`; an execution timeout uses `ControllerTimeoutError`. Timers and external abort listeners are removed when work settles. Caller cancellation is excluded from adaptive failure accounting, while a task that cooperatively rejects after an execution timeout remains a normal failed execution signal. Calling `close()` drains accepted work and does not abort it; accepted queued and active tasks retain their cancellation/timeout behavior during draining.

## Bounded execution retries

Retries are opt-in per `run()` call and default to disabled. `retry.attempts` is the number of retries **after** the initial execution, so `attempts: 2` permits at most three executions. The task context exposes a one-based `attempt` number alongside its cancellation `signal`.

```ts
const order = await orders.run(
  async ({ signal, attempt }) => submitOrder({ signal, attempt }),
  { retry: { attempts: 2, delayMs: 50 } }
);
```

Only ordinary task failures retry by default. Caller cancellation, execution timeout, queue-full rejection, queue-wait timeout, lifecycle rejection, and configuration validation errors never retry. `shouldRetry(error, attempt)` can further decline an otherwise retryable task error; it cannot make these safety errors retryable. A final exhausted chain rejects with its final original task error.

Every retry is real work: it releases the previous active slot, waits the fixed `delayMs`, then re-enters the normal FIFO controller admission path. It has no priority, can queue, and can be rejected when the shared queue is full. Retry delay never consumes an active slot. `timeoutMs` applies independently to each admitted attempt; it does not include retry delay or earlier attempts.

An already-accepted retry chain remains eligible to finish while `close()` drains, but new public `run()` calls still reject during draining. Caller cancellation during retry delay cancels the timer and terminates the chain. There is no global retry budget in this small initial implementation: amplification is bounded by the per-operation retry count, shared queue capacity, normal concurrency limit, and no-priority admission. `stats()` exposes `retriesAttempted`, `retrySuccesses`, and `retryExhausted`; every admitted retry remains visible in normal execution latency, failure, throughput, and adaptive-controller pressure.

## Optional circuit breaker

Configure a breaker on an individual concurrency controller to protect one dependency. It is disabled unless `circuitBreaker` is supplied and cannot be changed after construction.

```ts
const payments = factory.concurrency({
  name: 'payments',
  limit: 20,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10_000, halfOpenMaxAttempts: 1 }
});
```

The breaker starts `closed`, opens after the configured number of consecutive task failures or execution timeouts, and rejects later work immediately with `CircuitBreakerOpenError`. It creates no cooldown timer: after `resetTimeoutMs`, the next admission lazily transitions it to `half_open`, where only `halfOpenMaxAttempts` probes may run. Successful probes close the breaker; a failed probe reopens it. Caller cancellation, queue-full/wait rejection, and lifecycle rejection do not affect breaker health.

Breaker-open work consumes no queue slot, active slot, or latency sample. Queued work accepted before opening is checked again before callback execution and rejects safely if still open. Retries are also checked on every admission, so an opened breaker stops pending retries. `close()` remains authoritative for new public work and drains accepted work without waiting for cooldown. Controller `stats()` and adaptive `snapshot()` expose immutable breaker state and trip/rejection/probe/recovery counters.

## Production dependency adapters

### Protected functions

`createProtectedFunction` turns a dependency function into one Lazpho-controlled logical operation while retaining argument and result inference. The callback receives the usual `{ signal, attempt }` context. Defaults are static; the returned function's `.run()` method provides shallow per-call overrides when needed (`retry` is replaced as one object).

```ts
import { createProtectedFunction } from 'lazpho';

const capturePayment = createProtectedFunction(
  dependencies,
  async ({ signal }, payment: { amount: number }) =>
    paymentsClient.capture(payment, { signal }),
  {
    bulkhead: 'payments',
    timeoutMs: 1_000,
    retry: { attempts: 1, delayMs: 25 }
  }
);

await capturePayment({ amount: 2_500 });
await capturePayment.run({ signal: requestSignal }, { amount: 2_500 });
```

Pass `thisArg` in the defaults when wrapping an unbound object method. The wrapper calls `controller.run()` exactly once per logical invocation: concurrency, queues, retry attempts, breaker decisions, timeout, cancellation, metrics, and lifecycle all remain controller-owned.

### Protected fetch

`lazpho/fetch` exports `createProtectedFetch`. It accepts native fetch options plus Lazpho's `bulkhead`, `timeoutMs`, and `retry` options.

```ts
import { createProtectedFetch } from 'lazpho/fetch';

const protectedFetch = createProtectedFetch({
  controller: dependencies,
  fetch: globalThis.fetch,
  defaults: { bulkhead: 'payments', timeoutMs: 1_000 }
});

const response = await protectedFetch('https://payments.internal/capture', {
  method: 'POST',
  body: JSON.stringify({ amount: 2_500 }),
  signal: requestSignal,
  retry: { attempts: 1 }
});
```

The adapter supplies the fetch implementation with Lazpho's execution signal. That signal is aborted by either the caller signal or the controller execution timeout, so the adapter needs no second timeout and installs no signal listeners of its own. HTTP 4xx/5xx responses retain native fetch behavior and resolve normally. Throw explicitly if a response status should count as a failure for retries, breaker health, or adaptive metrics. Controller retries only thrown errors; retrying requests with streaming or otherwise non-replayable bodies is the application's responsibility.

### Incoming request cancellation

`lazpho/node-http` exports `createRequestAbortSignal(request, response?)`. Passing the response lets it cover disconnects after an incoming request body has completed. The signal aborts for request abort, premature request/response closure, or socket closure, and `dispose()` removes every installed listener. Normal response completion disposes it automatically.

```ts
const requestAbort = createRequestAbortSignal(request, response);
try {
  const result = await capturePayment.run(
    { signal: requestAbort.signal },
    { amount: 2_500 }
  );
  response.end(JSON.stringify(result));
} finally {
  requestAbort.dispose();
}
```

The complete Node flow is available in `src/example/production-integration.ts`: incoming request cancellation flows into protected fetch, then through global admission, the payments bulkhead, retry/breaker/timeout handling, and finally graceful controller shutdown.

### Integration error handling

Existing error classes and codes remain stable. `isLazphoError()` narrows unknown errors, while `classifyLazphoError()` returns a small category such as `queue_full`, `bulkhead_queue_full`, `timeout`, `aborted`, `breaker_open`, or `lifecycle`.

```ts
try {
  await capturePayment(payment);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    return dependencyUnavailable();
  }
  if (isLazphoError(error)) {
    console.warn(error.code, classifyLazphoError(error));
  }
  throw error;
}
```

## Metrics export and OpenTelemetry integration

The framework-neutral pull API returns a fresh, deeply immutable snapshot. Collection is explicit: creating a collector installs no timer, listener, background task, or network exporter.

```ts
import { createMetricsCollector, createMetricsExporter } from 'lazpho/observability';

const collect = createMetricsCollector(orders, adaptive);
const snapshot = collect(); // map this to Prometheus, logs, or a custom metrics system

const exporter = createMetricsExporter(orders, {
  adaptive,
  export: (current) => customMetricsBackend.write(current),
  onError: (error) => reportExportFailure(error)
});

exporter.export(); // push once when the application chooses
exporter.dispose();
```

Exporter and `onError` failures are contained and never enter controller admission, scheduling, retry, breaker, or adaptive-control paths. `dispose()` is idempotent and releases the collector and callback references; it does not close the controller or adaptive controller.

For OpenTelemetry, inject an application-owned `Meter`. Lazpho does not import an SDK, create a provider, register global state, select an exporter, or schedule collection.

```ts
import { createLazphoOpenTelemetry } from 'lazpho/opentelemetry';

const telemetry = createLazphoOpenTelemetry({
  controller: orders,
  adaptive,
  meter: meterProvider.getMeter('orders'),
  attributes: { service: 'checkout' },
  onError: (error) => reportExportFailure(error)
});

telemetry.dispose(); // unregisters the exact batch callback
```

Controller active work, queued work, limit, lifecycle, breaker state, bulkhead occupancy/capacity, and stable adaptive signals are observable gauges. Completed, failed, cancelled, timed-out, rejected, retry, breaker-transition, and bulkhead-rejection values are cumulative observable counters. Repeated SDK collections observe the current total; they do not add that total again.

Metric names are stable and exported in `LAZPHO_OTEL_METRIC_NAMES`:

- `lazpho.controller.*` covers active, queued, limit, and lifecycle.
- `lazpho.operations.*` covers completed, failed, cancelled, timed-out, and rejection totals.
- `lazpho.retry.*`, `lazpho.breaker.*`, and `lazpho.bulkhead.*` cover their bounded subsystem signals.
- `lazpho.adaptive.*` exposes latency EWMA, error rate, and target latency when an adaptive controller is supplied.

Lifecycle values are `running=0`, `draining=1`, and `closed=2`; breaker state values are `closed=0`, `open=1`, and `half_open=2`. Bulkhead observations use only configured bulkhead names. Default attributes contain the controller name plus optional fixed attributes supplied at setup.

Keep attributes bounded. Do not attach request IDs, raw URLs, user or tenant IDs, task IDs, arbitrary error messages, or stack traces. The integration intentionally has no per-request attribute callback and exports only configured controller/bulkhead names and stable adaptive fields.

## Configuration presets and inspection

`lazpho/config` provides four deterministic starting points. Presets do not inspect hardware, environment variables, memory, or container limits, and no preset name remains attached to a running controller.

| Preset | Intended posture | Initial | Min–max | Queue / wait | Target P95 |
| --- | --- | ---: | ---: | ---: | ---: |
| `conservative` | Cautious initial rollout | 4 | 2–8 | 16 / 500 ms | 250 ms |
| `balanced` | General-purpose starting point | 8 | 4–32 | 64 / 1,000 ms | 200 ms |
| `latencySensitive` | Tight queue and faster protection | 4 | 2–16 | 8 / 150 ms | 100 ms |
| `throughputOriented` | Higher bounded headroom for a proven dependency | 16 | 8–64 | 128 / 2,000 ms | 300 ms |

These are safe starting points, not universal tuning recommendations. Benchmark against the real dependency, observe P95 latency and throughput, and adjust explicit limits before production rollout. Presets intentionally enable no breaker, retry, or application-specific bulkhead.

```ts
import { createFactory } from 'lazpho';
import { createLazphoPreset, inspectLazphoConfig } from 'lazpho/config';

const config = createLazphoPreset('balanced', {
  concurrency: {
    name: 'orders',
    bulkheads: { payments: { maxConcurrent: 8, maxQueue: 32 } }
  },
  adaptive: { name: 'orders-adaptive', maxLimit: 48, targetP95Ms: 150 }
});

const inspected = inspectLazphoConfig(config);
for (const warning of inspected.warnings) console.warn(warning.code, warning.field, warning.message);

const factory = createFactory();
const orders = factory.concurrency(config.concurrency);
const adaptive = factory.adaptiveConcurrency({ ...config.adaptive, controller: orders });
```

Resolution is `base → explicit overrides → validation → deep freeze`. Primitive fields are shallow overrides. `adaptive.queuePressure` is a documented partial merge. `concurrency.circuitBreaker` and the complete `concurrency.bulkheads` record are full replacements; bulkheads are never invented or merged by name. All resolved values are ordinary controller options and are JSON-serializable. Callback fields and function source are not accepted by the preset/inspection model.

`validateLazphoConfig(config)` throws the same `TypeError` or `RangeError` used by controller construction. `resolveLazphoConfig(base, overrides)` applies controller defaults and returns an immutable resolved object. `inspectLazphoConfig(config)` returns that object plus an immutable summary and deterministic advisory warnings. Hard validation failures are never downgraded to warnings.

Stable warning codes are:

- `LARGE_QUEUE_TO_CONCURRENCY_RATIO` and `LARGE_BULKHEAD_QUEUE_RATIO` for queues over twenty times their applicable concurrency.
- `INITIAL_LIMIT_NEAR_MAXIMUM` when the initial limit is at least 90% of a non-fixed adaptive range.
- `FIXED_EFFECTIVE_ADAPTIVE_LIMIT` when auto mode has equal minimum and maximum limits.
- `BULKHEAD_EXCEEDS_GLOBAL_LIMIT` when a local maximum cannot be reached under the global maximum.
- `VERY_LOW_LATENCY_TARGET` for targets below 10 ms that may be dominated by runtime noise.

Warnings are produced only during explicit inspection; Lazpho never logs them or repeats them during operation. After construction, the existing `adaptive.updateConfig()` remains the only supported runtime mutation path and still permits only `minLimit`, `maxLimit`, and `targetP95Ms`.

For production, start with `balanced`, keep every queue bounded, add retries only for operations known to be safe and transient, enable a breaker only with dependency-specific thresholds, and use named bulkheads for independent failure domains.

## Framework integrations

Express, Fastify, and NestJS integrations are optional peer-based subpaths. Each application or dependency owns a shared controller; adapters create only lightweight request helpers and never create a controller per request. Framework cancellation and an explicitly supplied `RunOptions.signal` are composed, so either can cancel admission or cooperatively abort active work. An active operation retains its controller and bulkhead slots until its promise actually settles.

Adapters do not replay handlers, add route timeouts, create breaker state, resize bulkheads, install process signal handlers, or emit request metadata as metric attributes. Retry, dependency-operation timeout, breaker, queue, and bulkhead behavior remain controller-owned. A returned bulkhead name must match a statically configured controller bulkhead.

### Express

```ts
import express from 'express';
import {
  createLazphoExpress,
  createLazphoExpressErrorHandler,
  getLazphoExpress,
  shutdownLazphoExpress
} from 'lazpho/express';

const app = express();
app.use(createLazphoExpress({
  controller: dependencies,
  bulkheadForRequest: (request) => request.path === '/pay' ? 'payments' : undefined
}));

app.post('/pay', async (request, response, next) => {
  try {
    const result = await getLazphoExpress(request).run(
      ({ signal }) => paymentClient.capture({ signal }),
      { timeoutMs: 1_000 }
    );
    response.json(result);
  } catch (error) { next(error); }
});

app.use(createLazphoExpressErrorHandler());
// During explicit application shutdown:
await shutdownLazphoExpress(server, dependencies);
```

The middleware reuses the Node request-abort bridge and removes its request, response, and socket listeners on completion or disconnect. `getLazphoExpress()` avoids global Express prototype mutation. The shutdown helper explicitly stops acceptance and drains the supplied controller; ordinary middleware registration never assumes ownership.

### Fastify

```ts
import { lazphoFastifyPlugin, createLazphoFastifyErrorHandler } from 'lazpho/fastify';

await app.register(lazphoFastifyPlugin, {
  controller: dependencies,
  bulkheadForRequest: (request) => request.routeOptions.url === '/pay' ? 'payments' : undefined,
  closeControllerOnShutdown: false
});

app.setErrorHandler(createLazphoFastifyErrorHandler());
app.post('/pay', async (request) => request.lazpho.run(
  ({ signal }) => paymentClient.capture({ signal }),
  { timeoutMs: 1_000 }
));
```

The plugin uses Fastify decorations and official request/error/response/close hooks. `fastify.lazpho` is the supplied shared controller and `request.lazpho` is request-scoped. Set `closeControllerOnShutdown: true` only when this registration owns the controller; the default leaves externally supplied/shared controllers open.

### NestJS

```ts
import { Inject } from '@nestjs/common';
import { LAZPHO_CONTROLLER, LazphoModule } from 'lazpho/nestjs';
import type { ConcurrencyController } from 'lazpho';

@Module({
  imports: [LazphoModule.register({
    controller: dependencies,
    closeControllerOnShutdown: false
  })]
})
export class AppModule {}

export class PaymentsService {
  constructor(@Inject(LAZPHO_CONTROLLER) private readonly lazpho: ConcurrencyController) {}

  capture() {
    return this.lazpho.run(({ signal }) => paymentClient.capture({ signal }), {
      bulkhead: 'payments',
      timeoutMs: 1_000
    });
  }
}
```

`createLazphoNestInterceptor()` is an explicit optional interceptor for request cancellation and `getLazphoNest(request)` access; the module does not globally limit routes. It works with Nest's Express or Fastify HTTP request wrappers through the shared Node bridge. Nest owns process signals. Setting `closeControllerOnShutdown: true` adds an application-shutdown hook that closes only the controller explicitly marked as adapter-owned.

### HTTP error mapping

All framework subpaths expose `mapLazphoErrorToHttp()`. Saturation, open-breaker, and lifecycle errors map to `503`; execution and queue-wait timeouts map to `504`; caller aborts and ordinary task errors remain unmapped. Default response helpers emit only `{ code }`, never raw messages, stacks, queue capacity, or controller configuration. Express and Fastify error handlers are opt-in, and custom mapping failures stay in the framework request path rather than controller internals.

### Reusable application integration and dashboard

`lazpho/application` centralizes named capacity-pool controllers, optional linked adaptive policies, stable route-to-controller mappings, safe scenario registration, and an opt-in loopback dashboard. It is intended to be initialized once per application process.

```ts
import { createLazphoApplication, startLazphoDashboard } from 'lazpho/application';

const lazpho = createLazphoApplication({
  controllers: {
    database: { limit: 8, maxQueueSize: 64, maxQueueWaitMs: 500 },
    payments: { limit: 4, maxQueueSize: 24 }
  },
  routeControllers: {
    '/users/:id': ['database'],
    '/checkout': ['database', 'payments']
  }
});

const dashboard = await startLazphoDashboard({
  application: lazpho,
  scenarios: [{
    name: 'read-users',
    description: 'Application-owned safe read scenario',
    run: async ({ signal }) => {
      await exerciseKnownSafeReads(signal);
      return { outcomes: { success: 10 } };
    }
  }]
});
```

The dashboard defaults to `http://127.0.0.1:1912`, rejects non-loopback binding, protects mutations with a per-instance token plus Host/Origin checks, and can run only explicitly registered callbacks. It never crawls routes or manufactures requests to delete, payment, email, admin, or other potentially destructive APIs. Express, Fastify, and NestJS adapters accept an optional `factory` plus stable route resolver so one registration can collect inbound metrics for every framework route. Adaptive evaluation remains application-owned through `lazpho.evaluateAdaptive()`.

See [application integration](docs/application-integration.md) for lifecycle, framework, scenario, and diagnostic guidance. The separate opt-in [Load Lab](docs/load-lab.md) provides per-endpoint checks and conservative load reports at `http://127.0.0.1:1913` by default. For an existing OpenAPI application, start it with `npx lazpho load-lab --target http://127.0.0.1:3000 --openapi /openapi.json`; only parameter-free GET/HEAD operations are enabled automatically. Authenticated checks can read a short-lived credential through `--header-env authorization:ENVIRONMENT_VARIABLE` without placing its value in command arguments.

## Package API and release notes

The public entry point exports `createFactory`, `createProtectedFunction`, error classification helpers, public controller/configuration/snapshot/lifecycle/run types, and distinguishable controller errors. Error instances retain their classes and expose stable `FACTORY_*` codes plus small immutable metadata fields such as controller, bulkhead, and capacity.

The supported runtime matrix, twelve public package subpaths, ESM policy, TypeScript range, and framework peer ranges are defined in [Compatibility and public API stability](docs/compatibility.md). Node 22 and 24 are the actively maintained targets as of September 2026; Node 18 and 20 remain API-compatibility targets but are upstream EOL. Lazpho is Node-oriented, ESM-only, and makes no browser, CommonJS, Bun, or Deno compatibility promise.

`lazpho/config` exposes deterministic preset, resolution, validation, and inspection helpers. `lazpho/application` exposes the central application registry and safe scenario dashboard. `lazpho/load-lab` exposes explicit fixture-managed endpoint tests, while `lazpho/openapi-load-lab` and the `lazpho` CLI provide conservative OpenAPI discovery. `lazpho/fetch` exposes protected native-fetch integration. `lazpho/node-http` exposes instrumentation and incoming request cancellation primitives. `lazpho/observability` exposes immutable pull collection and manual push export, while `lazpho/opentelemetry` exposes the optional injected-Meter bridge. `lazpho/express`, `lazpho/fastify`, and `lazpho/nestjs` are isolated optional framework adapters. Adapter and Load Lab code are not imported by the main entry point. Adaptive policy internals, EWMA helpers, queue entries, and scheduling helpers are intentionally not public API.

The package ships ESM JavaScript and TypeScript declarations from `dist`, its documentation, changelog, security policy, contributing guide, README, and MIT license. Benchmarks are environment-specific and demonstrate probing, protection, queue drain, and recovery rather than throughput or latency guarantees. Canonical repository, issue, homepage, and security-reporting metadata point to `diveshshubham/lazpho`.

### Documentation

- [Getting started](docs/getting-started.md): installation, first protected dependency, error mapping, shutdown, and next steps.
- [Adoption guide](docs/adoption-guide.md): introducing Lazpho safely into an existing application.
- [Testing guide](docs/testing.md): application tests, Load Lab, A/B comparisons, repository gates, and honest load interpretation.
- [Signalboard example and comparison](docs/signalboard-comparison.md): runnable architecture, measured benefits, costs, and limitations.
- [Vision, fit, and limitations](docs/vision-and-usage.md): objectives, correct integration, beneficial and inappropriate uses, limitations, and responsible proof.
- [API reference](docs/api.md): entry points, errors, public types, metrics, and HTTP mapping.
- [Operations guide](docs/operations.md): architecture, tuning, failure handling, cardinality, and troubleshooting.
- [Load Lab](docs/load-lab.md): safe endpoint registration, dashboard actions, reports, and honest RPS interpretation.
- [Signalboard validation](docs/signalboard-validation.md): reproducible stress, soak, MongoDB A/B, and real-dashboard evidence.
- [Sagavoya authenticated validation](docs/sagavoya-validation.md): existing-application queue tuning, sustained overload, recovery, and explicit release-gate failures.
- [MongoDB fault validation](docs/mongodb-fault-validation.md): controlled latency, transport loss, breaker recovery, and mixed-fault soak evidence.
- [MongoDB replica-set validation](docs/mongodb-replica-set-validation.md): real three-member elections, majority durability checks, and bounded application recovery evidence.
- [Compatibility contract](docs/compatibility.md): supported runtimes, TypeScript/framework matrix, and public surface.
- [Versioning policy](docs/versioning.md): stable versus internal APIs, SemVer, deprecation, and release notes.
- [Migration guide](docs/migration.md): package rename and future breaking-release instructions.
- [Bottleneck lab](docs/bottleneck-lab.md): full-path scenarios, dashboard, and controller-placement guidance.
- [Application integration](docs/application-integration.md): reusable registry, safe scenarios, and loopback dashboard.
- [Application benchmark](docs/application-benchmark.md): sustained traffic, adaptive decisions, overload, and recovery.
- [1.0 readiness checklist](docs/1.0-readiness.md): machine gates and remaining human/external decisions.
- [Changelog](CHANGELOG.md), [security policy](SECURITY.md), and [contributing guide](CONTRIBUTING.md).

Starting with `1.0.0`, the documented exports follow Semantic Versioning and are snapshot-gated. Scheduler/EWMA/AIMD internals, queue nodes, benchmarks, and stress/soak harnesses remain internal. Deep imports are unsupported. See the readiness checklist for the evidence used to approve the stable contract.

## Manual Adaptive Demo

Run the local Node HTTP demo in one terminal:

```bash
npm install
npm run demo:adaptive
```

Then generate enough concurrent load to exceed the simulated backend's healthy region in another terminal:

```bash
npm run load:adaptive
```

`GET /work` uses a fixed controller and simulates a resource that is fast up to 40 active operations, slows progressively between 41 and 55, and becomes slow with deterministic failures above 55. Every two seconds, the demo derives observations through `evaluateFromMetrics()` and prints the applied adaptive decision. Visit `http://localhost:3000/factory` to inspect the current limit, decision, smoothed signals, controller activity, and limit-change counters.

## Development

```bash
npm install
npm test
npm run package:build
npm run api:check
npm run compat
npm run example
npm run benchmark
npm run benchmark:concurrency
npm run benchmark:adaptive
npm run benchmark:observability
npm run bench:adaptive
npm run bench:saturation
npm run bench:application
npm run lab:bottleneck
npm run lab:bottleneck:smoke
npm run stress
npm run soak
npm run soak:long
```

### CI and release safety

GitHub Actions runs core test/build/package validation on Node 18, 20, 22, and 24. Separate jobs gate the public API contract, TypeScript 5.7.2/current declarations, minimum/current framework boundaries, packed consumers, stress, short soak, package contents, and functional benchmarks. Node 18 and 20 remain compatibility targets, not recommendations for upstream-supported deployments. The long resource soak runs weekly and can also be dispatched manually.

The protected `master` branch requires the four `Node … core test/build` jobs plus `API contract`, `Package verify`, `Stress`, and `Short soak`. Pull requests require review, stale approvals are dismissed, conversations must be resolved, and force pushes and deletion are disabled.

Release preparation is intentionally maintainer-controlled:

1. Update `package.json#version` to canonical SemVer and intentionally review any API snapshot changes.
2. Prepare release notes, run `npm run release:dry-run`, and inspect `artifacts/package-manifest.json`, the versioned tarball, and its `.sha256` file.
3. Commit the version, wait for CI, and create a matching `v<package-version>` tag. For a manual release-workflow dry run, select that tag as the workflow ref and enter the same tag as the input; manual dispatch never publishes.
4. A tag-triggered workflow repeats every release gate, validates one exact tarball, uploads it, checks that the npm version is unused, and publishes that same tarball. Stable versions use `latest`, `beta` prereleases use `beta`, and other prereleases use `next`.
5. The GitHub Release is created only after npm publication. If that final step fails, recover by creating the GitHub Release manually; never republish or unpublish the immutable npm version.

The package is owned by the npm maintainer. The tag workflow uses npm trusted publishing from `diveshshubham/lazpho` and `release.yml`; it has no long-lived publish token. The publish job has scoped `id-token: write`, and only the post-publish GitHub Release job receives `contents: write`.

`npm run release:check` performs the release-critical local tests without publishing. `npm run release:dry-run` adds deterministic stress and short soak gates. Neither command changes the package version or API snapshots.

The example emits global resources and per-route metrics every five seconds. The benchmark runs equivalent Node HTTP servers with and without instrumentation and reports request throughput, difference, and overhead percentage. Benchmark results vary by operating system, Node version, CPU governor, and concurrent activity.

`npm run bench:application` runs sustained healthy, saturation, slowdown, and recovery periods against a real local Node HTTP dependency. It compares unlimited, fixed-limit, and adaptive strategies, classifies Lazpho rejections/timeouts separately from downstream failures, and prints a per-window adaptive timeline. See the [real-application adaptive benchmark](docs/application-benchmark.md).

`npm run lab:bottleneck` starts the full-path bottleneck lab and dashboard on `http://127.0.0.1:1912`. Every inbound lab route is instrumented, while shared controllers protect the actual database, payment, and report capacity pools. The scenarios cover healthy and legitimately slow work, CPU pressure, dependency saturation, retry recovery, mixed work, bulkhead isolation, breaker trip/recovery, execution timeout, and client disconnect. Use `LAZPHO_DASHBOARD_PORT` to override the port, or `npm run lab:bottleneck:smoke` for the reduced automated check. See the [full-path bottleneck lab](docs/bottleneck-lab.md).

`npm run stress` runs a seeded adversarial controller scenario (default seed `184732`, 5,000 logical submissions). Set `STRESS_SEED` and `STRESS_TASKS` to reproduce or scale a scenario. It includes a retry-storm/recovery phase with bounded two-retry chains and reports logical submissions, total active attempts, retry attempts, retry successes, exhausted chains, cancellations, timeouts, queue/lifecycle rejections, peak active/queue, and invariant violations. Stress checks controller accounting, bounded queue behavior, cancellation and timeout races, shutdown draining, atomic reconfiguration, and adaptive snapshot bounds; it exits non-zero on an invariant violation.

## Resource-safety soak testing

`npm run soak` runs a short deterministic create/work/close cycle repeatedly. It mixes bulkhead and global saturation, failures, retries, retry exhaustion, queued and active cancellation, execution and queue-wait timeouts, lazy breaker trips/recovery, adaptive runtime updates, and shutdown during churn. Every cycle validates internal queue linkage, partition/global accounting, timer and abort-listener counts, retry-chain cleanup, single promise settlement, and at-most-once execution per attempt.

The summary reports lifecycle totals, warnings and unhandled failures, plus initial/peak/final `heapUsed`, `heapTotal`, RSS, and external memory. Memory checks warm up before looking for obviously unbounded monotonic growth; they intentionally do not assert exact Node heap values. `npm run soak:long` runs a larger local diagnostic under `--expose-gc` and adds a post-GC sample. `SOAK_SEED`, `SOAK_CYCLES`, and `SOAK_TASKS_PER_CYCLE` can override either mode. The normal test suite and default soak do not require exposed GC.
