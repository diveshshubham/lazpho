# Stage 3C MongoDB replica-set validation

Stage 3C evaluates Signalboard and Lazpho during a real MongoDB primary election. A disposable Docker Compose lab starts three MongoDB 8 voting data-bearing members, runs identical direct and Lazpho application modes, issues mixed HTTP reads and majority writes, steps down the current primary for 30 seconds, and requires a different member to become primary.

## Acceptance criteria

The runner fails unless both application modes:

- observe a primary change with a new election ID;
- complete application traffic during the election workload and recover healthy reads and writes afterward;
- retain every HTTP `201` acknowledged write by `_id`;
- contain no duplicate run-owned logical title;
- make pre-election and post-election sentinel writes majority-readable directly from all three members; and
- remove their exact temporary database after shutdown.

For Lazpho, the 10 ms sampler additionally requires controller activity, zero samples above the configured concurrency limit, and zero final active or queued operations. HTTP `503`, `504`, `500`, and network outcomes remain separate in JSON/HTML reports. A protective rejection is not counted as a successful business operation.

## Run it

Docker Desktop or Docker Engine with Compose v2 is required. From `examples/feedback-board`:

```bash
docker compose -f docker-compose.replica-set.yml up --exit-code-from test test
docker compose -f docker-compose.replica-set.yml down --volumes
```

The Compose project has the fixed name `lazpho-stage3c`, uses temporary MongoDB filesystems and anonymous dependency volumes, and exposes no database port to the host. The second command removes only those disposable resources. Reports remain in the repository's ignored `examples/feedback-board/load-reports/` directory.

Defaults use 24 workers, a 12-second workload, and a maximum of 3,000 HTTP requests per application mode. `REPLICA_CONCURRENCY`, `REPLICA_DURATION_SECONDS`, and `REPLICA_MAX_REQUESTS` accept bounded overrides. CI uses 12 workers, six seconds, and 800 requests.

## Local evidence recorded on 2026-09-08

A reduced Windows/Docker Desktop smoke used MongoDB 8, Node 24.20.0 inside the runner container, 12 workers, six seconds, and at most 800 requests per mode.

| Mode | Primary change | Attempted | Successful | Failed | 503 | 504 | Network | P95 | Acknowledged writes missing |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | `mongo3` → `mongo2` | 290 | 266 | 24 | 0 | 0 | 24 | 5,000.9 ms | 0 of 132 |
| Lazpho | `mongo2` → `mongo1` | 800 | 249 | 551 | 534 | 17 | 0 | 37.5 ms | 0 of 124 |

Both sentinel writes were majority-readable from all three members in both modes, and the maximum copies per run-owned title was one. Direct application database work peaked at 15 concurrent operations. The Lazpho sampler observed a peak of 8 active and 4 queued operations with zero configured-limit violations. Its MongoDB breaker tripped nine times, returned to closed, and the controller ended with zero active and queued work.

The direct mode's 24 network outcomes reached the client-side five-second timeout, producing the 5,000.9 ms P95. In this run Lazpho exposed election pressure as bounded `503`/`504` responses and restored service after a new primary became available. These results demonstrate overload containment for this workload; they do not guarantee lower latency or a specific error distribution on another machine or topology.

## Interpretation limits

- This is one three-member replica set on one Docker host, not a multi-host or multi-region deployment.
- `replSetStepDown` creates a real primary election but does not simulate a network partition, delayed or corrupted replication, rollback, disk loss, or a permanently unavailable majority.
- Majority read/write concern validates the sentinels and acknowledged operations used here; it does not prove every business transaction, schema, retry policy, or application-level idempotency strategy.
- The runner does not retry failed HTTP business operations. MongoDB retryable writes may retry eligible driver operations according to the URI.
- Results are bounded resilience evidence, not a throughput certification or a million-RPS claim.

The required `Signalboard MongoDB and Load Lab` GitHub job runs the reduced replica-set smoke and retains its report with the other Signalboard artifacts for 14 days.
