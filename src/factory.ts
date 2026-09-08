import { MetricAggregator } from './metric-aggregator.js';
import { ResourceMonitor } from './resource-monitor.js';
import { FixedConcurrencyController } from './concurrency-controller.js';
import { ControllerLimitError, DuplicateControllerNameError } from './concurrency-errors.js';
import { ClosedLoopController } from './closed-loop-controller.js';
import { validateControllerName } from './configuration-validation.js';
import type { AdaptiveControlMetrics, AdaptiveConcurrencyController, AdaptiveConcurrencyOptions, AdaptiveControllerState, ClosedLoopAdaptiveConcurrencyController, ConcurrencyController, ConcurrencyMetrics, ConcurrencyOptions, Factory, FactoryOptions, MetricsSnapshot, RequestMetrics, RequestRecord, RequestTimer } from './types.js';

const OTHER_ROUTE = '__other__';

const defaults: Required<Omit<FactoryOptions, 'routeResolver' | 'isError'>> = {
  enabled: true,
  maxRoutes: 100,
  latencySampleSize: 1_024,
  rpsWindowSeconds: 10,
  eventLoopResolutionMs: 20,
  maxControllers: 100,
  maxAdaptiveControllers: 100
};

export function createFactory(options: FactoryOptions = {}): Factory {
  const config = {
    ...defaults,
    ...options,
    maxRoutes: positiveInteger(options.maxRoutes, defaults.maxRoutes),
    latencySampleSize: positiveInteger(options.latencySampleSize, defaults.latencySampleSize),
    rpsWindowSeconds: positiveInteger(options.rpsWindowSeconds, defaults.rpsWindowSeconds),
    eventLoopResolutionMs: positiveInteger(options.eventLoopResolutionMs, defaults.eventLoopResolutionMs),
    maxControllers: positiveInteger(options.maxControllers, defaults.maxControllers),
    maxAdaptiveControllers: positiveInteger(options.maxAdaptiveControllers, defaults.maxAdaptiveControllers)
  };
  const global = new MetricAggregator(config.latencySampleSize, config.rpsWindowSeconds);
  const routes = new Map<string, MetricAggregator>();
  const resources = new ResourceMonitor(config.eventLoopResolutionMs);
  const controllers = new Map<string, FixedConcurrencyController>();
  const adaptiveControllers = new Map<string, ClosedLoopController>();
  let generatedControllerCount = 0;
  let generatedAdaptiveControllerCount = 0;
  const enabled = config.enabled;

  const routeKey = (route: string): string => {
    let resolved = route;
    try { resolved = config.routeResolver?.(route) ?? route; } catch { resolved = OTHER_ROUTE; }
    if (!resolved || resolved.length > 512) resolved = OTHER_ROUTE;
    if (routes.has(resolved) || routes.size < config.maxRoutes || resolved === OTHER_ROUTE) return resolved;
    return OTHER_ROUTE;
  };

  const routeAggregator = (route: string): MetricAggregator => {
    const key = routeKey(route);
    let aggregator = routes.get(key);
    if (!aggregator) {
      aggregator = new MetricAggregator(config.latencySampleSize, config.rpsWindowSeconds);
      routes.set(key, aggregator);
    }
    return aggregator;
  };

  const isError = (statusCode: number): boolean => {
    try { return config.isError?.(statusCode) ?? statusCode >= 500; } catch { return statusCode >= 500; }
  };

  const safely = (operation: () => void): void => {
    if (!enabled) return;
    try { operation(); } catch { }
  };

  return {
    recordRequest(record: RequestRecord): void {
      safely(() => {
        const durationMs = Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : 0;
        const error = isError(record.statusCode);
        global.record(durationMs, error);
        routeAggregator(record.route).record(durationMs, error);
      });
    },

    startRequest(route: string, _method: string): RequestTimer {
      if (!enabled) return { finish: () => undefined };
      const start = performance.now();
      let routeMetrics: MetricAggregator | undefined;
      safely(() => {
        global.start();
        routeMetrics = routeAggregator(route);
        routeMetrics.start();
      });
      let finished = false;
      return {
        finish(statusCode: number): void {
          if (finished) return;
          finished = true;
          safely(() => {
            const durationMs = performance.now() - start;
            const error = isError(statusCode);
            global.record(durationMs, error);
            global.finish();
            routeMetrics?.record(durationMs, error);
            routeMetrics?.finish();
          });
        }
      };
    },

    getMetrics(): MetricsSnapshot {
      const snapshot = global.snapshot();
      const routeMetrics: Record<string, RequestMetrics> = {};
      for (const [route, metrics] of routes) routeMetrics[route] = metrics.snapshot();
      const controllerMetrics: Record<string, ConcurrencyMetrics> = {};
      for (const [name, controller] of controllers) controllerMetrics[name] = controller.stats();
      const adaptiveMetrics: Record<string, AdaptiveControlMetrics> = {};
      for (const [name, controller] of adaptiveControllers) adaptiveMetrics[name] = controller.stats();
      return { ...snapshot, resources: resources.snapshot(), routes: routeMetrics, controllers: controllerMetrics, adaptiveControllers: adaptiveMetrics };
    },

    getRouteMetrics(route: string): RequestMetrics | undefined {
      return routes.get(routeKey(route))?.snapshot();
    },

    concurrency(options: ConcurrencyOptions): ConcurrencyController {
      const name = controllerName(options.name, ++generatedControllerCount);
      if (controllers.has(name)) throw new DuplicateControllerNameError(name);
      if (controllers.size >= config.maxControllers) throw new ControllerLimitError(config.maxControllers);
      const controller = new FixedConcurrencyController(name, options);
      controllers.set(name, controller);
      return controller;
    },

    getConcurrencyMetrics(name: string): ConcurrencyMetrics | undefined {
      return controllers.get(name)?.stats();
    },

    adaptiveConcurrency(options: AdaptiveConcurrencyOptions): ClosedLoopAdaptiveConcurrencyController {
      const name = controllerName(options.name, ++generatedAdaptiveControllerCount);
      if (adaptiveControllers.has(name)) throw new DuplicateControllerNameError(name);
      if (adaptiveControllers.size >= config.maxAdaptiveControllers) throw new ControllerLimitError(config.maxAdaptiveControllers);
      const controller = new ClosedLoopController(name, options);
      adaptiveControllers.set(name, controller);
      return controller;
    },

    getAdaptiveConcurrencyState(name: string): AdaptiveControllerState | undefined {
      return adaptiveControllers.get(name)?.state();
    },

    reset(): void {
      global.reset();
      routes.clear();
    },

    close(): void {
      resources.close();
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function controllerName(value: string | undefined, generatedCount: number): string {
  const name = value ?? `controller-${generatedCount}`;
  validateControllerName(name);
  return name;
}
