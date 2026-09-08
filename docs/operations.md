# Production and operations guide

## Mental model

```text
Application
    |
    v
Lazpho controller
    |- global concurrency and bounded queue
    |- optional partition bulkheads
    |- optional retry and circuit breaker
    |- cancellation and per-attempt timeout
    `- bounded metrics / adaptive decisions
    |
    v
Dependency
```

Lazpho is an in-process dependency protection library. It is not a rate limiter, reverse proxy, durable queue, distributed scheduler, service mesh, or request-handler retry middleware. It provides no cross-process coordination or infrastructure SLA.

## Starting safely

Start with the `balanced` preset, then benchmark the real dependency. Observe dependency P95 latency, queue-wait P95, rejections, timeouts, error rate, and useful throughput before adjusting one bound at a time. Presets are deterministic starting points, not automatic optimal tuning.

- `concurrency.limit` is the initial admitted parallelism.
- `adaptive.minLimit` and `maxLimit` are hard adaptive bounds.
- `maxQueueSize` bounds aggregate waiting work; smaller queues shed earlier.
- `maxQueueWaitMs` is a distinct waiting deadline.
- `targetP95Ms` should reflect dependency latency, not an end-to-end HTTP SLA.
- `maxErrorRate` and queue-pressure thresholds determine protective evidence.
- `initialLimit` is represented by `concurrency.limit` in resolved presets.

Adaptive control observes latency, throughput, errors, and queue pressure. Healthy demand may cause cautious additive probes; slowdown/failure causes holds or backoff; recovery permits probing to resume. It cannot discover capacity without demand and does not guarantee an exact limit, latency, throughput, or recovery time.

Adaptive evaluation is application-driven. Creating `factory.adaptiveConcurrency(...)` allocates no timer: call `evaluateFromMetrics()` about once per configured `evaluationIntervalMs`. Link the fixed controller through `controller` and select `mode: 'auto'` to apply decisions; the default raw mode is `recommend` and is read-only. Presets select `auto` but still require the application-owned evaluation call.

## Queue, bulkhead, and admission semantics

The aggregate queue is bounded. FIFO order is preserved inside each partition, while the scheduler rotates across runnable partitions so one locally blocked bulkhead does not block another. Global concurrency and queue capacity remain authoritative: bulkheads partition those budgets and never add capacity.

Use bulkheads for meaningful independent dependencies such as payments, search, email, storage, or an external AI API. Do not create a partition for every route. Bulkheads are configured statically; dynamic creation is unsupported.

## Retries and breaker

Retries increase dependency load. Use them only for bounded transient failures and operations safe to repeat. `attempts: 2` means two retries after the initial execution. Retry delay releases the active slot, and every retry re-enters ordinary breaker, concurrency, bulkhead, and queue admission. A full queue can therefore stop a retry. Cancellation, timeout, saturation, and lifecycle failures do not retry by default.

The breaker moves `closed -> open -> half_open -> closed`. Ordinary operation failures and execution timeouts qualify; caller cancellation and admission failures do not. An open breaker fails fast without consuming an active/queue slot. Cooldown is lazy: after `resetTimeoutMs`, a later admission initiates bounded half-open probes. The breaker protects repeated dependency failure; adaptive concurrency protects capacity/latency. They solve different problems and may be used independently.

## Cancellation, timeouts, and shutdown

Queued cancellation removes work immediately. Active cancellation is cooperative: Lazpho aborts the operation signal, but the controller and bulkhead slots remain occupied until the underlying promise settles. If active count does not fall after abort, ensure the dependency observes the supplied signal and eventually settles.

Execution `timeoutMs` begins only after admission and applies independently to each admitted retry attempt. Queue waiting is controlled separately by `maxQueueWaitMs`; neither is an end-to-end request deadline.

Lifecycle is forward-only: `running -> draining -> closed`. Once draining begins, new submissions reject, accepted queued/active/retry work continues, and `close()` resolves after it settles. Shutdown that never completes usually indicates an underlying operation ignored cancellation and never settled.

Only `minLimit`, `maxLimit`, and `targetP95Ms` are mutable through adaptive `updateConfig()`. Retry, breaker, bulkhead, and queue definitions are not runtime mutable.

## Observability and cardinality

`createMetricsCollector()` returns detached bounded snapshots. `createMetricsExporter()` pushes snapshots only when the application calls `export()` and isolates exporter failures. `createLazphoOpenTelemetry()` registers instruments on a consumer-owned structural `Meter`; Lazpho installs no global provider and owns no SDK lifecycle.

Keep attributes bounded. Controller name, configured bulkhead, and framework are appropriate. Never attach raw/full URLs, request IDs, user/tenant IDs, arbitrary error messages, stack traces, or task IDs. High-cardinality data can make metric systems expensive and unusable; Lazpho intentionally offers no per-request OTel attribute callback.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `QueueFullError` | Queue size, dependency capacity, caller load shedding, and whether useful throughput has plateaued |
| Breaker stays open | A new call is needed after lazy cooldown; verify half-open probes succeed and failure thresholds fit the dependency |
| Open call did not reach dependency | Expected: open/extra half-open admissions fail before callback execution |
| Timeout fires later than request deadline | Execution timeout starts after admission; use caller cancellation for an end-to-end deadline |
| Active count remains after abort | Expected until the underlying promise settles |
| Retry receives queue-full | Expected because each retry re-enters normal admission |
| Shutdown does not finish | Find an accepted operation/retry that never settles or ignores its abort signal |
| Framework peer import fails | Install the optional peer versions documented in `compatibility.md` |
| ESM import error | Use Node ESM/NodeNext `import`; CommonJS `require()` is unsupported |
| Unexpected framework load/cardinality | Share app/dependency-scoped controllers; never create one per request or label metrics with request data |

The runnable, type-checked production composition is in [the production-readiness example](../src/example/production-readiness.ts) in the source repository. Benchmark results are environment-dependent; microsecond-scale adaptive evaluation and healthy saturation recovery are regression signals, not performance guarantees.

## Known limitations

- Single-process state with no coordination across workers, hosts, or replicas.
- No rate limiting, priorities, weighted bulkhead scheduling, durable queue, hedging, fallback, or dynamic bulkheads.
- Cooperative cancellation cannot forcibly stop an underlying promise.
- Native fetch status codes do not automatically count as failures.
- ESM and Node only; no CommonJS, browser, Bun, or Deno support promise.
- Framework packages remain optional peers and must be installed by adapter consumers.
