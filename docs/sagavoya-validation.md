# Sagavoya authenticated integration validation

This record evaluates Lazpho through a real existing NestJS application rather than a controller-only benchmark. It covers authenticated HTTP traffic, MongoDB-backed user reads, queue tuning, sustained overload, recovery, and the limits of the evidence.

## Scope and safety

The validation used Sagavoya's compiled API and the read-only `GET /api/users/me` route. A test identity was authenticated once per application process. Its bearer token remained in memory and was excluded from command arguments, JSON, HTML, and repository files.

The local Windows machine used Node.js 24.11.1 and 16 logical CPUs. The initial run sampled the authenticated `/api/metrics/summary` endpoint through the same Lazpho HTTP controller and wrote every request to disk. The corrected run excludes `/api/health` and `/api/metrics` from application admission and sets `HTTP_REQUEST_LOGGING_ENABLED=false` on the test process. Operational endpoints remain authenticated as configured; they simply do not consume the capacity they observe.

These results are local integration evidence. They are not production capacity, availability, or million-RPS claims.

## Queue screening recorded on 2026-09-14

The test held HTTP and MongoDB concurrency at 16, varied queue size and maximum queue wait, and ran 50, 100, and 200 requested RPS for three seconds three times. Each cell below is the median repetition. Latency includes successful responses only; `503` and `504` responses remain failures in the success rate.

| Queue | Wait | 50 RPS success / P95 | 100 RPS success / P95 | 200 RPS success / P95 |
| ---: | ---: | ---: | ---: | ---: |
| 16 | 100 ms | 100% / 79.3 ms | 91.7% / 219.6 ms | 58.0% / 519.7 ms |
| **16** | **150 ms** | **100% / 80.0 ms** | **100% / 82.3 ms** | **57.8% / 515.9 ms** |
| 16 | 200 ms | 100% / 95.8 ms | 100% / 90.5 ms | 54.3% / 547.6 ms |
| 32 | 100 ms | 100% / 79.2 ms | 98.0% / 166.0 ms | 54.3% / 587.9 ms |
| 32 | 150 ms | 100% / 77.2 ms | 100% / 86.9 ms | 55.5% / 614.6 ms |
| 32 | 200 ms | 100% / 77.9 ms | 100% / 79.6 ms | 55.2% / 589.3 ms |

The provisional recommendation is:

```env
LAZPHO_HTTP_LIMIT=16
LAZPHO_HTTP_QUEUE_SIZE=16
LAZPHO_HTTP_QUEUE_WAIT_MS=150
LAZPHO_MONGO_LIMIT=16
LAZPHO_MONGO_QUEUE_SIZE=16
LAZPHO_MONGO_QUEUE_WAIT_MS=150
```

This was the smallest profile that achieved at least 99% median success and at most 500 ms successful P95 at both 50 and 100 RPS. No tested profile met the 500 ms overload P95 target at 200 RPS, so the fallback selected the eligible profile with the lowest overload P95.

## Initial ten-minute phased soak

A fresh Sagavoya process used the selected profile for ten continuous minutes. The sequence intentionally tested steady traffic, capacity pressure, overload, and recovery without restarting the application.

| Phase | Duration | Requested RPS | Attempted | Successful | Success | Successful P95 | Status distribution |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Steady | 120 s | 50 | 6,000 | 4,292 | 71.5% | 831.1 ms | 4,292 `200`; 1,708 `504` |
| Capacity | 180 s | 100 | 18,000 | 16,840 | 93.6% | 174.0 ms | 16,840 `200`; 384 `503`; 776 `504` |
| Overload | 180 s | 200 | 36,000 | 18,980 | 52.7% | 539.6 ms | 18,980 `200`; 12,100 `503`; 4,920 `504` |
| Recovery | 120 s | 50 | 6,000 | 6,000 | 100% | 76.4 ms | 6,000 `200` |

HTTP active work peaked at 12, matching the read bulkhead's reserved share of the configured global limit of 16. The sampled HTTP queue peaked at 11, below its capacity of 16. MongoDB active work peaked at 11, also below its configured limit.

The controller deltas narrow the failure mode. All 1,785 steady-phase HTTP rejections were queue-wait timeouts; none were queue-full bulkhead rejections. The capacity phase recorded 778 queue timeouts and 403 bulkhead rejections. MongoDB admitted the successful user reads without controller rejection in every phase. Metrics-sampling requests are included in the HTTP controller deltas, so those counts are slightly higher than the workload totals. This points to request-level waiting and variable downstream completion time rather than MongoDB-controller capacity rejection.

The process recovered fully after sustained overload, which is useful resilience evidence. The steady and capacity phases nevertheless missed the 99% success objective, and overload P95 missed the 500 ms objective. The initial steady degradation did not persist into final recovery, but this run does not isolate whether its cause was database latency, application startup work, request-log I/O, another integration, or local resource contention.

## Initial release decision

The initial authenticated Sagavoya performance gate was **not ready** for a stable-release claim:

- steady success was 71.5%, below 99%;
- steady successful P95 was 831.1 ms, above 500 ms;
- capacity success was 93.6%, below 99%; and
- overload successful P95 was 539.6 ms, above 500 ms.

Recovery, concurrency bounds, and controlled shedding passed. This decision is retained as historical evidence and is superseded by the corrected gate below.

The investigation confirmed that JWT validation does not query MongoDB; `GET /api/users/me` performs one MongoDB lookup. It also confirmed that the initial observer requests consumed the same read bulkhead and that the run wrote one request log entry per call. A first diagnostic retry was invalidated by Sagavoya's global throttle (`429` responses), which was then raised only on the isolated test process.

