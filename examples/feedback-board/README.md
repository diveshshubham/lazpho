# Signalboard — Lazpho + MongoDB example

A deliberately small full-stack feedback SaaS used to exercise Lazpho in a new Express application. Users can submit feature ideas, vote, filter the roadmap, and move ideas through `planned`, `building`, and `shipped` states.

Every MongoDB operation runs through one shared Lazpho controller. Reads and writes have separate bulkheads, the global queue is bounded, operations time out after 1.5 seconds, disconnected HTTP requests are cancelled, and Lazpho overload errors become safe `503`/`504` responses.

## Run it

Requires Node.js 18+, npm, and either Docker or a local MongoDB server.

```bash
cd examples/feedback-board
docker compose up -d
npm install
$env:LOAD_LAB = "true" # PowerShell; use `export LOAD_LAB=true` in bash
npm start
```

Open <http://localhost:3000> for Signalboard and <http://127.0.0.1:1913> for Lazpho Load Lab. Environment defaults are listed in `.env.example`; export them in your shell if you need different values.

Live Lazpho metrics are available at <http://localhost:3000/api/metrics>. To see backpressure in action, lower `limit` and `maxQueueSize` in `server.js`, add latency to MongoDB, then send concurrent requests.

Load Lab lists and can exercise every application API. The mutating routes use application-owned setup, dynamic request, and cleanup callbacks: create tests remove only titles tagged with their generated run ID, while vote/status tests create one temporary idea and delete that exact `_id` afterward. The dashboard provides Send once, Test latency, and Load test actions. Reports can be downloaded from the UI and are also written to `load-reports/`.

## Compare Lazpho with direct MongoDB access

The same application can run in either mode. Lazpho is enabled by default:

```powershell
$env:USE_LAZPHO = "false" # direct MongoDB calls
npm start
```

Run the guided A/B comparison to exercise all five API endpoints in both modes and generate one combined HTML/JSON report:

```bash
npm run compare
```

The comparison uses temporary, isolated databases and removes them afterward. It reports successful requests, overload responses, P95 latency, throughput, direct-mode peak database concurrency, and Lazpho's configured bounds and protective outcomes. By default it sends 100 requests per endpoint at concurrency 50 with 100 ms of simulated database latency. Override `COMPARE_REQUESTS`, `COMPARE_CONCURRENCY`, or `COMPARE_DB_LATENCY_MS` to change the workload. Reports are written to `load-reports/comparison-*.html` and `.json`. The simulated latency is disabled during normal application use.

## Run the repeated stress-test matrix

The matrix runner tests all five application APIs sequentially in direct and Lazpho modes at 10k, 50k, 100k, and 1m requested RPS. Each scenario runs three times by default and the consolidated report uses medians:

```bash
npm run test:matrix
```

Safety defaults are 256 requests in flight and 10,000 scheduled requests per endpoint. A 1m selection will therefore normally be marked safety-capped and/or generator-limited; it is not presented as achieved throughput. The HTML and JSON reports include scheduled work, completed RPS, latency, status outcomes, application RSS/heap/CPU counters, direct database peak concurrency, and Lazpho controller evidence.

Tune a local run with environment variables such as `MATRIX_RPS`, `MATRIX_REPETITIONS`, `MATRIX_DURATION_MS`, `MATRIX_MAX_IN_FLIGHT`, `MATRIX_MAX_REQUESTS`, and `MATRIX_DB_LATENCY_MS`. For example, this PowerShell command runs a quick smoke matrix:

```powershell
$env:MATRIX_RPS = "100,500"
$env:MATRIX_REPETITIONS = "1"
$env:MATRIX_DURATION_MS = "250"
npm run test:matrix
```

Reports are written to `load-reports/matrix-*.html` and `.json`, with detailed A/B reports alongside them. Use coordinated distributed generators for a credible uncapped million-RPS test.

## Validate every Load Lab action

Start Signalboard with `LOAD_LAB=true`, then run this in a second terminal:

```bash
npm run test:load-lab
```

The black-box validator discovers the five registered APIs from `/api/state` and exercises each with **Send once**, **Test latency**, and **Load test** semantics. It checks the loopback dashboard and content-security policy, rejects an unauthenticated mutation, downloads every JSON/HTML report, confirms observed controller work stayed within configured limits, and checks that no run-owned MongoDB fixture remains. Defaults use five measured latency requests and a one-second 1,000 requested-RPS load per endpoint; use `LOAD_LAB_VALIDATION_RPS`, `LOAD_LAB_VALIDATION_DURATION_SECONDS`, and `LOAD_LAB_VALIDATION_LATENCY_REQUESTS` to tune the validation.

The validator reads the per-instance token from the loopback-only dashboard page without printing it. It is a local test helper, not a remote dashboard client.

## Test MongoDB faults and recovery

The transport-fault runner places a bounded repository-owned TCP proxy between Signalboard and the configured MongoDB instance, then compares direct and Lazpho modes through healthy, latency-spike, transport-outage, recovery, and mixed-fault soak phases:

```bash
npm run test:faults
```

It uses isolated temporary databases and removes them afterward. JSON and HTML reports are written to `load-reports/fault-*.json` and `.html`. Tune bounded runs with `FAULT_CONCURRENCY`, `FAULT_BATCH_REQUESTS`, `FAULT_LATENCY_MS`, and `FAULT_SOAK_SECONDS`.

Connection cuts simulate transport loss and failover-style reconnect pressure. They do not simulate a replica-set election, replication lag, rollback, write concern, or data-consistency behavior. Use a disposable production-like replica set for those tests.

## Test MongoDB replica-set elections

The replica-set runner starts a disposable three-member MongoDB 8 topology, steps down the current primary while mixed reads and writes are active, waits for a different primary, and verifies recovery and majority durability:

```bash
docker compose -f docker-compose.replica-set.yml up --exit-code-from test test
docker compose -f docker-compose.replica-set.yml down --volumes
```

Docker Desktop (or Docker Engine with Compose v2) is the only external prerequisite. The test runs Node and MongoDB inside an isolated `lazpho-replica-set` Compose project, installs dependencies into anonymous volumes, uses temporary MongoDB storage, and writes JSON/HTML reports to `load-reports/replica-*.json` and `.html`. The cleanup command removes only that disposable project's containers, network, and anonymous volumes.

Defaults use 24 workers, a 12-second election workload, and at most 3,000 HTTP requests per mode. Override `REPLICA_CONCURRENCY`, `REPLICA_DURATION_SECONDS`, or `REPLICA_MAX_REQUESTS` for a bounded smoke or longer diagnostic. The runner requires a confirmed primary change, healthy post-election reads and writes, all acknowledged writes to remain present exactly once, pre/post sentinels to become majority-readable on all three members, zero Lazpho limit violations, and a fully drained controller.

This is evidence for one local three-member topology. It is not proof against network partitions, replication lag, rollbacks, regional loss, storage failure, or every write/read concern combination.

## API

- `GET /api/ideas`
- `POST /api/ideas` with `{ "title": "...", "description": "..." }`
- `POST /api/ideas/:id/vote`
- `PATCH /api/ideas/:id/status` with `{ "status": "planned|building|shipped" }`
- `GET /api/metrics`
