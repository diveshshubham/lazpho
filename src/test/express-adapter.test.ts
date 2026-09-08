import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createFactory } from '../index.js';
import { createLazphoExpress, createLazphoExpressErrorHandler, getLazphoExpress, shutdownLazphoExpress } from '../adapters/express.js';

test('Express middleware runs protected work, selects bulkheads, maps errors, and drains explicitly', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({
    name: 'express', limit: 2,
    bulkheads: { payments: { maxConcurrent: 1, maxQueue: 0 } },
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 1_000 }
  });
  const app = express();
  app.use(createLazphoExpress({
    controller,
    factory,
    routeForRequest: (request) => typeof request.route?.path === 'string' ? request.route.path : '__unmatched__',
    bulkheadForRequest: (request) => request.path === '/pay' ? 'payments' : undefined
  }));
  app.get('/pay', async (request, response, next) => {
    try { response.json({ value: await getLazphoExpress(request).run(() => 'ok') }); }
    catch (error) { next(error); }
  });
  app.get('/timeout', async (request, response, next) => {
    try {
      await getLazphoExpress(request).run(({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }), { timeoutMs: 2 });
      response.end();
    } catch (error) { next(error); }
  });
  app.get('/failure', async (request, _response, next) => {
    try { await getLazphoExpress(request).run(() => { throw new Error('dependency failed'); }); }
    catch (error) { next(error); }
  });
  app.use(createLazphoExpressErrorHandler());
  const taskErrorHandler: ErrorRequestHandler = (_error, _request, response, _next) => { response.status(500).json({ code: 'TASK_ERROR' }); };
  app.use(taskErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const success = await fetch(`${origin}/pay`);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { value: 'ok' });

  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const active = controller.run(() => new Promise<void>((resolve) => { release = resolve; started(); }), { bulkhead: 'payments' });
  await admitted;
  const saturated = await fetch(`${origin}/pay`);
  assert.equal(saturated.status, 503);
  assert.deepEqual(await saturated.json(), { code: 'FACTORY_BULKHEAD_QUEUE_FULL' });
  release();
  await active;

  const timedOut = await fetch(`${origin}/timeout`);
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { code: 'FACTORY_CONTROLLER_TIMEOUT' });

  assert.equal((await fetch(`${origin}/failure`)).status, 500);
  const breakerOpen = await fetch(`${origin}/pay`);
  assert.equal(breakerOpen.status, 503);
  assert.deepEqual(await breakerOpen.json(), { code: 'FACTORY_CIRCUIT_BREAKER_OPEN' });
  assert.equal(factory.getMetrics().routes['/pay']?.totalRequests, 3);
  assert.equal(factory.getMetrics().routes['/timeout']?.errors, 1);
  assert.equal(factory.getMetrics().routes['/failure']?.errors, 1);

  await shutdownLazphoExpress(server, controller);
  assert.equal(controller.lifecycle(), 'closed');
  factory.close();
});

test('Express client disconnect reaches the operation signal without releasing its slot early', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'express-disconnect', limit: 1 });
  const app = express();
  app.use(createLazphoExpress({ controller }));
  let started: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  let settled: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  app.get('/disconnect', async (request, response) => {
    started();
    try {
      await getLazphoExpress(request).run(({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => setImmediate(() => reject(signal.reason)), { once: true });
      }));
    } catch { settled(); }
    if (!response.destroyed) response.end();
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = httpRequest({ host: '127.0.0.1', port: address.port, path: '/disconnect' });
  client.on('error', () => undefined);
  client.end();
  await admitted;
  client.destroy();
  assert.equal(controller.stats().active, 1);
  await finished;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.stats().active, 0);
  assert.equal(controller.stats().cancelled, 1);
  await shutdownLazphoExpress(server, controller);
  factory.close();
});
