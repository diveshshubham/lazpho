# MongoDB transport-fault and recovery validation

This validation evaluates how Signalboard behaves when its MongoDB transport becomes slow, disappears, and returns. A repository-owned TCP proxy injects latency and cuts sockets without stopping or modifying the upstream database. Both direct and Lazpho modes receive the same request count, concurrency, fault sequence, and MongoDB server.

## Run it

Start a disposable or local MongoDB instance, install the Signalboard dependencies, and run:

```bash
cd examples/feedback-board
npm install
npm run test:faults
```

Defaults use 32 client workers, 80 requests in each fixed phase, 150 ms delay in both TCP directions, and a 20-second mixed-fault soak per mode. `FAULT_CONCURRENCY`, `FAULT_BATCH_REQUESTS`, `FAULT_LATENCY_MS`, and `FAULT_SOAK_SECONDS` can reduce or extend the bounded run.

The runner requires healthy success, visible outage failures, successful post-outage recovery, direct dependency fan-out above Lazpho's configured limit, zero sampled Lazpho limit violations, a breaker trip and return to closed, zero final active/queued controller work, and exact temporary-database cleanup. It writes standalone JSON and HTML reports under `examples/feedback-board/load-reports/`.

## Evidence recorded on 2026-09-08

The environment matches the [Signalboard validation record](signalboard-validation.md): Windows x64, Node 24.11.1, npm 11.6.2, MongoDB 8.3.8, AMD Ryzen 7 5800HS, 16 logical CPUs, and 15.4 GiB memory.

| Mode | Phase | Attempted | Successful | Failed | 503 | 504 | 500 | P95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | Healthy | 80 | 80 | 0 | 0 | 0 | 0 | 111.7 ms |
| Direct | 300 ms injected round trip | 80 | 60 | 20 | 0 | 0 | 20 | 2,993.6 ms |
| Direct | Transport outage | 40 | 0 | 40 | 0 | 0 | 2 | 4,023.9 ms |
| Direct | Recovery | 80 | 80 | 0 | 0 | 0 | 0 | 67.9 ms |
| Direct | 20-second mixed soak | 6,389 | 6,389 | 0 | 0 | 0 | 0 | 620.0 ms |
| Lazpho | Healthy | 80 | 80 | 0 | 0 | 0 | 0 | 154.1 ms |
| Lazpho | 300 ms injected round trip | 80 | 16 | 64 | 12 | 52 | 0 | 2,135.4 ms |
| Lazpho | Transport outage | 40 | 0 | 40 | 39 | 0 | 1 | 21.0 ms |
| Lazpho | Recovery | 80 | 80 | 0 | 0 | 0 | 0 | 56.8 ms |
| Lazpho | 20-second mixed soak | 4,470 | 4,213 | 257 | 0 | 257 | 0 | 757.4 ms |

Direct database work peaked at 38 simultaneous operations. The 10 ms metric sampler observed Lazpho at a peak of 6 active and 26 queued operations, within the configured global limit of 8 and read bulkhead limit of 6. It recorded zero limit violations across 1,758 samples. The controller ended with zero active and queued work; the breaker tripped three times and returned to closed after recovery.

The direct mode's successful mixed-soak requests do not mean the outage was free: the MongoDB driver retained and retried work across short cuts, and P95 rose to 620 ms. During the explicit outage batch, requests took about four to eight seconds to settle. Lazpho made overload and outage pressure explicit through bounded `503`/`504` outcomes, opened its breaker, and restored healthy success after transport recovery.

## Interpretation limits

- This validates bounded application behavior and recovery under TCP latency and connection loss; it is not a throughput benchmark.
- A socket cut is only failover-style transport pressure. It does not reproduce MongoDB elections, replication lag, rollback, write concern, retryable-write semantics, or consistency behavior. See the [replica-set validation](mongodb-replica-set-validation.md) for bounded election and majority-durability evidence.
- Results depend on the local OS, driver, MongoDB version, payload, connection pool, and timing.
- A protective rejection or timeout is not a successful business operation, but it can be preferable to unbounded dependency work and uncontrolled tail latency.
- Production-like replica-set and network-emulation testing remains required before making database failover claims.

The required `Signalboard MongoDB and Load Lab` CI job runs a shorter version of this experiment on Linux against MongoDB 8 and retains its reports for 14 days.
