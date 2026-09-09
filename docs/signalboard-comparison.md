# Signalboard example and Lazpho comparison

Signalboard is a small full-stack Express and MongoDB feedback SaaS in `examples/feedback-board`. Users create ideas, vote, filter the roadmap, and change idea status. It exists to show where Lazpho belongs in a real application and what changes when dependency pressure appears.

## Architecture

All MongoDB reads and writes share one process-level controller:

```text
HTTP routes
    |
    v
shared MongoDB controller (limit 8, queue 40)
    |- reads bulkhead  (6 active, queue 30)
    `- writes bulkhead (3 active, queue 12)
    |
    v
MongoDB driver and connection pool
```

The application forwards request cancellation and the controller's execution signal into MongoDB. It uses a 1.5-second execution timeout, a bounded circuit breaker, safe `503`/`504` mapping, metrics at `/api/metrics`, explicit shutdown, and an optional loopback Load Lab.

## Run the application

```bash
cd examples/feedback-board
docker compose up -d
npm install
npm start
```

Open <http://localhost:3000>. Set `LOAD_LAB=true` before `npm start` to open the API test dashboard at <http://127.0.0.1:1913>.

## Run the matched A/B comparison

```bash
npm run compare
```

The runner starts the same application twice with isolated temporary databases: once with direct MongoDB calls and once with Lazpho enabled. Both receive the same five APIs, requests, concurrency, simulated database latency, and machine resources. It removes the temporary databases and writes combined HTML and JSON reports.

Defaults are 100 requests per endpoint, concurrency 50, and 100 ms simulated database latency. Override `COMPARE_REQUESTS`, `COMPARE_CONCURRENCY`, or `COMPARE_DB_LATENCY_MS` to change the bounded workload.

## Recorded overload evidence

The repeated local matrix used 100 ms simulated database latency, at most 256 in-flight client requests, and a 10,000-request safety cap per endpoint. These are machine-specific observations:

| Requested RPS | Direct completed RPS | Lazpho completed RPS | Direct DB peak | Lazpho DB limit | Direct median RSS | Lazpho median RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 941.0 | 921.2 | 256 | 8 | 144.0 MiB | 112.3 MiB |
| 50,000 | 1,013.2 | 866.1 | 256 | 8 | 144.8 MiB | 111.8 MiB |
| 100,000 | 1,018.0 | 861.5 | 256 | 8 | 143.8 MiB | 111.5 MiB |
| 1,000,000 | 729.0 | 653.9 | 256 | 8 | 142.2 MiB | 111.6 MiB |

The generator did not achieve the selected high rates. The meaningful result is that direct mode allowed database work to reach 256 simultaneous operations, while Lazpho held database work at or below eight and converted excess pressure into explicit `503` responses. Direct mode completed more requests in several rows; Lazpho's purpose here was bounded dependency pressure and predictable shedding, not maximum accepted throughput.

## Recorded election evidence

In a three-member MongoDB election smoke, direct mode reached a roughly five-second P95 with client network timeouts. Lazpho kept sampled database work within its limit and returned bounded `503`/`504` outcomes with a much lower P95 in that run. Both modes elected a new primary, recovered, preserved every acknowledged write, produced no duplicate run-owned title, and made pre/post-election sentinels majority-readable from all three members.

See [MongoDB transport-fault validation](mongodb-fault-validation.md) and [replica-set election validation](mongodb-replica-set-validation.md) for the exact configuration and limitations.

## Advantages demonstrated

- Dependency concurrency and waiting work remain within explicit bounds.
- Excess load becomes classified rejection or timeout instead of uncontrolled fan-out.
- Read/write bulkheads provide local isolation while respecting one global capacity limit.
- A circuit breaker fails fast during repeated dependency failure and recovers through bounded probes.
- Metrics distinguish queue wait, execution time, timeout, rejection, retry, and breaker behavior.
- Request cancellation, shutdown drain, safe endpoint fixtures, and report generation are exercised through the real application.

## Costs and limitations

- Lazpho adds coordination and metrics overhead on every protected operation.
- Conservative limits can reduce accepted throughput and deliberately increase `503`/`504` responses during overload.
- Incorrect limits, queues, timeouts, retry rules, or breaker thresholds can harm availability.
- Limits are process-local and multiply across Node processes or replicas.
- A queue delays work; it does not create dependency capacity.
- Cancellation remains cooperative and depends on the underlying client.
- The local Load Lab cannot prove 10k–1m RPS and is not a distributed benchmark system.
- Lazpho does not replace database pooling, indexes, caching, rate limiting, autoscaling, tracing, durable queues, transactions, idempotency, or production monitoring.

## When the comparison should show little benefit

At healthy load, the dependency has spare capacity and queues never form. Lazpho should then add only small coordination overhead, and a direct application may be slightly faster. Protection becomes useful when concurrency itself contributes to slowdown, failures cascade, independent dependency classes interfere, or recovery is harmed by excessive in-flight work.

Never claim that Lazpho universally improves throughput or latency. Use matched application-specific evidence and decide whether stability, useful completions, explicit shedding, and recovery justify the tradeoff.
