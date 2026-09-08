# Contributing to Lazpho

Use a supported Node version and make focused changes. Install exactly from the lockfile:

```bash
npm ci
npm test
npm run build
npm run api:check
npm run compat
```

Run `npm run stress` and `npm run soak` for controller, scheduling, retry, breaker, bulkhead, cancellation, or lifecycle changes. Run relevant benchmarks for hot-path changes, but do not treat noisy local throughput as a universal target. Use `npm run package:verify` for package/docs/export changes.

## Public API changes

1. Change implementation, declarations, behavioral tests, and documentation together.
2. Run `npm run api:check`; do not dismiss or truncate its diff.
3. Classify runtime and type impact using `docs/versioning.md`.
4. Only after review, run `npm run api:update` to accept intended contract changes.
5. Review snapshots, update `CHANGELOG.md`, and add migration guidance for breaking changes.

Never use `api:update` merely to make CI green. New exports, metrics, error/warning codes, preset values, subpaths, and peer ranges all require review. Exact message wording is not contractual, but codes and metadata are.

Before a release, run `npm run release:readiness`, inspect the retained tarball/manifest/checksum, and complete the human checklist in `docs/1.0-readiness.md`. Version selection, package ownership, and publishing remain maintainer-controlled.
