# Stage 3 application and load validation

Stage 3 tests whether the published release candidate protects a real Node/MongoDB application, exposes understandable evidence, and remains honest about the load generator's limits. It does not attempt to turn a laptop into a distributed million-RPS benchmark.

## Reproduce the validation

Run library safety checks from the repository root:

```bash
npm run stress
npm run soak
npm run soak:long
```

Start MongoDB on `mongodb://127.0.0.1:27018`, then run the application comparisons:

```bash
cd examples/feedback-board
npm install
npm run check
npm run compare
npm run test:matrix
```

For the real dashboard validation, start Signalboard with Load Lab enabled in one terminal:

```powershell
$env:LOAD_LAB = "true"
npm start
```

Then run `npm run test:load-lab` in another terminal. It exercises all five registered APIs in once, latency, and load modes and verifies authorization, reports, controller limits, and application-owned cleanup.

## Evidence recorded on 2026-09-08

Environment: Windows x64 build 10.0.26200, Node 24.11.1, npm 11.6.2, MongoDB 8.3.8, AMD Ryzen 7 5800HS (16 logical CPUs), and 15.4 GiB system memory. Results below describe only this machine, database, payload, and configuration.

The seeded adversarial run completed 5,000 logical submissions with zero invariant violations and drained active work and queues to zero. The short soak completed 30 cycles/2,400 submissions with no listener warnings, unhandled rejections, uncaught exceptions, or obvious monotonic heap growth.

The long soak completed 250 cycles and 50,000 logical submissions in 9.66 seconds. It finished with zero active work, zero queued work, zero invariant violations, and no warnings or unhandled failures. Heap usage was 5.02 MiB initially, 5.18 MiB at completion, and 5.17 MiB after explicit garbage collection.

The MongoDB matrix ran all five APIs in direct and Lazpho modes, three repetitions at each selected target, one second per endpoint, with 100 ms simulated database latency, at most 256 client requests in flight, and a 10,000-request endpoint safety cap.

| Requested RPS | Direct completed RPS | Lazpho completed RPS | Direct DB peak | Lazpho DB limit | Direct median RSS | Lazpho median RSS | Interpretation |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10,000 | 941.0 | 921.2 | 256 | 8 | 144.0 MiB | 112.3 MiB | Generator-limited |
| 50,000 | 1,013.2 | 866.1 | 256 | 8 | 144.8 MiB | 111.8 MiB | Generator- and safety-limited |
| 100,000 | 1,018.0 | 861.5 | 256 | 8 | 143.8 MiB | 111.5 MiB | Generator- and safety-limited |
| 1,000,000 | 729.0 | 653.9 | 256 | 8 | 142.2 MiB | 111.6 MiB | Generator- and safety-limited |

The important result is the enforced dependency bound: direct mode reached the generator's 256-operation concurrency ceiling, while Lazpho kept database work at or below 8 and shed excess work with explicit `503` responses. The memory difference is an observation from these isolated runs, not a general promise. Success count alone is not the objective during overload; useful completions, bounded dependency work, tail latency, explicit shedding, and recovery must be evaluated together.

The Load Lab black-box validation completed 15 runs: five APIs across once, latency, and bounded-load modes. It attempted 3,609 requests, reported 691 successes and 2,918 expected overload responses, found zero controller-limit violations, and left zero managed fixtures. All 15 runs completed and exposed downloadable HTML and JSON reports.

## What this proves

- the package survives deterministic cancellation, timeout, retry, breaker, reconfiguration, saturation, and shutdown races without violating its accounting invariants;
- Signalboard integrates Lazpho around the real MongoDB capacity boundary rather than around superficial route counts;
- overload becomes bounded queueing and explicit shedding instead of unbounded database concurrency;
- every dashboard path has working once, latency, and load controls with report generation;
- mutating endpoint tests can remain safe when the application owns fixture setup and exact cleanup.

## What this does not prove

- 10k, 50k, 100k, or 1m achieved requests per second—the local generator did not achieve those selected inputs;
- universal latency, throughput, CPU, or memory improvements;
- production readiness for arbitrary workloads, queries, connection pools, authentication, or downstream services;
- multi-host behavior, network faults, MongoDB failover, replica-set elections, or geographically distributed traffic;
- that Lazpho should wrap CPU-bound work, already-bounded cheap operations, or every route indiscriminately.

## Remaining Stage 3 work

Every pull request now repeats a bounded Signalboard direct-versus-Lazpho comparison, all 15 Load Lab endpoint/action combinations, and a transport-fault smoke against MongoDB 8 on Linux, retaining generated reports for 14 days. [Stage 3B fault validation](stage3b-fault-validation.md) records the local latency, disconnect, recovery, and mixed-soak evidence. Before a broader technical preview, repeat representative scenarios on a production-like MongoDB deployment and add real replica-set election and data-consistency tests. Use coordinated external generators if a high-rate capacity claim is needed, and publish the generator topology, hardware, safety limits, achieved rate, and error distribution with any result.
