import type { Server } from 'node:http';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { createRequestAbortSignal } from './node-http.js';
import { createLazphoRequestContext, mapLazphoErrorToHttp } from './framework-common.js';
import type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
import type { ConcurrencyController, Factory } from '../types.js';

const requestContext = Symbol('lazpho.express.request-context');

export interface LazphoExpressOptions {
  controller: ConcurrencyController;
  bulkheadForRequest?(request: Request): string | undefined;
  /** Enables inbound metrics for every request using a stable route template resolved at completion. */
  factory?: Factory;
  routeForRequest?(request: Request): string;
}

export interface LazphoExpressErrorHandlerOptions {
  mapError?(error: unknown, request: Request): LazphoHttpError | undefined;
  body?(mapped: LazphoHttpError, error: unknown, request: Request): unknown;
}

export function createLazphoExpress(options: LazphoExpressOptions): RequestHandler {
  return (request, response, next): void => {
    let bulkhead: string | undefined;
    try { bulkhead = options.bulkheadForRequest?.(request); }
    catch (error) { next(error); return; }
    const abort = createRequestAbortSignal(request, response);
    const startedAt = performance.now();
    const mutable = request as Request & { [requestContext]?: LazphoRequestContext };
    mutable[requestContext] = createLazphoRequestContext(options.controller, abort.signal, 'express', bulkhead);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      abort.dispose();
      delete mutable[requestContext];
      response.removeListener('finish', cleanup);
      response.removeListener('close', cleanup);
      if (options.factory) {
        options.factory.recordRequest({
          route: expressRoute(request, options.routeForRequest),
          method: request.method || 'UNKNOWN',
          statusCode: response.writableFinished ? response.statusCode : 499,
          durationMs: performance.now() - startedAt
        });
      }
    };
    response.once('finish', cleanup);
    response.once('close', cleanup);
    next();
  };
}

function expressRoute(request: Request, resolver?: (request: Request) => string): string {
  try {
    if (resolver) return resolver(request);
    const route = request.route as { path?: unknown } | undefined;
    return typeof route?.path === 'string' ? route.path : '__unmatched__';
  } catch { return '__unmatched__'; }
}

export function getLazphoExpress(request: Request): LazphoRequestContext {
  const context = (request as Request & { [requestContext]?: LazphoRequestContext })[requestContext];
  if (!context) throw new Error('Lazpho Express middleware is not active for this request.');
  return context;
}

export function createLazphoExpressErrorHandler(options: LazphoExpressErrorHandlerOptions = {}): ErrorRequestHandler {
  return (error, request, response, next): void => {
    const mapped = options.mapError ? options.mapError(error, request) : mapLazphoErrorToHttp(error);
    if (request.destroyed || response.destroyed) return;
    if (!mapped || response.headersSent) { next(error); return; }
    response.status(mapped.statusCode).json(options.body?.(mapped, error, request) ?? { code: mapped.code });
  };
}

export async function shutdownLazphoExpress(server: Server, controller: ConcurrencyController): Promise<void> {
  const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await controller.close();
  await stopped;
}

export { mapLazphoErrorToHttp } from './framework-common.js';
export type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
