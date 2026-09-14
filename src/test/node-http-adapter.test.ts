import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createRequestAbortSignal, instrumentNodeHttp } from '../adapters/node-http.js';
import { createFactory } from '../index.js';
import { ControllerAbortError } from '../concurrency-errors.js';

test('request abort handle removes request, response, and socket listeners when disposed', () => {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { socket, aborted: false, complete: false, destroyed: false }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { writableFinished: false }) as unknown as ServerResponse;
  const handle = createRequestAbortSignal(request, response);
  assert.equal(request.listenerCount('aborted'), 1);
  assert.equal(request.listenerCount('close'), 1);
  assert.equal(socket.listenerCount('close'), 1);
  assert.equal(response.listenerCount('finish'), 1);
  assert.equal(response.listenerCount('close'), 1);
  handle.dispose();
  handle.dispose();
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(handle.signal.aborted, false);
});

test('request and socket failures abort once and clean every adapter listener', () => {
  for (const event of ['aborted', 'socket-close'] as const) {
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), { socket, aborted: false, complete: false, destroyed: false }) as unknown as IncomingMessage;
    const response = Object.assign(new EventEmitter(), { writableFinished: false }) as unknown as ServerResponse;
    const handle = createRequestAbortSignal(request, response);
    if (event === 'aborted') request.emit('aborted'); else socket.emit('close');
    assert.equal(handle.signal.aborted, true);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(request.listenerCount('close'), 0);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(response.listenerCount('finish'), 0);
    assert.equal(response.listenerCount('close'), 0);
  }
});

test('normal response completion disposes request cancellation listeners without aborting', () => {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { socket, aborted: false, complete: true, destroyed: false }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { writableFinished: true }) as unknown as ServerResponse;
  const handle = createRequestAbortSignal(request, response);
  response.emit('finish');
  assert.equal(handle.signal.aborted, false);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('a completed body-parsed request is not treated as disconnected when already destroyed', () => {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), {
    socket,
    aborted: false,
    complete: true,
    destroyed: true,
  }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { writableFinished: false }) as unknown as ServerResponse;
  const handle = createRequestAbortSignal(request, response);

  assert.equal(handle.signal.aborted, false);
  response.emit('finish');
  assert.equal(handle.signal.aborted, false);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('an incomplete destroyed request is still treated as disconnected', () => {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), {
    socket,
    aborted: false,
    complete: false,
    destroyed: true,
  }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { writableFinished: false }) as unknown as ServerResponse;
  const handle = createRequestAbortSignal(request, response);

  assert.equal(handle.signal.aborted, true);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('finish'), 0);
});

test('real client disconnect aborts a Lazpho operation and controller shutdown completes', async () => {
  const controller = createFactory().concurrency({ name: 'request-disconnect', limit: 1 });
  let operationStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { operationStarted = resolve; });
  let cancellationObserved: () => void = () => undefined;
  const observed = new Promise<void>((resolve) => { cancellationObserved = resolve; });
  const server = createServer(async (request, response) => {
    const requestAbort = createRequestAbortSignal(request, response);
    try {
      await controller.run(async ({ signal }) => {
        operationStarted();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }, { signal: requestAbort.signal });
    } catch (error) {
      assert.ok(error instanceof ControllerAbortError);
      cancellationObserved();
    } finally {
      requestAbort.dispose();
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = get(`http://127.0.0.1:${address.port}/disconnect`);
  client.on('error', () => undefined);
  await started;
  client.destroy();
  await observed;
  await controller.close();
  assert.equal(controller.stats().active, 0);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('instrumented handler removes its sibling response listener on completion and failure', async () => {
  const factory = createFactory();
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/test' }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
  const successful = instrumentNodeHttp(factory, async (_request, res) => { res.emit('finish'); });
  await successful(request, response);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);

  const failedResponse = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
  const failing = instrumentNodeHttp(factory, async () => { throw new Error('handler failed'); });
  await assert.rejects(Promise.resolve(failing(request, failedResponse)), /handler failed/);
  assert.equal(failedResponse.listenerCount('finish'), 0);
  assert.equal(failedResponse.listenerCount('close'), 0);
  factory.close();
});
