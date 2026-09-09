# Adopting Lazpho in an existing application

Adopt Lazpho around a dependency capacity boundary, not around the entire codebase at once. A good first target is a database, payment API, AI service, report worker, or other asynchronous dependency that becomes slow or unstable when too many operations run concurrently.

## 1. Establish a baseline

Before changing code, record representative healthy and overloaded behavior:

- useful request and operation throughput;
- dependency execution P50/P95/P99;
- connection-pool or downstream concurrency;
- request errors and timeouts;
- process memory and event-loop lag;
- recovery after the load stops.

Without a baseline, explicit load shedding can look like a regression because Lazpho may reject work that the old application allowed to wait indefinitely.

## 2. Identify capacity pools

Group operations by the constrained resource they consume. Routes are not capacity pools by themselves.

```text
GET /users ───────┐
POST /users ──────┼── shared database controller
GET /reports ─────┘

POST /checkout ───── payment controller
POST /email ───────── email controller
```

Use separate controllers for independent dependencies. Use static bulkheads when related classes of work share a global dependency but need local isolation, such as database reads and writes.

## 3. Create shared controllers at startup

Before:

```js
export async function findUser(id, signal) {
  return users.findOne({ id }, { signal });
}
```

After:

```js
import { createFactory } from 'lazpho';

export const lazphoFactory = createFactory();
export const database = lazphoFactory.concurrency({
  name: 'database',
  limit: 8,
  maxQueueSize: 40,
  maxQueueWaitMs: 500
});

export async function findUser(id, requestSignal) {
  return database.run(
    ({ signal }) => users.findOne({ id }, { signal }),
    { signal: requestSignal, timeoutMs: 1_500 }
  );
}
```

Never create a controller inside a request handler. Per-request controllers cannot see shared pressure or enforce a process-wide bound.

## 4. Propagate cancellation correctly

Pass the `signal` supplied to the Lazpho callback into the database or HTTP client. Also pass the incoming request signal to `run()` when the framework adapter or application provides one.

Cancellation is cooperative. Lazpho retains the active slot until the underlying operation settles, even after a timeout or caller disconnect. This protects accounting but means a dependency that ignores abort signals must still have its own finite timeout.

## 5. Add HTTP mapping and observability

Map known protective errors to stable `503`/`504` responses at one HTTP boundary. Do not return raw error messages or controller configuration.

Export at least:

- `active`, `queued`, and `limit`;
- queue and execution latency;
- queue-full and queue-timeout totals;
- execution timeout, breaker, retry, and bulkhead outcomes;
- controller lifecycle state.

Keep metric labels bounded. Never use request IDs, user IDs, arbitrary URLs, or error messages as dimensions.

## 6. Roll out conservatively

1. Protect one dependency and deploy with a fixed limit.
2. Confirm healthy traffic is unaffected beyond acceptable coordination overhead.
3. Exercise bounded overload and dependency slowdown outside production.
4. Verify active work and queue depth never exceed configured bounds.
5. Tune one value at a time from measured dependency behavior.
6. Add retries or a breaker only when their failure semantics are understood.
7. If adaptive control is needed, begin in `observe`, then `recommend`, and enable `auto` only with reviewed minimum and maximum limits.

## Starting-value guidance

- Begin near the dependency pool's known healthy parallelism, not the application's maximum request rate.
- Keep the Lazpho limit at or below the capacity you intend this process to consume.
- Remember that process-local limits multiply across application replicas.
- Keep queues small enough that queued work remains useful before its deadline.
- Set queue-wait and execution deadlines separately.
- Do not assume presets discover optimal capacity; they are deterministic starting configurations.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| One controller per request | No shared protection and unbounded controller cardinality |
| One controller for unrelated dependencies | One failure domain consumes another's capacity |
| Wrapping CPU-bound JavaScript | No parallelism benefit; event-loop work remains blocked |
| Large queue used as capacity | Higher tail latency and memory rather than more throughput |
| Retrying every error | Retry amplification during overload or outages |
| Ignoring the callback signal | Timed-out work continues consuming dependency capacity |
| Treating every rejection as a bug | Hides intentional overload protection |
| Enabling adaptive `auto` immediately | Limit changes before signals and bounds are validated |

## Removing Lazpho safely

Because protection is explicit at operation boundaries, rollback is straightforward: route calls back to the original dependency function while preserving application-level cancellation and timeout behavior. Do not remove the controller until accepted work has drained. Compare the same workload before and after rollback rather than assuming additional admitted concurrency is healthier.

See the [Express, Fastify, and NestJS integrations](../README.md#framework-integrations), [production operations](operations.md), and the [testing guide](testing.md) for the next steps.
