# Phase 8 application integration

Phase 8 is complete with a reusable, opt-in application layer at `lazpho/application`. It turns the Phase 8B proof into a small integration that a real application can own without copying the repository lab.

## Central application registry

Create one registry per Node.js process. Controllers represent capacity pools, not individual URLs. Stable route templates can map to every pool they consume so the dashboard can correlate route latency with controller queue and execution signals.

```ts
import { createLazphoApplication, startLazphoDashboard } from 'lazpho/application';

const lazpho = createLazphoApplication({
  controllers: {
    database: { limit: 8, maxQueueSize: 64, maxQueueWaitMs: 500 },
    payments: {
      limit: 4,
      maxQueueSize: 24,
      bulkheads: {
        reads: { maxConcurrent: 3, maxQueue: 16 },
        writes: { maxConcurrent: 1, maxQueue: 8 }
      }
    }
  },
  adaptiveControllers: {
    databasePolicy: {
      controller: 'database',
      minLimit: 2,
      maxLimit: 16,
      targetP95Ms: 100,
      maxErrorRate: 0.05,
      mode: 'auto'
    }
  },
  routeControllers: {
    '/users/:id': ['database'],
    '/checkout': ['database', 'payments']
  }
});
```

The registry creates fixed controllers first and validates every adaptive and route mapping. `lazpho.run('database', operation, options)` resolves a named controller without spreading controller construction throughout feature files. `lazpho.startRequest('/users/:id', 'GET')` records an explicitly supplied stable route template. Call `lazpho.evaluateAdaptive()` from an application-owned schedule; the integration creates no hidden evaluation timer.

During shutdown, close the optional dashboard first and then `await lazpho.close()`. The registry closes every controller. It closes its internally created factory, but leaves an externally supplied factory open unless `closeFactoryOnShutdown: true` was explicit.

## Framework-wide inbound metrics

Express, Fastify, and NestJS adapter options now accept an optional `factory`. When present, the adapter records every request once at framework completion, in addition to propagating request cancellation to protected work.

- Express resolves `routeForRequest` at response completion, when `request.route` is available. Supply a stable template resolver for routers and mounted paths; unmatched requests use `__unmatched__`.
- Fastify uses `request.routeOptions.url` by default and permits an override.
- NestJS requires a `routeForRequest` callback for useful templates; otherwise it uses `__unmatched__`.

```ts
app.use(createLazphoExpress({
  controller: lazpho.controller('database'),
  factory: lazpho.factory,
  routeForRequest: (request) =>
    typeof request.route?.path === 'string' ? request.route.path : '__unmatched__'
}));
```

Instrumentation does not automatically place the whole route inside a concurrency controller. Route code still wraps only the capacity-consuming database, remote API, report, or worker operation.

## Safe application dashboard

The dashboard is disabled until an application explicitly starts it. It binds to `127.0.0.1:1912` by default and rejects non-loopback hosts. Port `0` is supported for automated tests. Every state-changing request requires a per-instance token; a random token is generated and embedded in the served page unless the application explicitly supplies `apiToken` for a non-browser client.

```ts
const dashboard = await startLazphoDashboard({
  application: lazpho,
  scenarios: [{
    name: 'read-users',
    description: 'Read-only authenticated user lookup',
    timeoutMs: 10_000,
    run: async ({ application, signal }) => {
      await runKnownSafeUserRequests({ application, signal });
      return { outcomes: { success: 100, failed: 0 } };
    }
  }]
});

console.log(dashboard.url);
```

Only application-registered callbacks can run. The dashboard has no arbitrary URL proxy, route crawler, header editor, or automatic mutation requests. Host, Origin, and mutation-token checks reduce localhost cross-site request and DNS-rebinding exposure. This is intentional: authentication, request bodies, fixtures, idempotency, and destructive behavior cannot be inferred safely from a route table.

The loopback HTTP interface provides:

- `GET /` for the dashboard;
- `GET /api/state` and `GET /api/scenarios`;
- `POST /api/run?scenario=<name|all>`;
- `POST /api/cancel`;
- `POST /api/reset` while idle.

Only one run can be active. Scenario names, descriptions, timeouts, result keys, counters, scenario count, history, and route/controller mappings are bounded. Callback errors are not returned to the browser. The optional error hook lets the owning application send private details to its existing logger.

The diagnosis field is deliberately conservative: `event_loop_pressure`, `admission_queue`, `protected_execution`, `request_failures`, `unmapped_route`, or `no_dominant_bottleneck`. It is a metric correlation hint, not an automatic profiler. Production attribution should still correlate Lazpho with traces, database/client instrumentation, and application-specific spans.

## What every application must provide

Lazpho can centralize the mechanics, but each application must still decide:

1. which dependencies are independent capacity pools;
2. safe starting limits and bounded queues;
3. stable route templates;
4. which read/write scenarios may be executed and with which fixtures or credentials;
5. whether and where the loopback dashboard is started;
6. the adaptive evaluation and shutdown schedule.

This explicit configuration is the safety boundary that makes the integration reusable without pretending all applications or APIs behave the same way.
