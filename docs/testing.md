# Testing a Lazpho integration

Testing should prove bounded behavior and recovery, not merely that protected functions return values. Use three layers: ordinary application tests, controlled resilience tests, and representative load comparisons.

## Application tests

At minimum, verify:

- successful dependency work preserves its return value;
- the configured concurrent active count is never exceeded;
- queue-full, queue-wait timeout, execution timeout, and breaker outcomes map as intended;
- incoming cancellation reaches the dependency signal;
- retries execute only for safe qualifying failures and remain bounded;
- independent bulkheads make progress under pressure;
- shutdown rejects new work and drains accepted work;
- final `active` and `queued` metrics return to zero.

Prefer deterministic promises and explicit barriers over millisecond assumptions. Performance timings vary across CI workers and should not replace behavioral assertions.

## Test through the real application boundary

Exercise the HTTP/API path, dependency client, error middleware, cancellation wiring, metrics, and shutdown together. A controller unit test cannot detect a missing database `signal`, incorrect Express error mapping, or a controller created per request.

For mutation tests, create run-owned fixtures and remove those exact records. Never let a generic load tool invent payment, email, delete, or administrative requests.

## Use Load Lab for local endpoint checks

The optional [Load Lab](load-lab.md) gives every explicitly registered safe endpoint three actions:

- **Send once** for status and request configuration;
- **Test latency** for sequential P50/P95/P99 measurements;
- **Load test** for bounded admission, queue, error, and achieved-rate evidence.

Load Lab binds to loopback by default. `npx lazpho load-lab` can conservatively discover an OpenAPI document, automatically enabling only parameter-free GET/HEAD operations. Use `--header-env name:ENVIRONMENT_VARIABLE` for short-lived test credentials without placing their values in command arguments. The programmatic API remains required when the application must own authentication refresh, dynamic request construction, mutation fixtures, or cleanup.

## Compare protected and unprotected modes

Use the same application, database, payload, request count, concurrency, and machine. Report both modes with:

- attempted, completed, and successful operations;
- status/error distribution, including protective `503`/`504` outcomes;
- achieved rather than merely requested RPS;
- end-to-end and dependency latency percentiles;
- peak dependency concurrency and configured Lazpho limits;
- queue depth, timeouts, breaker events, memory, CPU, and recovery;
- generator and safety caps.

The [Signalboard comparison](signalboard-comparison.md) demonstrates this method and includes reproducible scripts.

## Repository verification commands

When contributing to Lazpho itself, run from the repository root:

```bash
npm test
npm run api:check
npm run stress
npm run soak
npm run package:verify
npm run validation:report
```

Additional diagnostics:

```bash
npm run soak:long
npm run bench:adaptive
npm run bench:saturation
npm run bench:application
npm run lab:bottleneck:smoke
```

`npm test` runs behavioral and documentation/workflow tests. `api:check` detects public runtime/type drift. `package:verify` packs the exact npm artifact and installs it into clean core, framework, and TypeScript consumers. Stress and soak runs assert accounting, cleanup, cancellation, retry, breaker, and lifecycle invariants. `validation:report` combines the latest local Sagavoya authenticated soak and Signalboard MongoDB fault report; it reports `NOT_READY` and exits unsuccessfully rather than hiding a failed acceptance check.

## Signalboard test commands

Start MongoDB, then from `examples/feedback-board`:

```bash
npm install
npm run check
npm run compare
npm run test:load-lab
npm run test:faults
```

The repeated requested-rate matrix is intentionally safety-capped:

```bash
npm run test:matrix
```

The real three-member election test requires Docker Compose:

```bash
docker compose -f docker-compose.replica-set.yml up --exit-code-from test test
docker compose -f docker-compose.replica-set.yml down --volumes
```

Reports are written under the ignored `examples/feedback-board/load-reports/` directory. CI retains Signalboard reports as workflow artifacts for 14 days.

The [Sagavoya validation record](sagavoya-validation.md) shows how to report an existing application's authenticated screening and sustained soak honestly, including a run that recovered correctly but did not pass its stable-release latency and success targets.

## Interpreting requested RPS honestly

Selecting 10,000, 50,000, or 1,000,000 RPS does not prove that rate was generated or served. Always distinguish requested requests, attempts actually started, completions, achieved RPS, generator-limited requests, and application failures. Credible very-high-rate testing requires coordinated external generators, sufficient network capacity, and published hardware/topology details.

## What tests cannot prove

A passing local suite does not guarantee production latency, throughput, availability, correct business idempotency, or multi-region behavior. Repeat representative workloads in an environment that matches the production connection pool, replica count, dependency capacity, network, payload, authentication, and failure modes.
