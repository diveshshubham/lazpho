# Lazpho Load Lab

Load Lab is an opt-in, loopback-only dashboard for controlled endpoint checks. It exists to show how a Lazpho-protected application behaves; it is not a replacement for Swagger, k6, Grafana, a distributed load platform, or production observability.

## Start the dashboard

```ts
import { startLazphoLoadLab } from 'lazpho/load-lab';

const lab = await startLazphoLoadLab({
  targetBaseUrl: 'http://127.0.0.1:3000',
  port: 1913,
  metrics: () => factory.getMetrics(),
  reportDirectory: './load-reports',
  endpoints: [
    {
      id: 'list-users',
      method: 'GET',
      path: '/api/users',
      description: 'Read-only user listing',
      safe: true
    },
    {
      id: 'delete-user',
      method: 'DELETE',
      path: '/api/users/:id',
      description: 'Deletes one temporary managed fixture',
      safe: true,
      setup: async () => String((await users.insertOne({ temporary: true })).insertedId),
      request: ({ fixture }) => ({ path: `/api/users/${fixture}` }),
      cleanup: async ({ fixture }) => { await users.deleteOne({ _id: new ObjectId(String(fixture)) }); }
    }
  ]
});

console.log(lab.url); // http://127.0.0.1:1913
```

Close Load Lab before closing the application controllers:

```ts
await lab.close();
await controller.close();
factory.close();
```

The UI gives every registered endpoint three actions: **Send once**, **Test latency**, and **Load test**. Unsafe endpoints remain visible but disabled so the catalog documents why they cannot run automatically.

For a mutating endpoint, `setup` runs once before measurements, `request` builds each request from the fixture and sequence number, and `cleanup` runs after Lazpho metrics are captured. Hooks execute server-side with bounded timeouts. Cleanup receives a fresh timeout signal even when the test itself was cancelled, allowing application-owned cleanup to finish. Callback functions, credentials, request bodies, and fixture values are never returned by `GET /api/state`.

## Safety boundary

Load Lab never crawls framework routes or imports an OpenAPI document automatically. The application must explicitly register every endpoint and set `safe`. This prevents a dashboard from guessing credentials, fixtures, idempotency, or cleanup behavior for payment, email, delete, and administrative routes.

Additional controls are intentional:

- the dashboard binds only to `127.0.0.1`, `::1`, or `localhost`;
- target URLs must also be loopback unless `allowRemoteTarget: true` is explicit;
- every state-changing dashboard request requires a per-instance token;
- Host and Origin validation reduce DNS-rebinding and cross-site localhost requests;
- endpoint headers and bodies remain server-side and are excluded from dashboard state;
- request bodies, response samples, endpoint count, history, duration, RPS, and concurrency are bounded;
- only one run executes at a time;
- cancellation aborts active HTTP requests cooperatively.

Treat `allowRemoteTarget: true` as operational authority to generate traffic against another system. Never enable it for a production service without explicit approval and capacity coordination.

## Test modes

### Send once

Sends one configured request and captures a bounded response sample. Use it to verify status, connectivity, headers, and payload configuration. It is not a latency benchmark.

### Test latency

Performs five unmeasured warm-up requests, followed by 50 measured sequential requests by default. The report includes average, minimum, maximum, P50, P95, and P99 latency. Sequential latency testing avoids manufacturing queue pressure and answers a different question from load testing.

### Load test

Schedules requests at a selected target rate for a bounded duration. Built-in UI targets are 10k, 50k, 100k, and 1m RPS. The local runner caps simultaneous requests (`maxInFlight`, default 256) so selecting an extreme target cannot create an unbounded promise or socket storm.

The result distinguishes:

- `requestedRps`: chosen target;
- `requestedRequests`: target multiplied by duration;
- `attemptedRequests`: requests the local generator actually started;
- `completedRequests`: requests that settled;
- `generatorLimitedRequests`: target requests the local generator could not start safely;
- `achievedRps`: completed requests divided by actual run duration.

A large `generatorLimitedRequests` value means the generator, its connection pool, CPU, network, or `maxInFlight` bound prevented the selected rate. It does not measure application capacity. Credible hundreds-of-thousands or million-RPS testing normally requires multiple load-generator machines and a dedicated network. Load Lab deliberately makes no distributed-generation claim.

## Understanding the report

HTTP results show status distribution, success/failure totals, achieved throughput, and latency. When `metrics` supplies the application's `factory.getMetrics()` snapshot, controller evidence also shows:

- configured concurrency and queue limits;
- observed peak active and queued operations;
- completed and failed operation deltas;
- rejection and timeout deltas;
- whether observed active work stayed within the configured limit.

The interpretation section uses conservative statements. If the test never creates a queue, rejection, or timeout, the report says it validated only the healthy path. If the load generator falls behind, the report says that the requested rate was not achieved. These qualifications are part of the result, not warnings to hide.

Reports are always downloadable as standalone HTML and JSON from the dashboard. If `reportDirectory` is configured, the same two files are written there using a bounded generated run identifier.

## API surface

- `GET /` — dashboard UI;
- `GET /api/state` — endpoint catalog, live progress, history, and optional Lazpho metrics;
- `POST /api/run` — begin an explicitly safe endpoint run;
- `POST /api/cancel` — cancel the active run;
- `POST /api/reset` — clear in-memory history while idle;
- `GET /api/reports/:id.html` — standalone human report;
- `GET /api/reports/:id.json` — machine-readable report.

Example run request:

```json
{
  "endpointId": "list-users",
  "profile": {
    "mode": "load",
    "requestsPerSecond": 10000,
    "durationSeconds": 10
  }
}
```

Every POST requires the `x-lazpho-dashboard-token` header. Browser users do not need to copy it: the generated token is embedded only in the loopback page served by that Load Lab instance.

## Known MVP limits

- one local Node.js generator process;
- one endpoint per run;
- fixed-rate, sequential-latency, and single-request modes only;
- static defaults with optional application-owned fixture, dynamic request, and cleanup callbacks;
- no automatic authentication refresh or inferred fixture behavior;
- path parameters must be resolved explicitly by the registered `request` callback;
- no OpenAPI import, distributed workers, ramp profiles, or A/B orchestration;
- observed controller peaks are sampled and can miss operations shorter than the sampling interval;
- HTTP latency includes local client, networking, framework, queue, dependency, and response-body time.

The [Signalboard example](../examples/feedback-board/README.md) is the MVP reference application. Its read routes execute directly, while its create, vote, and status routes demonstrate temporary application-owned fixtures and exact cleanup. `npm run compare` runs all five APIs in direct and Lazpho modes against isolated databases, removes both databases, and writes one combined HTML/JSON report. `npm run test:matrix` repeats paced 10k, 50k, 100k, and 1m requested-RPS scenarios, producing a consolidated median report with explicit generator and safety-limit evidence.

With Signalboard and Load Lab running, `npm run test:load-lab` performs a black-box validation of all five registered endpoints in once, latency, and bounded-load modes. It also verifies dashboard authorization, downloadable reports, configured controller limits, and managed-fixture cleanup. See the [Stage 3 validation record](stage3-validation.md) for the latest reproducible evidence and its interpretation limits.
