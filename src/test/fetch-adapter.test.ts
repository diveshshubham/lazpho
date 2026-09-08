import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createProtectedFetch } from '../adapters/fetch.js';
import { createFactory } from '../index.js';
import { BulkheadQueueFullError, CircuitBreakerOpenError, ControllerAbortError, ControllerLifecycleError, ControllerTimeoutError } from '../concurrency-errors.js';

interface LocalServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function localServer(handler: RequestListener): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test('protected fetch preserves native response and non-2xx behavior', async () => {
  const server = await localServer((_request, response) => {
    response.statusCode = 503;
    response.end('unavailable');
  });
  try {
    const controller = createFactory().concurrency({ name: 'fetch-response', limit: 1 });
    const protectedFetch = createProtectedFetch({ controller });
    const response: Response = await protectedFetch(`${server.baseUrl}/status`, { method: 'GET' });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'unavailable');
    assert.equal(controller.stats().failed, 0);
  } finally {
    await server.close();
  }
});

test('protected fetch forwards Lazpho timeout and caller cancellation to the network request', async () => {
  const server = await localServer((_request, response) => {
    setTimeout(() => { if (!response.destroyed) response.end('late'); }, 30);
  });
  try {
    const controller = createFactory().concurrency({ name: 'fetch-abort', limit: 2 });
    const protectedFetch = createProtectedFetch({ controller });
    await assert.rejects(protectedFetch(`${server.baseUrl}/timeout`, { timeoutMs: 3 }), ControllerTimeoutError);
    const abort = new AbortController();
    const cancelled = protectedFetch(`${server.baseUrl}/cancel`, { signal: abort.signal });
    abort.abort();
    await assert.rejects(cancelled, ControllerAbortError);
    await controller.close();
    assert.equal(controller.stats().active, 0);
  } finally {
    await server.close();
  }
});

test('caller cancellation after fetch starts aborts the exact signal seen by the fetch implementation', async () => {
  const controller = createFactory().concurrency({ name: 'fetch-signal-composition', limit: 1 });
  let started: () => void = () => undefined;
  const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
  let receivedSignal: AbortSignal | null | undefined;
  const protectedFetch = createProtectedFetch({
    controller,
    fetch: async (_input, init) => {
      receivedSignal = init?.signal;
      started();
      return new Promise<Response>((_resolve, reject) => receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true }));
    }
  });
  const abort = new AbortController();
  const request = protectedFetch('http://local.invalid', { signal: abort.signal });
  await fetchStarted;
  abort.abort();
  await assert.rejects(request, ControllerAbortError);
  assert.equal(receivedSignal?.aborted, true);
  await controller.close();
});

test('protected fetch uses configured bulkheads without adding another queue', async () => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = await localServer(async (_request, response) => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    response.end('ok');
  });
  try {
    const controller = createFactory().concurrency({ name: 'fetch-bulkhead', limit: 2, bulkheads: { payments: { maxConcurrent: 1, maxQueue: 0 } } });
    const protectedFetch = createProtectedFetch({ controller, defaults: { bulkhead: 'payments' } });
    const first = protectedFetch(`${server.baseUrl}/first`);
    await requestStarted;
    await assert.rejects(protectedFetch(`${server.baseUrl}/second`), BulkheadQueueFullError);
    release();
    assert.equal((await first).status, 200);
    assert.equal(controller.stats().completed, 1);
  } finally {
    release();
    await server.close();
  }
});

test('fetch retries remain controller-owned and retry thrown network errors only', async () => {
  let requests = 0;
  const server = await localServer((_request, response) => {
    requests += 1;
    if (requests === 1) response.socket?.destroy();
    else response.end('recovered');
  });
  try {
    const controller = createFactory().concurrency({ name: 'fetch-retry', limit: 1 });
    const protectedFetch = createProtectedFetch({ controller });
    const response = await protectedFetch(`${server.baseUrl}/flaky`, { retry: { attempts: 1 } });
    assert.equal(await response.text(), 'recovered');
    assert.equal(requests, 2);
    assert.equal(controller.stats().retriesAttempted, 1);
  } finally {
    await server.close();
  }
});

test('protected fetch exposes breaker and controller lifecycle errors unchanged', async () => {
  let calls = 0;
  const controller = createFactory().concurrency({
    name: 'fetch-breaker', limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 100 }
  });
  const protectedFetch = createProtectedFetch({
    controller,
    fetch: async () => { calls += 1; throw new Error('network down'); }
  });
  await assert.rejects(protectedFetch('http://local.invalid'), /network down/);
  await assert.rejects(protectedFetch('http://local.invalid'), CircuitBreakerOpenError);
  assert.equal(calls, 1);
  await controller.close();
  await assert.rejects(protectedFetch('http://local.invalid'), ControllerLifecycleError);
  assert.equal(calls, 1);
});
