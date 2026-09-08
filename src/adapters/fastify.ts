import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createRequestAbortSignal } from './node-http.js';
import { createLazphoRequestContext, mapLazphoErrorToHttp } from './framework-common.js';
import type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
import type { ConcurrencyController, Factory } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    lazpho: LazphoRequestContext;
  }
  interface FastifyInstance {
    lazpho: ConcurrencyController;
  }
}

export interface LazphoFastifyOptions {
  controller: ConcurrencyController;
  bulkheadForRequest?(request: FastifyRequest): string | undefined;
  /** Enables inbound metrics using Fastify's matched route template. */
  factory?: Factory;
  routeForRequest?(request: FastifyRequest): string;
  closeControllerOnShutdown?: boolean;
}

export interface LazphoFastifyErrorHandlerOptions {
  mapError?(error: unknown, request: FastifyRequest): LazphoHttpError | undefined;
  body?(mapped: LazphoHttpError, error: unknown, request: FastifyRequest): unknown;
}

const plugin: FastifyPluginAsync<LazphoFastifyOptions> = async (fastify, options) => {
  const handles = new WeakMap<FastifyRequest, { dispose(): void; startedAt: number }>();
  fastify.decorate('lazpho', options.controller);
  fastify.decorateRequest('lazpho');
  fastify.addHook('onRequest', async (request, reply) => {
    const abort = createRequestAbortSignal(request.raw, reply.raw);
    handles.set(request, { ...abort, startedAt: performance.now() });
    request.lazpho = createLazphoRequestContext(
      options.controller,
      abort.signal,
      'fastify',
      options.bulkheadForRequest?.(request)
    );
  });
  const dispose = async (request: FastifyRequest) => { handles.get(request)?.dispose(); };
  const finish = async (request: FastifyRequest, reply: FastifyReply) => {
    const handle = handles.get(request);
    handle?.dispose();
    handles.delete(request);
    if (handle && options.factory) {
      options.factory.recordRequest({
        route: fastifyRoute(request, options.routeForRequest),
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: performance.now() - handle.startedAt
      });
    }
  };
  fastify.addHook('onResponse', finish);
  fastify.addHook('onError', dispose);
  if (options.closeControllerOnShutdown) fastify.addHook('onClose', async () => options.controller.close());
};

export const lazphoFastifyPlugin = fastifyPlugin(plugin, { name: 'lazpho' });

export function createLazphoFastifyErrorHandler(options: LazphoFastifyErrorHandlerOptions = {}) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    const mapped = options.mapError ? options.mapError(error, request) : mapLazphoErrorToHttp(error);
    if (request.raw.destroyed || reply.raw.destroyed) return;
    if (!mapped || reply.sent) { reply.send(error); return; }
    reply.status(mapped.statusCode).send(options.body?.(mapped, error, request) ?? { code: mapped.code });
  };
}

export function getLazphoFastify(instance: FastifyInstance): ConcurrencyController { return instance.lazpho; }

function fastifyRoute(request: FastifyRequest, resolver?: (request: FastifyRequest) => string): string {
  try { return resolver?.(request) ?? request.routeOptions.url ?? '__unmatched__'; }
  catch { return '__unmatched__'; }
}

export { mapLazphoErrorToHttp } from './framework-common.js';
export type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
