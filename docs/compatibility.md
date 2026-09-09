# Compatibility and public API stability

## Compatibility matrix

| Surface | Compatibility promise | Local verification |
| --- | --- | --- |
| Node core runtime | Node 18, 20, 22, and 24 | Node 24.11.1; `npm run compat` is version-independent for the four-major matrix |
| Actively maintained Node | Node 22 Maintenance LTS and Node 24 Active LTS as of September 2026 | Node 24.11.1 |
| Legacy Node compatibility | Node 18 and 20 remain API-compatible targets but are upstream EOL | Matrix-ready compatibility command; no upstream security support is implied |
| TypeScript | 5.7 minimum through current 5.x | 5.7.2 and 5.9.3 compile the packed consumer |
| Module system | ESM and NodeNext declarations | Runtime import and declaration resolution from the tarball |
| Express | Peer `>=4.18 <6`; Node 18+ | Minimum 4.18.2; current supported 5.2.1; local suite 4.22.2 |
| Fastify | Peer `>=4 <6`; Fastify 4 on Node 18, Fastify 5 on Node 20+ | Minimum 4.0.0; current supported 5.12.3; local suite 4.29.1 |
| NestJS | `@nestjs/common >=10 <12`; NestJS 10 on Node 18, NestJS 11 on Node 20+ | Minimum 10.0.0; current supported 11.2.3; local suite 10.4.22 |
| Native fetch | Node-provided `fetch`, `Request`, `Response`, and abort primitives | Packed consumer exercises the adapter without a polyfill |
| OpenTelemetry | Structurally injected consumer-owned Meter | No OpenTelemetry package dependency |

The implementation uses APIs available in Node 18: ESM package exports, `AbortController`, `AbortSignal.reason`, native fetch, `node:` imports, and modern promise/timer APIs. Development tooling is tested with the TypeScript versions above and may have narrower patch-level requirements than the published runtime.

Node lifecycle status follows the [official Node.js release schedule](https://github.com/nodejs/Release#release-schedule). Compatibility with an upstream-EOL runtime does not provide security maintenance for that runtime.

## Public package entry points

The supported entry points are:

- `lazpho`
- `lazpho/config`
- `lazpho/application`
- `lazpho/load-lab`
- `lazpho/fetch`
- `lazpho/node-http`
- `lazpho/observability`
- `lazpho/opentelemetry`
- `lazpho/express`
- `lazpho/fastify`
- `lazpho/nestjs`

Only the package root and subpaths declared in `package.json#exports` are public. Deep imports such as `lazpho/partition-scheduler`, `lazpho/concurrency-controller`, and `lazpho/dist/*` are unsupported even when matching files exist in the tarball.

Lazpho is ESM-only. Consumers should use `import`; CommonJS `require()` compatibility is not promised.

## Stability contract

The intentionally exported JavaScript APIs and TypeScript declarations are stable. This includes controller lifecycle and run signatures, error classes/codes/readonly metadata, error classification, configuration fields, preset names, warning codes, adapter setup and ownership options, observability APIs, metric names, and numeric lifecycle/breaker mappings.

Exact English error and warning messages are informational, not stable machine API. Use error classes, `code`, readonly metadata, classification values, and warning codes. Preset names and intent are stable. Numeric preset values are review-controlled defaults: changing them requires an API snapshot update and release notes, but may be a minor change when the documented intent remains compatible.

Type compatibility is part of the contract. Narrowing accepted input, changing generic inference incompatibly, making an optional field required, or removing an exported type can be breaking even when existing JavaScript still executes.

## API change workflow

`npm run api:check` builds the package and compares current runtime/type surfaces with committed deterministic contracts in `api/`. It detects added, removed, and changed exports, declarations, subpaths, error contracts, presets, warning codes, HTTP mappings, metrics, and numeric mappings.

When an intentional change occurs:

1. Run `npm run api:check` and review the reported additions, removals, or changed declaration line.
2. Classify its semantic-version impact.
3. Run `npm run api:update` explicitly.
4. Review the contract diff and document the change before committing.

Normal tests never update API contracts.

## Semantic-version classification

- Patch: internal refactors, performance improvements, documentation corrections, and bug fixes that preserve public behavior and types.
- Minor: additive optional APIs, metrics, adapters, or backwards-compatible configuration fields; deliberately tuned preset values with unchanged intent and release notes.
- Major: removed or renamed exports/subpaths/types, newly required arguments, narrowed inputs, incompatible generic changes, changed error codes or metadata, removed warning codes, lifecycle-state changes, stable metric renames, numeric mapping changes, or an incompatible module-system change.

## Packed-consumer validation

`npm run compat` builds and checks the API contract, creates an npm tarball in an isolated temporary directory, installs it into clean consumers, and verifies:

- core runtime use without framework peers;
- native fetch and legacy `run(async () => value)` behavior;
- rejection of undeclared internal subpaths;
- runtime resolution of all eleven public entry points;
- positive and negative public TypeScript usage under TypeScript 5.7.2 and the current compiler;
- absence of repository `src`, tests, compatibility fixtures, and path aliases from the consumer package.

Framework boundary versions can be supplied through the `COMPAT_*_VERSION` variables used by `scripts/compat.mjs`, allowing the same command to run the CI compatibility matrix without changing source or lockfiles.

The boundary results above were produced on Node 24.11.1 with Express types 4.17.17/5.0.6, Fastify Plugin 4.0.0/5.1.0, RxJS 7.8.0/7.8.2, and the appropriate Reflect Metadata peer. They establish representative framework boundaries; CI repeats them across the applicable Node majors. New ecosystem majors outside the declared peer ranges (including NestJS 12 and Fastify Plugin 6) are not currently promised.

## Public API categories

- Core: factory creation, fixed/adaptive controllers, protected functions, run and lifecycle contracts.
- Configuration: manual options, presets, validation, inspection, and warning codes.
- Errors: public classes, stable codes/metadata, and classification helpers.
- Metrics: snapshots, exporters, OpenTelemetry instruments, metric names, and numeric mappings.
- Adapters: fetch, Node HTTP, Express, Fastify, and NestJS setup, cancellation, mapping, and ownership behavior.
- Application integration: central registry, route mappings, explicit scenarios, loopback dashboard, and lifecycle ownership.
- Load Lab: explicit safe endpoint catalog, bounded local runner, loopback UI, and HTML/JSON reports.
- Internal: scheduler, controller implementations, EWMA, metric aggregators, queue nodes, and other undeclared subpaths.

## Automated compatibility gates

The GitHub Actions CI workflow runs on pull requests and pushes to `master`, and is also reusable by the release workflow. It matrix-tests Node 18/20/22/24, TypeScript 5.7.2/5.9.3, and the documented minimum/current framework profiles. API drift, packed-consumer failures, optional-peer leakage, deep-import access, stress invariants, short-soak resources, or tarball allowlist drift fail distinct named jobs. Benchmarks execute for functional assertions and log review without fixed performance thresholds.

The weekly/manual long-soak workflow is deliberately outside the pull-request gate. The tag/manual release workflow and external prerequisites are summarized in the README. CI always uses `npm ci` and the bundled npm for each selected Node release.
