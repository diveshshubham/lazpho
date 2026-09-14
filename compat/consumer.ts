import { createFactory, createProtectedFunction } from 'lazpho';
import type { ConcurrencyController, RunContext, RunOptions } from 'lazpho';
import { createLazphoPreset, inspectLazphoConfig } from 'lazpho/config';
import { startLazphoLoadLab } from 'lazpho/load-lab';
import type { LazphoLoadEndpoint, LazphoLoadProfile } from 'lazpho/load-lab';
import {
  discoverLazphoOpenApiEndpoints,
  startLazphoOpenApiLoadLab,
} from 'lazpho/openapi-load-lab';
import { createProtectedFetch } from 'lazpho/fetch';
import { createRequestAbortSignal } from 'lazpho/node-http';
import { createMetricsCollector, createMetricsExporter } from 'lazpho/observability';
import { createLazphoOpenTelemetry } from 'lazpho/opentelemetry';
import type { OtelMeter, OtelObservableInstrument } from 'lazpho/opentelemetry';
import { createLazphoExpress, getLazphoExpress } from 'lazpho/express';
import { lazphoFastifyPlugin } from 'lazpho/fastify';
import { LAZPHO_CONTROLLER, LazphoModule } from 'lazpho/nestjs';
import type { Request } from 'express';
import type { FastifyRequest } from 'fastify';

const factory = createFactory();
const preset = createLazphoPreset('balanced', {
  concurrency: { name: 'compat', bulkheads: { payments: { maxConcurrent: 2, maxQueue: 4 } } },
  adaptive: { name: 'compat-adaptive', maxLimit: 24 }
});
const controller: ConcurrencyController = factory.concurrency(preset.concurrency);
const adaptive = factory.adaptiveConcurrency({ ...preset.adaptive, controller });
const legacy: Promise<number> = controller.run(async () => 42);
const contextual: Promise<number> = controller.run(async ({ signal, attempt }: RunContext) => signal.aborted ? 0 : attempt, {
  retry: { attempts: 1, delayMs: 1 }, bulkhead: 'payments', timeoutMs: 100
});
const options: RunOptions = { signal: new AbortController().signal, retry: { attempts: 0 } };
const protectedFunction = createProtectedFunction(controller, async ({ signal }: RunContext, value: number) => signal.aborted ? 0 : value * 2);
const protectedFetch = createProtectedFetch({ controller, fetch: globalThis.fetch });
const collect = createMetricsCollector(controller);
const exporter = createMetricsExporter(controller, { export: (snapshot) => void snapshot.totals.completed });
const meter: OtelMeter = {
  createObservableGauge: (): OtelObservableInstrument => ({}),
  createObservableCounter: (): OtelObservableInstrument => ({}),
  addBatchObservableCallback: () => undefined,
  removeBatchObservableCallback: () => undefined
};
const telemetry = createLazphoOpenTelemetry({ controller, meter });
const expressMiddleware = createLazphoExpress({ controller });
const expressContext = (request: Request) => getLazphoExpress(request);
const fastifyContext = (request: FastifyRequest) => request.lazpho;
const nestModule = LazphoModule.register({ controller, closeControllerOnShutdown: false });
const inspection = inspectLazphoConfig(preset);
const loadEndpoint: LazphoLoadEndpoint = {
  id: 'health', method: 'GET', path: '/health', description: 'Health check', safe: true,
  setup: ({ runId }) => ({ runId }),
  request: ({ sequence }) => ({ path: `/health?sequence=${sequence}` }),
  cleanup: () => undefined
};
const loadProfile: LazphoLoadProfile = { mode: 'load', requestsPerSecond: 10_000, durationSeconds: 10 };
const discoveredEndpoints = discoverLazphoOpenApiEndpoints({
  paths: { '/health': { get: { operationId: 'health' } } }
});

void [legacy, contextual, options, protectedFunction, protectedFetch, collect, exporter, telemetry,
  expressMiddleware, expressContext, fastifyContext, lazphoFastifyPlugin, LAZPHO_CONTROLLER, nestModule, inspection, adaptive,
  startLazphoLoadLab, startLazphoOpenApiLoadLab, loadEndpoint, loadProfile, discoveredEndpoints];

// @ts-expect-error preset names are a closed public union
createLazphoPreset('unknown');
// @ts-expect-error bulkheads require both maxConcurrent and maxQueue
createLazphoPreset('balanced', { concurrency: { bulkheads: { broken: { maxConcurrent: 1 } } } });
// @ts-expect-error retry attempts must be numeric
controller.run(() => undefined, { retry: { attempts: 'one' } });
// @ts-expect-error runtime updates intentionally accept only three safety fields
adaptive.updateConfig({ increaseStep: 2 });
// @ts-expect-error Express adapter requires a controller
createLazphoExpress({});

declare const incomingRequest: Parameters<typeof createRequestAbortSignal>[0];
createRequestAbortSignal(incomingRequest);
