# Phase 8 real-application validation

The Phase 8 benchmark answers whether the existing adaptive controller visibly changes a linked limiter under sustained real Node.js traffic. It is a repository benchmark, not a universal performance claim or a release pass/fail threshold.

Run:

```bash
npm run bench:phase8
```

The benchmark starts a local Node HTTP dependency and runs equivalent healthy, saturation, slowdown, and recovery periods through three strategies:

1. unlimited direct fetch;
2. a fixed concurrency controller;
3. the same controller linked to adaptive control in `auto` mode.

The adaptive configuration is printed with the result. Evaluation is explicitly invoked once per window; Lazpho itself does not create a timer. Assertions use behavioral properties rather than exact limits: bounded admission, healthy growth, protective reduction, recovery probing, complete drain, clean shutdown, and no unhandled process failures.

Recovery deliberately returns both dependency latency and offered load to a sustainable range. If queue timeouts remain above the configured guardrail, the safety policy continues to hold/back off at the minimum rather than using increased concurrency as an escape from overload. Applications must shed enough load for healthy evidence to reappear.

Each timeline row shows controller state at an evaluation boundary, lifetime counters, counter-delta throughput, and the controller's bounded rolling latency percentiles. Summary request percentiles are independently measured by the benchmark. Controller counters and average timings are lifetime values; controller percentiles retain only their configured rolling sample, so they are not reset between phases. No public reset API is added for this benchmark.

Outcome classification is explicit and mutually exclusive: successful downstream response, queue rejection, queue-wait timeout, execution timeout, downstream failure, or cancellation. A route that catches these errors and returns HTTP 200 would hide the distinction at the HTTP layer; that is application behavior, not controller behavior.
