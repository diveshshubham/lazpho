# Full-path bottleneck lab

The repository bottleneck lab observes every inbound lab route while protecting capacity-constrained dependency operations. It complements the outbound application benchmark: route telemetry explains what the caller experienced, while controller telemetry explains where admission, queueing, execution, retries, bulkheads, and breakers changed that experience.

Run the interactive dashboard:

```bash
npm run lab:bottleneck
```

Open `http://127.0.0.1:1912`. Set `LAZPHO_DASHBOARD_PORT` to a different valid port when 1912 is unavailable. The server binds only to loopback and installs no package-level process handlers; the example application owns its shutdown handlers.

Run the automated functional check:

```bash
npm run lab:bottleneck:smoke
```

The smoke mode uses reduced loads, drives every lab route, asserts evidence for bounded rejection, retries, bulkhead isolation, execution timeout, request cancellation, breaker recovery, and final `active/queued = 0/0`, then closes both local servers. Assertions are behavioral rather than machine-specific latency thresholds.

## Coverage

The dashboard can run one scenario or the complete sequence:

| Route | Factor under observation | Protection boundary |
| --- | --- | --- |
| `/lab/fast` | healthy application work | inbound metrics only |
| `/lab/slow` | legitimate long-running work | `long-reports` controller |
| `/lab/cpu` | synchronous event-loop pressure | inbound resource and latency metrics |
| `/lab/database` | healthy downstream I/O | `database` controller |
| `/lab/saturated` | overload, queue rejection, and queue-wait timeout | bounded `database` queue |
| `/lab/retry` | one transient dependency failure and successful retry | bounded retry through `database` |
| `/lab/mixed` | two capacity pools used by one request | `database` plus payment-write bulkhead |
| `/lab/bulkhead` | noisy-neighbor isolation | payment `writes` partition |
| `/lab/payments` | downstream failures and breaker opening | payment `reads` partition and breaker |
| `/lab/recovery` | half-open probe and breaker recovery | payment breaker |
| `/lab/timeout` | protected-operation execution timeout | `database` controller |
| `/lab/cancel` | client disconnect propagation | Node request-abort bridge and `database` controller |

All dependencies are local and deterministic. No external API, database, or telemetry backend is required. The live state API is `GET /api/state`; `GET /api/scenarios` lists scenarios, `POST /api/run?scenario=<name|all>` starts work, and `POST /api/reset` clears dashboard views when idle.

## Why Lazpho is not configured independently for every URL

Every inbound route should be instrumented using its stable route template. This reveals endpoint traffic, latency, failures, and event-loop symptoms without creating controller state for every path parameter.

Concurrency control belongs around work that consumes a scarce capacity pool: a database, payment provider, report worker, tenant partition, or operation class. A controller per URL would fragment shared capacity, multiply queues and breakers, create high-cardinality state for dynamic paths, and allow the combined limits to overload the same dependency. A controller per request would discard history entirely and make adaptive decisions and circuit breakers ineffective.

The useful mapping is therefore many routes to a smaller number of shared controllers, with bulkheads where operation classes need isolation. Per-call options may select an existing bulkhead or adjust an operation timeout; they should not manufacture a new controller. Legitimately slow work receives its own explicit policy rather than being mistaken for an unhealthy fast dependency.

## Reading a diagnosis

The dashboard reports bounded route templates, controller activity and queues, route percentiles, event-loop lag, dependency concurrency peaks, outcome categories, adaptive limits, and a short in-memory timeline. Its diagnosis column is a heuristic, not a tracing system:

- high event-loop lag on the CPU route points to synchronous application work;
- queue wait dominating execution points to local admission pressure;
- high execution time points to downstream or protected-operation work;
- expected report latency remains labeled as intentional slow work;
- explicit outcome counters distinguish saturation, bulkhead rejection, queue and execution timeout, breaker-open rejection, downstream failure, and cancellation.

Because route latency alone cannot identify time spent in arbitrary internal code, production-grade bottleneck attribution should correlate these metrics with tracing, database/client instrumentation, and application-specific spans. This lab remains a deterministic repository proof. The reusable, opt-in registry and loopback dashboard are documented in [application integration](application-integration.md); neither performs automatic code profiling or arbitrary route execution.
