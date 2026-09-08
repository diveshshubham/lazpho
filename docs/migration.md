# Migration guide

## Pre-release package identity

The repository package identity changed from `factory-node` to `lazpho` before its first Lazpho npm release. Runtime behavior and exported symbol names did not change.

```bash
npm remove factory-node
npm install lazpho
```

Replace only package specifiers:

```ts
// Before
import { createFactory } from 'factory-node';
import { createProtectedFetch } from 'factory-node/fetch';

// After
import { createFactory } from 'lazpho';
import { createProtectedFetch } from 'lazpho/fetch';
```

The same rule applies to `config`, `node-http`, `observability`, `opentelemetry`, `express`, `fastify`, and `nestjs`. Existing `createFactory`, controller, configuration, error, and adapter APIs remain unchanged. The unrelated npm package already using `factory-node` was never a Lazpho distribution and must not be treated as an upgrade source.

Future breaking releases will add sections here with before/after examples, behavior changes, and any temporary deprecations.
