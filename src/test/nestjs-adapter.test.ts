import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { createFactory } from '../index.js';
import type { ConcurrencyController } from '../types.js';
import { createLazphoNestInterceptor, getLazphoNest, LAZPHO_CONTROLLER, LazphoModule } from '../adapters/nestjs.js';

test('NestJS module provides the exact controller and makes shutdown ownership explicit', async () => {
  const externalFactory = createFactory();
  const external = externalFactory.concurrency({ name: 'nest-external', limit: 1 });
  const externalModule = await Test.createTestingModule({ imports: [LazphoModule.register({ controller: external })] }).compile();
  assert.equal(externalModule.get<ConcurrencyController>(LAZPHO_CONTROLLER), external);
  await externalModule.close();
  assert.equal(external.lifecycle(), 'running');
  await external.close();
  externalFactory.close();

  const ownedFactory = createFactory();
  const owned = ownedFactory.concurrency({ name: 'nest-owned', limit: 1 });
  const ownedModule = await Test.createTestingModule({ imports: [LazphoModule.forRoot({ controller: owned, closeControllerOnShutdown: true })] }).compile();
  await ownedModule.close();
  assert.equal(owned.lifecycle(), 'closed');
  ownedFactory.close();
});

test('NestJS interceptor exposes a request helper and removes every Node listener on completion', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'nest-interceptor', limit: 1 });
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { socket, aborted: false, destroyed: false, complete: true });
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false, statusCode: 200 });
  const executionContext = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined
    })
  } as unknown as ExecutionContext;
  const interceptor = createLazphoNestInterceptor({
    controller,
    factory,
    routeForRequest: () => '/users/:id',
    bulkheadForRequest: () => undefined
  });
  const stream = await interceptor.intercept(executionContext, { handle: () => of('ok') } as CallHandler);
  assert.equal(getLazphoNest(request).controller, controller);
  assert.equal(getLazphoNest(request).framework, 'nestjs');
  await new Promise<void>((resolve, reject) => stream.subscribe({ complete: resolve, error: reject }));
  assert.throws(() => getLazphoNest(request));
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(factory.getMetrics().routes['/users/:id']?.totalRequests, 1);
  await controller.close();
  factory.close();
});
