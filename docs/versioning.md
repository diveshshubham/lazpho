# Versioning and stability policy

Lazpho follows Semantic Versioning for its documented runtime and TypeScript contracts. While the package is below 1.0, breaking changes are still deliberate, API-snapshot reviewed, documented in the changelog, and accompanied by migration notes. `0.x` does not mean arbitrary instability.

## What 1.0 will protect

Documented root exports, all eleven declared subpaths, public declarations, error classes/codes/metadata, classifications, configuration fields, preset names/intent, warning codes, metric names and numeric mappings, lifecycle states, application/dashboard ownership, Load Lab safety/report contracts, and framework ownership/error semantics are stable candidates. No current public API is designated experimental.

Scheduler internals, queue nodes, EWMA/AIMD implementation, breaker implementation, benchmarks, stress/soak harnesses, and undeclared `dist` modules remain internal.

## Change classification

- Patch: compatible bug/performance fixes, internal refactors, and documentation corrections.
- Minor: backwards-compatible optional APIs/configuration, new metrics, new adapters, new error or warning codes, and small documented preset safety tuning.
- Major: removed/renamed exports, subpaths, types, error/warning codes, stable metrics or lifecycle values; narrower callback/input/generic types; newly required properties/arguments; incompatible ownership/lifecycle/module behavior; or meaningful preset semantic shifts.

Runtime compatibility does not imply type compatibility. Making an optional field required, narrowing an accepted callback, changing generic inference incompatibly, or removing an exported type can be breaking even if existing JavaScript still runs.

Preset names and intent are stable. Exact numeric defaults are review-protected: small safety improvements may be minor with prominent release notes; meaningful operating-posture changes may require a major release. Metric addition is minor; rename/removal is major after 1.0. Adding an error/warning code is minor; removing, renaming, or reusing a code is breaking. Human-readable error/warning wording is informational.

## Deprecation and migration

Where practical after 1.0, document and type-annotate deprecation before removal. Deprecated public APIs are normally removed only in a future major release, without a fixed calendar guarantee. Every breaking release must provide actionable migration notes in `docs/migration.md` and the changelog.

## Release notes

Every release records applicable `Added`, `Changed`, `Fixed`, `Compatibility`, and `Breaking Changes` sections. Empty sections may be omitted. API snapshot changes require human SemVer review; automation detects differences but does not decide their meaning.
