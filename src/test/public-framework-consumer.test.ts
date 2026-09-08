import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, RequestHandler } from 'express';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DynamicModule, NestInterceptor, Provider } from '@nestjs/common';
import { createFactory } from '../index.js';
import type { RunOptions } from '../types.js';
import { createLazphoExpress, getLazphoExpress, mapLazphoErrorToHttp as mapExpressError } from '../adapters/express.js';
import { lazphoFastifyPlugin } from '../adapters/fastify.js';
import { createLazphoNestInterceptor, LAZPHO_CONTROLLER, LazphoModule } from '../adapters/nestjs.js';

test('public framework adapter APIs provide ergonomic TypeScript surfaces', () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'framework-consumer', limit: 2, bulkheads: { payments: { maxConcurrent: 1, maxQueue: 1 } } });
  const expressMiddleware: RequestHandler = createLazphoExpress({
    controller,
    bulkheadForRequest: (_request: Request) => 'payments'
  });
  const expressRun = (request: Request, options?: RunOptions) => getLazphoExpress(request).run(() => 'ok', options);
  const fastifyPlugin = lazphoFastifyPlugin;
  const fastifyTypes = (instance: FastifyInstance, request: FastifyRequest) => [instance.lazpho, request.lazpho.controller] as const;
  const nestModule: DynamicModule = LazphoModule.register({ controller, closeControllerOnShutdown: false });
  const nestInterceptor: NestInterceptor = createLazphoNestInterceptor({ controller });
  const controllerProvider: Provider = { provide: LAZPHO_CONTROLLER, useValue: controller };

  assert.equal(typeof expressMiddleware, 'function');
  assert.equal(typeof expressRun, 'function');
  assert.equal(typeof fastifyPlugin, 'function');
  assert.equal(typeof fastifyTypes, 'function');
  assert.equal(nestModule.module, LazphoModule);
  assert.equal(typeof nestInterceptor.intercept, 'function');
  assert.equal(controllerProvider.provide, LAZPHO_CONTROLLER);
  assert.equal(mapExpressError(new Error('ordinary')), undefined);
  factory.close();
});
