# Public API reference

This is the human-readable map of Lazpho's supported package surface. The declaration snapshots in `api/` remain the machine-enforced contract; generated JSON is not the primary user documentation.

## Entry points

| Entry point | Purpose | Runtime exports |
| --- | --- | --- |
| `lazpho` | Factory, controllers, protected functions, errors | `createFactory`, `createProtectedFunction`, `isLazphoError`, `classifyLazphoError`, public error classes |
| `lazpho/config` | Presets, validation, inspection | `createLazphoPreset`, `listLazphoPresets`, `getLazphoPresetInfo`, `resolveLazphoConfig`, `validateLazphoConfig`, `inspectLazphoConfig` |
| `lazpho/application` | Central controller registry and loopback dashboard | `createLazphoApplication`, `startLazphoDashboard` |
| `lazpho/load-lab` | Safe endpoint checks and bounded local load reports | `startLazphoLoadLab` |
| `lazpho/fetch` | Native fetch protection | `createProtectedFetch` |
| `lazpho/node-http` | Node HTTP metrics and request abort bridge | `instrumentNodeHttp`, `createRequestAbortSignal` |
| `lazpho/observability` | Pull and push metric integration | `createMetricsCollector`, `createMetricsExporter` |
| `lazpho/opentelemetry` | Consumer-owned Meter bridge | `createLazphoOpenTelemetry`, `LAZPHO_OTEL_METRIC_NAMES`, `lifecycleValue`, `breakerValue` |
| `lazpho/express` | Express request context and error handling | `createLazphoExpress`, `getLazphoExpress`, `createLazphoExpressErrorHandler`, `shutdownLazphoExpress`, `mapLazphoErrorToHttp` |
| `lazpho/fastify` | Fastify plugin and request context | `lazphoFastifyPlugin`, `getLazphoFastify`, `createLazphoFastifyErrorHandler`, `mapLazphoErrorToHttp` |
| `lazpho/nestjs` | NestJS module, token, and interceptor | `LazphoModule`, `LAZPHO_CONTROLLER`, `createLazphoNestInterceptor`, `getLazphoNest`, `mapLazphoErrorToHttp` |

Only these declared package paths are public. Files visible under `dist/` are implementation details and cannot be deep-imported through package exports.

## Core contracts

`createFactory(options?)` creates the app-scoped registry and request metric collector. `factory.concurrency(options)` creates a fixed controller. `factory.adaptiveConcurrency(options)` creates an adaptive controller, optionally linked to a fixed controller. Create controllers per application/dependency, not per request.

`controller.run(operation, options?)` accepts either an existing zero-argument callback or a callback receiving `RunContext`:

```ts
await controller.run(() => dependency.read());

await controller.run(({ signal, attempt }) => dependency.read({ signal }), {
  signal: callerSignal,
  timeoutMs: 1_000,
  bulkhead: 'storage',
  retry: { attempts: 2, delayMs: 25 }
});
```

`attempt` is one-based. `RetryOptions.attempts` counts retries after the initial execution, so `attempts: 2` permits at most three executions. Other stable controller methods are `setLimit`, `getLimit`, `stats`, `lifecycle`, and asynchronous `close`.

`createProtectedFunction(controller, operation, defaults?)` preserves argument/result inference while injecting `RunContext`. Its `.run(overrides, ...args)` form supports per-call `RunOptions`. `createProtectedFetch` preserves native fetch behavior; 4xx/5xx responses resolve normally unless application code explicitly throws.

## Public errors

Classes, codes, classifications, inheritance, and listed metadata are stable. Exact English messages and stack text are not.

| Class | Stable code | Classification | When raised | Metadata |
| --- | --- | --- | --- | --- |
| `QueueFullError` | `FACTORY_BACKPRESSURE_REJECTED` | `queue_full` | Aggregate queue is full | `controller`, `maxQueueSize` |
| `BulkheadQueueFullError` | `FACTORY_BULKHEAD_QUEUE_FULL` | `bulkhead_queue_full` | Selected bulkhead queue is full | `controller`, `bulkhead`, `maxQueue` |
| `UnknownBulkheadError` | `FACTORY_UNKNOWN_BULKHEAD` | `unknown_bulkhead` | Selected bulkhead is not configured | `controller`, `bulkhead` |
| `QueueAbortedError` | `FACTORY_QUEUE_ABORTED` | `queue_aborted` | Caller cancels queued work | `controller` |
| `ControllerAbortError` | `FACTORY_CONTROLLER_ABORTED` | `aborted` | Caller cooperatively cancels active work | `controller` |
| `ControllerTimeoutError` | `FACTORY_CONTROLLER_TIMEOUT` | `timeout` | An admitted attempt exceeds `timeoutMs` | `controller`, `timeoutMs` |
| `QueueWaitTimeoutError` | `FACTORY_QUEUE_WAIT_TIMEOUT` | `queue_wait_timeout` | Queued work exceeds `maxQueueWaitMs` | `controller`, `maxQueueWaitMs` |
| `ControllerLifecycleError` | `FACTORY_CONTROLLER_CLOSED` | `lifecycle` | Work/configuration is rejected while draining or closed | `controller`, `operation` |
| `CircuitBreakerOpenError` | `FACTORY_CIRCUIT_BREAKER_OPEN` | `breaker_open` | Breaker rejects before dependency execution | `controller` |
| `DuplicateControllerNameError` | `FACTORY_DUPLICATE_CONTROLLER` | `duplicate_controller` | A factory already contains that name | `controller` |
| `ControllerLimitError` | `FACTORY_CONTROLLER_LIMIT` | `controller_limit` | Factory controller cardinality bound is reached | `maxControllers` |

```ts
try {
  await controller.run(({ signal }) => dependency.call({ signal }));
} catch (error) {
  if (isLazphoError(error)) {
    console.warn(error.code, classifyLazphoError(error));
  }
  throw error;
}
```

The shared framework HTTP mapping uses 503 for saturation, open breaker, and lifecycle unavailability, and 504 for execution/queue-wait timeout. Caller cancellation and ordinary dependency errors remain application-owned.

## Public types

The root exports controller, lifecycle, factory, adaptive, queue-pressure, breaker, bulkhead, retry, metrics, request, protected-function, `RunContext`, and `RunOptions` types. `lazpho/application` exports its registry, scenario, dashboard, state, and result types. `lazpho/load-lab` exports endpoint, managed fixture/request/cleanup context, profile, state, result, controller-impact, and dashboard types. Each adapter subpath exports its own option/context types. Type compatibility is protected even where no JavaScript symbol exists.

## Operational metrics

Stable OpenTelemetry names are grouped below. Additions are reviewed as minor changes; removal or rename is breaking after 1.0.

- Controller: `lazpho.controller.active`, `.queued`, `.limit`, `.lifecycle`.
- Operations: `lazpho.operations.completed`, `.failed`, `.cancelled`, `.timed_out`, `.rejected`, `.queue_rejected`, `.bulkhead_rejected`.
- Retry: `lazpho.retry.attempted`, `.succeeded`, `.exhausted`.
- Breaker: `lazpho.breaker.state`, `.trips`, `.rejections`, `.recoveries`, `.half_open_attempts`.
- Bulkhead: `lazpho.bulkhead.active`, `.queued`, `.max_concurrent`, `.max_queue`, `.rejections`.
- Adaptive: `lazpho.adaptive.latency_ewma`, `.error_rate`, `.target_latency`.

Numeric mappings are `running=0`, `draining=1`, `closed=2` and `closed=0`, `open=1`, `half_open=2` for breaker state.
