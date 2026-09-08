import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { createMetricsCollector, createMetricsExporter } from '../observability.js';
import type { LazphoMetricSnapshot, MetricsExporter } from '../observability.js';
import { createLazphoOpenTelemetry } from '../adapters/opentelemetry.js';
import type { LazphoOpenTelemetryInstrumentation, OtelBatchObservableCallback, OtelMeter, OtelObservableInstrument } from '../adapters/opentelemetry.js';

class ConsumerMeter implements OtelMeter {
  private callback?: OtelBatchObservableCallback;
  public createObservableGauge(): OtelObservableInstrument { return {}; }
  public createObservableCounter(): OtelObservableInstrument { return {}; }
  public addBatchObservableCallback(callback: OtelBatchObservableCallback): void { this.callback = callback; }
  public removeBatchObservableCallback(callback: OtelBatchObservableCallback): void {
    if (this.callback === callback) this.callback = undefined;
  }
}

test('public observability types and factories are usable by a TypeScript consumer', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'public-observability', limit: 1 });
  await controller.run(() => undefined);

  const snapshot: LazphoMetricSnapshot = createMetricsCollector(controller)();
  const exporter: MetricsExporter = createMetricsExporter(controller, { export: (_value: LazphoMetricSnapshot) => undefined });
  const telemetry: LazphoOpenTelemetryInstrumentation = createLazphoOpenTelemetry({ controller, meter: new ConsumerMeter() });

  assert.equal(snapshot.controller, 'public-observability');
  assert.equal(exporter.export(), true);
  assert.equal(telemetry.collect().totals.completed, 1);

  telemetry.dispose();
  exporter.dispose();
  await controller.close();
  factory.close();
});
