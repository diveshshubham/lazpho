import { createFactory } from '../index.js';
import { createLazphoPreset, inspectLazphoConfig } from '../config.js';
import { createProtectedFetch } from '../adapters/fetch.js';
import { createMetricsExporter, type LazphoMetricSnapshot } from '../observability.js';

/** Repository-only example: compose bounds first, then hand ownership to the application lifecycle. */
export function createPaymentDependency(exportSnapshot: (snapshot: LazphoMetricSnapshot) => void) {
  const config = createLazphoPreset('balanced', {
    concurrency: {
      name: 'payments-api',
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10_000, halfOpenMaxAttempts: 1 },
      bulkheads: { payments: { maxConcurrent: 5, maxQueue: 20 } }
    },
    adaptive: { targetP95Ms: 150, maxLimit: 32 }
  });
  const inspection = inspectLazphoConfig(config);
  const factory = createFactory();
  const controller = factory.concurrency(config.concurrency);
  const adaptive = factory.adaptiveConcurrency({ ...config.adaptive, controller });
  // Evaluation is deliberately application-owned; creating an adaptive controller
  // does not install a background timer.
  const evaluationTimer = setInterval(() => adaptive.evaluateFromMetrics(), config.adaptive.evaluationIntervalMs);
  evaluationTimer.unref();
  const protectedFetch = createProtectedFetch({
    controller,
    defaults: { bulkhead: 'payments', timeoutMs: 1_000, retry: { attempts: 1, delayMs: 25 } }
  });
  const metrics = createMetricsExporter(controller, { adaptive, export: exportSnapshot });

  return {
    inspection,
    exportMetrics: () => metrics.export(),
    async getPayment(id: string, signal?: AbortSignal): Promise<unknown> {
      const response = await protectedFetch(`https://payments.example.invalid/payments/${encodeURIComponent(id)}`, { signal });
      // Fetch preserves native semantics: the application decides which HTTP responses are failures.
      if (!response.ok) throw new Error(`Payment dependency returned HTTP ${response.status}`);
      return response.json();
    },
    async close(): Promise<void> {
      clearInterval(evaluationTimer);
      metrics.dispose();
      await adaptive.close();
      factory.close();
    }
  };
}