## Corrected ten-minute gate

The same process then ran all four phases with the selected `16/16/150 ms` profile, operational routes outside application admission, request logging disabled, a warm-up, and a test-only throttle ceiling above the offered load.

| Phase | Duration | Requested RPS | Attempted | Successful | Success | Successful P95 | Status distribution |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Steady | 120 s | 50 | 6,000 | 6,000 | 100% | 72.9 ms | 6,000 `200` |
| Capacity | 180 s | 100 | 18,000 | 18,000 | 100% | 73.0 ms | 18,000 `200` |
| Overload | 180 s | 200 | 36,000 | 15,282 | 42.5% | 573.6 ms | 15,282 `200`; 13,921 `503`; 6,797 `504` |
| Recovery | 120 s | 50 | 6,000 | 6,000 | 100% | 106.8 ms | 6,000 `200` |

HTTP and MongoDB controller deltas exactly matched the successful workload in steady, capacity, and recovery. Each controller ended every phase at `active=0`, `queued=0`. During overload, HTTP admission explicitly shed excess work while MongoDB admitted and completed 15,322 protected operations without controller rejection. The process returned to 100% success after overload.

The corrected evidence clears the steady, capacity, recovery, and drain checks. The stable gate remains **not ready** only because overload successful P95 was 573.6 ms, above the declared 500 ms threshold. Successful latency still excludes `503` and `504`; those remain failed business operations.

A bounded follow-up reduced only the HTTP queue-wait deadline from 150 ms to 50 ms. Over 60 seconds at 200 RPS, successful P95 fell to 453.0 ms, but the following 50 RPS recovery achieved only 78.9% success with 552.6 ms P95. That profile was rejected: earlier shedding made one overload percentile pass but degraded useful recovery. The `150 ms` recommendation and failed overload check remain unchanged.

## Overload bottleneck diagnosis

Sagavoya now exposes aggregate MongoDB driver pool events alongside Lazpho controller timing. The metrics contain counts and concurrency only; they do not expose the connection URI, query values, or credentials. The authenticated runner samples these signals once per second without passing metrics requests through application admission.

At the selected concurrency of 16 (12 read slots), a 60-second 200 RPS diagnostic observed:

- successful request P95 of 566.3 ms;
- HTTP queue-wait P95 peaking at 70.5 ms;
- MongoDB protected-execution P95 peaking at 529.2 ms;
- event-loop lag P95 of 25.5 ms;
- 12 active MongoDB reads, zero MongoDB-controller queueing, and 12 checked-out driver connections; and
- zero driver checkout failures or pool clears.

This attributes the dominant tail latency to MongoDB operation completion, including its network path, rather than the Node.js event loop, Lazpho's MongoDB queue, or pool checkout contention. The following 50 RPS recovery also saw MongoDB execution P95 temporarily rise above 700 ms, demonstrating variable downstream behavior after sustained overload.

Two lower-concurrency profiles were rejected:

| HTTP / Mongo limit | Read slots | Capacity result | Overload result | Immediate recovery | Decision |
| ---: | ---: | --- | --- | --- | --- |
| 12 / 12 | 9 | Not rerun | 46.9% success, 384.9 ms P95 | 89.9% success | Reject: recovery below 99% |
| 10 / 10 | 7 | 79.2% success, 286.2 ms P95 | 40.1% success, 316.1 ms P95 | 95.7% success | Reject: capacity and recovery below 99% |

Reducing concurrency successfully lowers MongoDB execution latency, which confirms that Lazpho is controlling the relevant pressure. It also reduces useful throughput below the declared 100 RPS capacity requirement. The next valid experiment must therefore change downstream capacity or request cost—not hide failures by shortening the queue or lowering concurrency. Repeat against a representative staging MongoDB deployment with database-side slow-query, index, CPU, I/O, and connection metrics. If that environment has the same ceiling, optimize or cache the user read, scale the database, or lower the application's stated capacity target before selecting new Lazpho limits.

Run the reproducible gate with short-lived environment variables:

```powershell
$env:SAGAVOYA_TEST_EMAIL='<test-account-email>'
$env:SAGAVOYA_TEST_PASSWORD='<test-account-password>'
$env:SAGAVOYA_DIAGNOSTIC_PHASES='steady:50:120,capacity:100:180,overload:200:180,recovery:50:120'
$env:SAGAVOYA_DIAGNOSTIC_OUTPUT='artifacts/sagavoya-corrected-gate'
node scripts/sagavoya-isolated-diagnostic.mjs
Remove-Item Env:SAGAVOYA_TEST_EMAIL, Env:SAGAVOYA_TEST_PASSWORD
```

Start Sagavoya with `HTTP_REQUEST_LOGGING_ENABLED=false` and a test-only `THROTTLE_LIMIT` above the total requests per throttle window. Do not use that throttle value as a production default.

## Reports

The local runner writes ignored standalone reports to:

- `artifacts/sagavoya-final-validation/latest.html` and `latest.json` for the full matrix and soak;
- `artifacts/sagavoya-corrected-gate/latest.html` and `latest.json` for the corrected isolated gate;
- `artifacts/release-validation/latest.html` and `latest.json` for consolidated acceptance checks.

Generate the consolidated report from existing local inputs with:

```bash
npm run validation:report
```

The command deliberately reports `NOT_READY` and exits unsuccessfully when an acceptance check fails. It does not convert controlled shedding into successful traffic.
