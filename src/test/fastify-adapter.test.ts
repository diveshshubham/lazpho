import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import Fastify from 'fastify';
import { createFactory } from '../index.js';
import { createLazphoFastifyErrorHandler, getLazphoFastify, lazphoFastifyPlugin } from '../adapters/fastify.js';

test('Fastify plugin decorates app and requests, selects bulkheads, maps errors, and respects external ownership', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({
    name: 'fastify', limit: 2,
    bulkheads: { payments: { maxConcurrent: 1, maxQueue: 0 } }
  });
  const app = Fastify();
  await app.register(lazphoFastifyPlugin, {
    controller,
    factory,
    bulkheadForRequest: (request) => request.url === '/pay' ? 'payments' : undefined
  });
  app.setErrorHandler(createLazphoFastifyErrorHandler());
  app.get('/pay', async (request) => ({ value: await request.lazpho.run(() => 'ok') }));
  app.get('/timeout', async (request) => {
    await request.lazpho.run(({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { timeoutMs: 2 });
  });
  await app.ready();
  assert.equal(getLazphoFastify(app), controller);
  const success = await app.inject({ method: 'GET', url: '/pay' });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), { value: 'ok' });

  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const active = controller.run(() => new Promise<void>((resolve) => { release = resolve; started(); }), { bulkhead: 'payments' });
  await admitted;
  const saturated = await app.inject({ method: 'GET', url: '/pay' });
  assert.equal(saturated.statusCode, 503);
  assert.deepEqual(saturated.json(), { code: 'FACTORY_BULKHEAD_QUEUE_FULL' });
  release();
  await active;
  const timedOut = await app.inject({ method: 'GET', url: '/timeout' });
  assert.equal(timedOut.statusCode, 504);
  assert.deepEqual(timedOut.json(), { code: 'FACTORY_CONTROLLER_TIMEOUT' });
  assert.equal(factory.getMetrics().routes['/pay']?.totalRequests, 2);
  assert.equal(factory.getMetrics().routes['/timeout']?.errors, 1);

  await app.close();
  assert.equal(controller.lifecycle(), 'running');
  await controller.close();
  factory.close();
});

test('Fastify client disconnect is cleaned up and owned controller closes with the app', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'fastify-owned', limit: 1 });
  const app = Fastify();
  await app.register(lazphoFastifyPlugin, { controller, closeControllerOnShutdown: true });
  let started: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  let settled: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  app.get('/disconnect', async (request, reply) => {
    started();
    try {
      await request.lazpho.run(({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => setImmediate(() => reject(signal.reason)), { once: true });
      }));
    } catch { settled(); }
    if (!reply.raw.destroyed) return { ok: true };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
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
  await app.close();
  assert.equal(controller.lifecycle(), 'closed');
  factory.close();
});

test('Fastify adapter lifecycle soak leaves every shared controller drained and closed', async () => {
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const factory = createFactory();
    const controller = factory.concurrency({ name: `fastify-soak-${cycle}`, limit: 2 });
    const app = Fastify();
    await app.register(lazphoFastifyPlugin, { controller, closeControllerOnShutdown: true });
    app.get('/work', async (request) => request.lazpho.run(() => cycle));
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/work' })));
    assert.ok(responses.every((response) => response.statusCode === 200));
    await app.close();
    assert.equal(controller.lifecycle(), 'closed');
    assert.equal(controller.stats().active, 0);
    assert.equal(controller.stats().queued, 0);
    factory.close();
  }
});
