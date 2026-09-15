# Changelog

Notable changes are recorded here using a concise Keep-a-Changelog-inspired structure.

## 1.0.1 - 2026-09-15

### Changed

- Reworked the README introduction to explain Lazpho's stability-first objective, principal advantages, best-fit dependency workloads, inappropriate use cases, and process-local limits more clearly.
- Documented controlled rejection as an overload-safety mechanism and clarified the additional idempotency, durable-workflow, and reconciliation requirements for payments and other critical mutations.

## 1.0.0 - 2026-09-14

### Added

- Added the executable `lazpho load-lab` CLI and `lazpho/openapi-load-lab` entry point for conservative OpenAPI discovery, automatically enabling only parameter-free GET/HEAD operations while leaving mutations and unresolved routes visible but disabled.
- Added CLI/package-consumer coverage, remote-target rejection, bounded OpenAPI document loading, server-side request headers, and generic OpenAPI Load Lab documentation for the stable release.
- Added repeatable `--header-env name:ENVIRONMENT_VARIABLE` CLI input for authenticated tests without placing secret values in process arguments, including missing-variable and duplicate-header validation.
- Added a reproducible Sagavoya authenticated queue-screening and ten-minute soak record with explicit success/latency acceptance checks, recovery evidence, limitations, and a provisional bounded configuration.
- Added `npm run validation:report` to consolidate local Sagavoya and MongoDB transport-fault evidence into standalone JSON/HTML with an explicit `READY` or `NOT_READY` result.
- Added a reusable authenticated Sagavoya phased runner with warm-up, strict status accounting, controller deltas, drain evidence, and secret-free JSON/HTML reports.
- Added Sagavoya MongoDB driver-pool counters and phased sampling for event-loop lag, controller queue/execution latency, concurrency, and pool checkout pressure.

### Changed

- Declared the documented root exports, twelve package subpaths, CLI, types, metrics, errors, lifecycle values, and adapter contracts as the stable 1.x public surface.
- Replaced the release workflow's long-lived npm token with workflow-specific OIDC trusted publishing.

### Fixed

- Prevented body-parsed, already-complete Node requests from being misclassified as client disconnects when Express or NestJS installs the abort bridge after request-body consumption.
- Corrected the Signalboard MongoDB fault runner's default upstream port from the proxy-style port `27018` to the local MongoDB default `27017`, restoring no-argument fault and cleanup validation.
- Corrected Sagavoya validation distortion by keeping health/metrics probes outside application admission and making per-request logging explicitly disableable for controlled benchmarks; the rerun cleared steady, capacity, recovery, and drain checks while retaining the remaining overload-P95 failure.
- Rejected an overly aggressive Sagavoya queue-wait calibration that improved one overload percentile but materially degraded post-overload recovery, retaining the safer provisional profile.

## 0.1.0-rc.2 - 2026-09-09

### Added

- Added a Signalboard Load Lab black-box validator covering every registered API in once, latency, and bounded-load modes, including report, authorization, controller-limit, and managed-fixture checks.
- Added a reproducible Signalboard validation record with local MongoDB A/B evidence, resource-soak results, interpretation boundaries, and remaining distributed-test work.
- Added a repository-owned MongoDB TCP fault proxy and fault-validation runner for latency spikes, transport loss, breaker behavior, recovery, and mixed-fault application soaking, with JSON/HTML reports and a bounded Linux CI gate.
- Added a disposable three-member MongoDB 8 replica-set lab covering real primary elections, majority-visible sentinels, acknowledged-write preservation, post-election recovery, Lazpho bounds, JSON/HTML reports, and CI evidence.
- Added task-oriented getting-started, existing-application adoption, testing, and Signalboard comparison guides; renamed milestone-based documents around their user-facing purpose.

### Fixed

- Replaced a millisecond wall-clock assumption in breaker observability coverage with a deterministic test clock, preventing false failures on slower CI workers.

## 0.1.0-rc.1 - 2026-09-08

### Added

- Fixed and adaptive concurrency controllers with bounded, partition-aware backpressure.
- Cooperative cancellation, execution and queue-wait timeouts, bounded retries, circuit breaker, and bulkheads.
- Native fetch, Node HTTP, Express, Fastify, and NestJS integrations.
- Pull/push metrics, structural OpenTelemetry integration, stable metric names, and bounded attributes.
- Deterministic presets, validation, inspection, and warning codes.
- Runtime/type API contracts, packed consumers, Node/TypeScript/framework CI matrices, stress/soak gates, and exact-artifact release automation.

### Changed

- Selected the proposed npm identity `lazpho`, replacing pre-release repository specifiers named `factory-node` without changing runtime APIs.
- Completed consumer documentation, API/operations references, SemVer and migration policy, and the auditable 1.0 readiness gate.
- Clarified that closed-loop evaluation scheduling is application-owned and added a sustained local-HTTP comparison for unlimited, fixed, and adaptive strategies.
- Added the repository-only full-path bottleneck lab, loopback dashboard, scenario API, and automated functional smoke gate.
- Added the `lazpho/application` registry and loopback dashboard, explicit safe-scenario execution, route-to-capacity mapping, application-owned adaptive evaluation, and optional framework-wide inbound metrics.
- Added the opt-in `lazpho/load-lab` MVP with explicit safe endpoint registration, per-endpoint request/latency/load actions, bounded local generation, Lazpho controller evidence, and HTML/JSON reports.
- Documented Lazpho's vision, appropriate and inappropriate uses, integration guidance, limitations, and responsible performance interpretation.
- Added Load Lab managed fixture callbacks for safe mutating-endpoint tests and upgraded Signalboard's isolated direct-versus-Lazpho workflow to produce combined HTML/JSON evidence reports.
- Added a safety-bounded, repeated Signalboard stress-test matrix for 10k through 1m requested-RPS inputs, with honest generator-limit markers, application resource metrics, and consolidated median HTML/JSON reports.

### Fixed

- Replaced shell-dependent test globs with deterministic cross-platform discovery so Node 18 and 20 CI execute the compiled suite on Linux.

### Compatibility

- Node 18/20/22/24, TypeScript 5.7.2/current 5.x, and documented Express/Fastify/NestJS boundaries remain automated compatibility targets.

This version has not been declared or published as Lazpho 1.0.
