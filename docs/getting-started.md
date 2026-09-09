# Getting started

Lazpho is an ESM-only Node.js library for placing explicit concurrency, queue, timeout, retry, bulkhead, and circuit-breaker boundaries around asynchronous dependency work. Start with one important dependency operation; do not wrap every route automatically.

## Requirements

- Node.js 18 or newer;
- an ESM application (`"type": "module"`) or TypeScript configured for Node ESM/NodeNext;
- a promise-based database, HTTP, storage, worker, or other asynchronous dependency;
- knowledge of which operations share the same finite capacity.

Install the core package:

```bash
npm install lazpho
```

Framework adapters use optional peer dependencies. Install only the framework you use:

```bash
npm install express lazpho
# or: npm install fastify fastify-plugin lazpho
# or: npm install @nestjs/common rxjs lazpho
```

## Protect one dependency

Create the factory and controller once during application startup:

```js
import { createFactory } from 'lazpho';

const factory = createFactory();
const database = factory.concurrency({
  name: 'database',
  limit: 8,
  maxQueueSize: 40,
  maxQueueWaitMs: 500
});
```

Run the actual dependency operation through the shared controller and forward its signal:

```js
const users = await database.run(
  ({ signal }) => usersCollection.find({ active: true }, { signal }).toArray(),
  { timeoutMs: 1_500 }
);
```

The controller admits at most eight operations at once. Up to 40 additional operations may wait, each for no more than 500 ms. The 1,500 ms execution timeout starts only after admission. These values are examples, not universal recommendations.

## Handle protective outcomes

Queue saturation, queue-wait timeout, execution timeout, an open breaker, and shutdown are deliberate operational outcomes. Map them at the application boundary instead of exposing internal messages or treating every case as an unexpected `500`.

Express, Fastify, and NestJS integrations provide `mapLazphoErrorToHttp()`. Its conservative defaults map capacity and breaker outcomes to `503` and queue/execution timeouts to `504`:

```js
import { mapLazphoErrorToHttp } from 'lazpho/express';

app.use((error, _request, response, next) => {
  const mapped = mapLazphoErrorToHttp(error);
  if (!mapped) return next(error);
  response.status(mapped.statusCode).json({ code: mapped.code });
});
```

Ordinary dependency errors are not hidden. Log them through the application's existing private logging path.

## Shut down cleanly

Stop accepting new traffic, drain accepted controller work, close dependencies, and then close the factory:

```js
server.close(async () => {
  await database.close();
  await mongoClient.close();
  factory.close();
});
```

Framework shutdown helpers are described in the [API reference](api.md). An operation that ignores cancellation and never settles can also prevent graceful drain from finishing.

## What to add next

Add features only when the workload needs them:

| Need | Feature | Guidance |
| --- | --- | --- |
| Separate reads from writes | Bulkheads | Partitions share the global limit; they do not add capacity |
| Retry transient failures | Bounded retries | Use only for operations safe to repeat |
| Fail fast during repeated dependency failure | Circuit breaker | Tune from real failure behavior |
| Adjust a limit from observations | Adaptive controller | Begin in `observe` or `recommend`; keep explicit bounds |
| Protect native HTTP calls | Protected fetch | Throw on HTTP statuses that should count as failures |
| Export operational data | Metrics/OpenTelemetry | Keep labels bounded and application-owned |
| Exercise registered APIs locally | Load Lab | Register only explicitly safe scenarios and fixtures |

## Choose the next guide

- Building a new service: continue with [application integration](application-integration.md).
- Adding Lazpho to existing code: follow the [adoption guide](adoption-guide.md).
- Selecting limits and operating in production: read [vision, fit, and limitations](vision-and-usage.md) and [operations](operations.md).
- Verifying your integration: use the [testing guide](testing.md).
- Seeing a runnable MongoDB application: open the [Signalboard example and comparison](signalboard-comparison.md).
- Looking up exact exports and options: use the [API reference](api.md).
