import { createServer } from 'node:http';
import { CircuitBreakerOpenError, ControllerTimeoutError, createFactory } from '../index.js';
import { createProtectedFetch } from '../adapters/fetch.js';
import { createRequestAbortSignal, instrumentNodeHttp } from '../adapters/node-http.js';

const factory = createFactory();
const dependencies = factory.concurrency({
  name: 'outbound-dependencies',
  limit: 12,
  maxQueueSize: 100,
  bulkheads: {
    payments: { maxConcurrent: 5, maxQueue: 20 },
    search: { maxConcurrent: 7, maxQueue: 40 }
  },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10_000 }
});

const protectedFetch = createProtectedFetch({ controller: dependencies });
const paymentsUrl = process.env.PAYMENTS_URL ?? 'http://127.0.0.1:4000/payments';

const server = createServer(instrumentNodeHttp(factory, async (request, response) => {
  const requestAbort = createRequestAbortSignal(request, response);
  try {
    const dependencyResponse = await protectedFetch(paymentsUrl, {
      method: 'POST',
      bulkhead: 'payments',
      timeoutMs: 1_000,
      retry: { attempts: 1, delayMs: 25 },
      signal: requestAbort.signal
    });
    response.statusCode = dependencyResponse.status;
    response.end(await dependencyResponse.text());
  } catch (error) {
    response.statusCode = error instanceof CircuitBreakerOpenError ? 503 : error instanceof ControllerTimeoutError ? 504 : 502;
    response.end('Dependency unavailable');
  } finally {
    requestAbort.dispose();
  }
}));

server.listen(3000, '127.0.0.1');

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dependencies.close();
  factory.close();
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
