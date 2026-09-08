# Changelog

Notable changes are recorded here using a concise Keep-a-Changelog-inspired structure. Dates indicate releases, not development phases.

## Unreleased

### Changed

- Selected the proposed npm identity `lazpho`, replacing pre-release repository specifiers named `factory-node` without changing runtime APIs.
- Completed consumer documentation, API/operations references, SemVer and migration policy, and the auditable 1.0 readiness gate.
- Clarified that closed-loop evaluation scheduling is application-owned and added a sustained local-HTTP Phase 8 comparison for unlimited, fixed, and adaptive strategies.
- Added the repository-only Phase 8B full-path bottleneck lab, loopback dashboard, scenario API, and automated functional smoke gate.
- Completed Phase 8 with the additive `lazpho/application` registry and loopback dashboard, explicit safe-scenario execution, route-to-capacity mapping, application-owned adaptive evaluation, and optional framework-wide inbound metrics.
- Added the opt-in `lazpho/load-lab` MVP with explicit safe endpoint registration, per-endpoint request/latency/load actions, bounded local generation, Lazpho controller evidence, and HTML/JSON reports.
- Documented Lazpho's vision, appropriate and inappropriate uses, integration guidance, limitations, and responsible performance interpretation.
- Added Load Lab managed fixture callbacks for safe mutating-endpoint tests and upgraded Signalboard's isolated direct-versus-Lazpho workflow to produce combined HTML/JSON evidence reports.
- Added a safety-bounded, repeated Signalboard stress-test matrix for 10k through 1m requested-RPS inputs, with honest generator-limit markers, application resource metrics, and consolidated median HTML/JSON reports.

### Compatibility

- Node 18/20/22/24, TypeScript 5.7.2/current 5.x, and documented Express/Fastify/NestJS boundaries remain automated compatibility targets.

## 0.1.0 - Pending first release

### Added

- Fixed and adaptive concurrency controllers with bounded, partition-aware backpressure.
- Cooperative cancellation, execution and queue-wait timeouts, bounded retries, circuit breaker, and bulkheads.
- Native fetch, Node HTTP, Express, Fastify, and NestJS integrations.
- Pull/push metrics, structural OpenTelemetry integration, stable metric names, and bounded attributes.
- Deterministic presets, validation, inspection, and warning codes.
- Runtime/type API contracts, packed consumers, Node/TypeScript/framework CI matrices, stress/soak gates, and exact-artifact release automation.

This version has not been declared or published as Lazpho 1.0.
