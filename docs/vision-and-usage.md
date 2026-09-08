# Lazpho vision, fit, and limitations

## The objective

Lazpho helps a Node.js process remain predictable when demand exceeds the healthy capacity of a database, remote API, worker pool, or other constrained dependency. It admits only bounded concurrent work, keeps waiting work bounded, and turns excess demand into explicit outcomes instead of allowing latency, sockets, and memory to grow without control.

The primary goal is **stability under pressure**, not the highest possible requests-per-second number. A protected application may intentionally reject more requests during overload while completing useful work with better tail latency and recovering sooner. That is successful load shedding, not a throughput regression.

Lazpho is explicit by design:

- applications decide which operations share a capacity boundary;
- applications choose limits, queues, timeouts, bulkheads, retry rules, and breaker thresholds;
- applications propagate the supplied `AbortSignal` to dependencies;
- applications own adaptive evaluation schedules and shutdown;
- applications decide which Load Lab scenarios are safe.

Lazpho does not inspect hardware, crawl routes, infer database capacity, manufacture traffic, or install global process behavior.

## Where Lazpho is useful

Use Lazpho around asynchronous work whose concurrency affects a finite downstream resource:

| Workload | Benefit |
| --- | --- |
| Database queries | Prevent more simultaneous queries than the database or pool can serve healthily |
| External HTTP APIs | Bound sockets and in-flight calls; fail predictably during dependency slowdown |
| Payments, email, search, and AI APIs | Isolate independent failure domains with bulkheads |
| Reports and background work | Stop expensive jobs from consuming all application capacity |
| Variable-capacity dependencies | Adapt within explicit minimum and maximum concurrency bounds |
| Deployments | Stop admission and drain already accepted work deliberately |

Create controllers for real capacity pools, not for every route or function. Several routes that use the same database normally share a database controller. Independent payment and search services normally use different controllers or bulkheads.

## Where Lazpho is not useful

Do not wrap trivial synchronous code, cached property access, or work whose concurrency has no meaningful constrained resource. Lazpho does not make CPU-bound JavaScript parallel; use worker threads or a separate compute service. It is also not a replacement for:

- a database connection pool or query/index optimization;
- caching, autoscaling, capacity planning, or admission control at the edge;
- a distributed rate limiter or per-customer quota system;
- a durable queue, broker, or job scheduler;
- a reverse proxy, service mesh, tracing backend, or APM product;
- application-level authorization, idempotency, or transaction design;
- realistic load generation and production monitoring.

Do not add retries merely because they are available. Retries increase load and are appropriate only for bounded transient failures on operations that are safe to repeat.

## Correct integration

Create one shared factory and one controller per dependency capacity pool during application startup:

```ts
import { createFactory } from 'lazpho';

const factory = createFactory();
const database = factory.concurrency({
  name: 'database',
  limit: 12,
  maxQueueSize: 96,
  maxQueueWaitMs: 500,
  bulkheads: {
    reads: { maxConcurrent: 10, maxQueue: 80 },
    writes: { maxConcurrent: 3, maxQueue: 16 }
  }
});

const users = await database.run(
  ({ signal }) => usersCollection.find({}, { signal }).toArray(),
  { bulkhead: 'reads', timeoutMs: 1_000 }
);
```

Do not construct a controller inside a request handler. A per-request controller has no shared view of pressure and cannot enforce an application-wide bound.

The operation timeout begins after admission. `maxQueueWaitMs` controls time spent waiting. An end-to-end HTTP deadline should arrive as a caller signal through the framework adapter. Pass the execution signal to the actual dependency; otherwise cancellation is only advisory and the slot remains occupied until the promise settles.

During shutdown, stop accepting traffic, close controllers so accepted work drains, close dependencies, and finally close the factory. Framework-specific helpers document the appropriate ordering.

## Choosing initial values

Start with the `balanced` preset or conservative measurements from the real dependency. Keep queues small enough that waiting time remains useful. A queue is not extra capacity.

Measure at least:

- dependency execution P95;
- queue-wait P95;
- useful throughput;
- error, rejection, and timeout rates;
- event-loop lag and memory;
- downstream pool utilization.

Increase a concurrency limit only while useful throughput improves and dependency latency remains healthy. Reduce it when latency or errors climb. Set the queue-wait deadline below the point where the result stops being useful. Set execution timeouts from dependency behavior, not from an arbitrary round number.

For adaptive control, begin in `observe`, review recommendations, move to `recommend`, and enable `auto` only after bounds and signals behave correctly under real workloads. Adaptive control cannot create capacity or compensate for a broken dependency.

## Limitations and guarantees

- Controllers are process-local. Ten replicas with limit 10 can collectively admit about 100 operations.
- Cancellation is cooperative. JavaScript cannot forcibly terminate a promise or a dependency that ignores its signal.
- An active slot is retained until the underlying operation settles, including after caller cancellation or timeout.
- Queue and execution timeouts are separate; neither is automatically a complete request deadline.
- Adaptive decisions depend on representative observations and application-owned evaluation calls.
- Very short operations can be dominated by timer and event-loop measurement noise.
- Percentiles use bounded recent samples, not an unbounded exact event history.
- Circuit breakers react to configured local failure history and do not represent global dependency health.
- Native fetch resolves HTTP error responses; applications must throw when a status should affect retry or breaker health.
- Lazpho provides no cross-host coordination, priority queue, durable storage, or fairness between separate processes.
- Protection can preserve stability but cannot guarantee latency, throughput, availability, or recovery time.

## Proving benefit responsibly

Compare the same application and dependency under the same workload with and without protection. Report requested load separately from achieved load. A load generator that reaches only 40,000 RPS cannot prove behavior at a selected 1,000,000 RPS target.

Evidence that Lazpho helped includes:

- observed active dependency work never exceeded the configured limit;
- queue depth stayed within its configured bound;
- overload produced classified rejections or timeouts rather than uncontrolled waiting;
- a slow failure domain did not consume another bulkhead's capacity;
- breaker-open calls failed before consuming dependency capacity;
- tail latency and useful throughput recovered after pressure ended;
- memory and event-loop health remained bounded relative to an unprotected comparison.

At healthy load, expect small coordination overhead and possibly no visible benefit. Load Lab explicitly labels a run with no saturation as a healthy-path validation rather than proof of overload protection.

See the [production operations guide](operations.md), [Load Lab guide](load-lab.md), and [Signalboard example](../examples/feedback-board/README.md) for runnable integration details. Signalboard includes a repeatable direct-versus-Lazpho comparison with isolated databases, matched workloads, safe cleanup, and a combined report.
