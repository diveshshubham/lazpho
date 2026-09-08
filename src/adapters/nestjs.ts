import { Module } from '@nestjs/common';
import type { CallHandler, DynamicModule, ExecutionContext, NestInterceptor, Provider } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import { createRequestAbortSignal } from './node-http.js';
import { createLazphoRequestContext, mapLazphoErrorToHttp } from './framework-common.js';
import type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
import type { ConcurrencyController, Factory } from '../types.js';

export const LAZPHO_CONTROLLER = Symbol('LAZPHO_CONTROLLER');
const LAZPHO_LIFECYCLE = Symbol('LAZPHO_LIFECYCLE');
const requestContext = Symbol('lazpho.nestjs.request-context');

export interface LazphoModuleOptions {
  controller: ConcurrencyController;
  closeControllerOnShutdown?: boolean;
}

export interface LazphoNestInterceptorOptions {
  controller: ConcurrencyController;
  bulkheadForRequest?(request: unknown): string | undefined;
  /** Enables inbound metrics when routeForRequest returns a stable framework route template. */
  factory?: Factory;
  routeForRequest?(request: unknown): string;
}

export type LazphoControllerProvider = Provider<ConcurrencyController>;

export class LazphoModule {
  public static register(options: LazphoModuleOptions): DynamicModule {
    return {
      module: LazphoModule,
      providers: [
        { provide: LAZPHO_CONTROLLER, useValue: options.controller },
        {
          provide: LAZPHO_LIFECYCLE,
          useFactory: () => ({
            onApplicationShutdown: async () => {
              if (options.closeControllerOnShutdown) await options.controller.close();
            }
          })
        }
      ],
      exports: [LAZPHO_CONTROLLER]
    };
  }

  public static forRoot(options: LazphoModuleOptions): DynamicModule { return LazphoModule.register(options); }
}
Module({})(LazphoModule);

export function createLazphoNestInterceptor(options: LazphoNestInterceptorOptions): NestInterceptor {
  return {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const http = context.switchToHttp();
      const frameworkRequest = http.getRequest<Record<PropertyKey, unknown>>();
      const frameworkResponse = http.getResponse<Record<PropertyKey, unknown>>();
      const request = (frameworkRequest.raw ?? frameworkRequest) as Parameters<typeof createRequestAbortSignal>[0];
      const response = (frameworkResponse.raw ?? frameworkResponse) as Parameters<typeof createRequestAbortSignal>[1];
      const abort = createRequestAbortSignal(request, response);
      const startedAt = performance.now();
      frameworkRequest[requestContext] = createLazphoRequestContext(
        options.controller,
        abort.signal,
        'nestjs',
        options.bulkheadForRequest?.(frameworkRequest)
      );
      return next.handle().pipe(finalize(() => {
        abort.dispose();
        delete frameworkRequest[requestContext];
        if (options.factory) {
          options.factory.recordRequest({
            route: nestRoute(frameworkRequest, options.routeForRequest),
            method: typeof frameworkRequest.method === 'string' ? frameworkRequest.method : 'UNKNOWN',
            statusCode: typeof frameworkResponse.statusCode === 'number' ? frameworkResponse.statusCode : 200,
            durationMs: performance.now() - startedAt
          });
        }
      }));
    }
  };
}

function nestRoute(request: unknown, resolver?: (request: unknown) => string): string {
  try { return resolver?.(request) ?? '__unmatched__'; }
  catch { return '__unmatched__'; }
}

export function getLazphoNest(request: object): LazphoRequestContext {
  const context = (request as Record<PropertyKey, unknown>)[requestContext] as LazphoRequestContext | undefined;
  if (!context) throw new Error('Lazpho NestJS interceptor is not active for this request.');
  return context;
}

export { mapLazphoErrorToHttp } from './framework-common.js';
export type { LazphoHttpError, LazphoRequestContext } from './framework-common.js';
