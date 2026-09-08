import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { createMetricsCollector, createMetricsExporter } from '../observability.js';
import { LAZPHO_OTEL_METRIC_NAMES, breakerValue, createLazphoOpenTelemetry, lifecycleValue } from '../adapters/opentelemetry.js';
import type { OtelAttributes, OtelBatchObservableCallback, OtelBatchObservableResult, OtelMeter, OtelObservableInstrument } from '../adapters/opentelemetry.js';

interface FakeInstrument extends OtelObservableInstrument { name: string; kind: 'gauge' | 'counter' }
interface Measurement { name: string; kind: 'gauge' | 'counter'; value: number; attributes?: OtelAttributes }

class FakeMeter implements OtelMeter {
  public readonly instruments: FakeInstrument[] = [];
  private registrations: Array<{ callback: OtelBatchObservableCallback; instruments: OtelObservableInstrument[] }> = [];
  public createObservableGauge(name: string): FakeInstrument { return this.instrument(name, 'gauge'); }
  public createObservableCounter(name: string): FakeInstrument { return this.instrument(name, 'counter'); }
  public addBatchObservableCallback(callback: OtelBatchObservableCallback, instruments: OtelObservableInstrument[]): void {
    this.registrations.push({ callback, instruments });
  }
  public removeBatchObservableCallback(callback: OtelBatchObservableCallback, instruments: OtelObservableInstrument[]): void {
    this.registrations = this.registrations.filter((registration) => registration.callback !== callback || registration.instruments !== instruments);
  }
  public collect(): Measurement[] {
    const measurements: Measurement[] = [];
    const result: OtelBatchObservableResult = {
      observe(instrument, value, attributes) {
        const fake = instrument as FakeInstrument;
        measurements.push({ name: fake.name, kind: fake.kind, value, attributes });
      }
    };
    for (const registration of this.registrations) registration.callback(result);
    return measurements;
  }
  public callbacks(): number { return this.registrations.length; }
  private instrument(name: string, kind: 'gauge' | 'counter'): FakeInstrument {
    const instrument = { name, kind };
    this.instruments.push(instrument);
    return instrument;
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test('generic metric export is complete, detached, and deeply immutable', async () => {
  const controller = createFactory().concurrency({
    name: 'metrics-export', limit: 2, bulkheads: { A: { maxConcurrent: 1, maxQueue: 0 } },
    circuitBreaker: { failureThreshold: 10, resetTimeoutMs: 50 }
  });
  await controller.run(() => undefined, { bulkhead: 'A' });
  let retryAttempt = 0;
  await controller.run(() => { retryAttempt += 1; if (retryAttempt === 1) throw new Error('retry'); }, { bulkhead: 'A', retry: { attempts: 1 } });
  await assert.rejects(controller.run(() => { throw new Error('persistent'); }, { bulkhead: 'A', retry: { attempts: 1 } }));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(controller.run(() => undefined, { signal: abort.signal }));
  await assert.rejects(controller.run(async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 2 }));
  const active = controller.run(() => delay(10), { bulkhead: 'A' });
  await assert.rejects(controller.run(() => undefined, { bulkhead: 'A' }));
  await active;

  const collect = createMetricsCollector(controller);
  const snapshot = collect();
  assert.equal(snapshot.controller, 'metrics-export');
  assert.equal(snapshot.lifecycle, 'running');
  assert.equal(snapshot.totals.completed, controller.stats().completed);
  assert.equal(snapshot.totals.cancelled, 1);
  assert.equal(snapshot.totals.timedOut, 1);
  assert.equal(snapshot.totals.retriesAttempted, 2);
  assert.equal(snapshot.totals.retrySuccesses, 1);
  assert.equal(snapshot.totals.retryExhausted, 1);
  assert.equal(snapshot.totals.bulkheadRejected, 1);
  assert.equal(snapshot.bulkheads.A.maxConcurrent, 1);
  assert.equal(snapshot.breaker?.state, 'closed');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.concurrency));
  assert.ok(Object.isFrozen(snapshot.totals));
  assert.ok(Object.isFrozen(snapshot.latency.execution));
  assert.ok(Object.isFrozen(snapshot.bulkheads));
  assert.ok(Object.isFrozen(snapshot.bulkheads.A));
  assert.throws(() => { (snapshot.bulkheads.A as { active: number }).active = 99; }, TypeError);
  assert.equal(collect().bulkheads.A.active, 0);
});

test('manual exporter isolates export and error-handler failures and releases callbacks on dispose', async () => {
  const controller = createFactory().concurrency({ name: 'metrics-exporter', limit: 1 });
  let calls = 0;
  const exporter = createMetricsExporter(controller, {
    export: () => { calls += 1; throw new Error('export failed'); },
    onError: () => { throw new Error('error handler failed'); }
  });
  assert.equal(exporter.export(), false);
  assert.equal(await controller.run(() => 'ok'), 'ok');
  assert.equal(exporter.export(), false);
  exporter.dispose();
  exporter.dispose();
  assert.equal(exporter.export(), false);
  assert.equal(calls, 2);
  await controller.close();
});

test('collector reflects running, draining, and closed lifecycle without delaying shutdown', async () => {
  const controller = createFactory().concurrency({ name: 'metrics-lifecycle', limit: 1 });
  let release: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const active = controller.run(() => new Promise<void>((resolve) => { release = resolve; markStarted(); }));
  const collect = createMetricsCollector(controller);
  await started;
  assert.equal(collect().lifecycle, 'running');
  const closing = controller.close();
  assert.equal(collect().lifecycle, 'draining');
  release();
  await Promise.all([active, closing]);
  assert.equal(collect().lifecycle, 'closed');
});

test('collector tracks breaker open, half-open recovery, and monotonic counters', async () => {
  const controller = createFactory().concurrency({ name: 'metrics-breaker', limit: 1, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 2 } });
  const collect = createMetricsCollector(controller);
  await assert.rejects(controller.run(() => { throw new Error('down'); }));
  assert.equal(collect().breaker?.state, 'open');
  assert.equal(collect().breaker?.breakerTrips, 1);
  await assert.rejects(controller.run(() => undefined));
  await delay(3);
  await controller.run(() => undefined);
  const recovered = collect().breaker;
  assert.equal(recovered?.state, 'closed');
  assert.equal(recovered?.halfOpenAttempts, 1);
  assert.equal(recovered?.breakerRecoveries, 1);
  const meter = new FakeMeter();
  const instrumentation = createLazphoOpenTelemetry({ controller, meter });
  const measurements = meter.collect();
  assert.equal(measurements.find(({ name }) => name === LAZPHO_OTEL_METRIC_NAMES.breakerTrips)?.value, 1);
  assert.equal(measurements.find(({ name }) => name === LAZPHO_OTEL_METRIC_NAMES.breakerRecoveries)?.value, 1);
  assert.equal(measurements.find(({ name }) => name === LAZPHO_OTEL_METRIC_NAMES.halfOpenAttempts)?.value, 1);
  instrumentation.dispose();
});

test('OTel observable counters report cumulative totals without repeated-collection inflation', async () => {
  const controller = createFactory().concurrency({ name: 'otel-counters', limit: 4 });
  await Promise.all(Array.from({ length: 10 }, () => controller.run(() => undefined)));
  const meter = new FakeMeter();
  const instrumentation = createLazphoOpenTelemetry({ controller, meter });
  for (let collection = 0; collection < 3; collection += 1) {
    const completed = meter.collect().find((measurement) => measurement.name === LAZPHO_OTEL_METRIC_NAMES.completed);
    assert.equal(completed?.kind, 'counter');
    assert.equal(completed?.value, 10);
    assert.deepEqual(completed?.attributes, { controller: 'otel-counters' });
  }
  instrumentation.dispose();
  assert.equal(meter.callbacks(), 0);
});

test('OTel instruments use bounded controller and configured bulkhead attributes only', async () => {
  const controller = createFactory().concurrency({
    name: 'otel-bulkheads', limit: 2, bulkheads: { fast: { maxConcurrent: 1, maxQueue: 2 }, slow: { maxConcurrent: 1, maxQueue: 3 } }
  });
  const meter = new FakeMeter();
  const instrumentation = createLazphoOpenTelemetry({ controller, meter, attributes: { service: 'checkout' } });
  const measurements = meter.collect().filter((measurement) => measurement.name === LAZPHO_OTEL_METRIC_NAMES.bulkheadActive);
  assert.deepEqual(measurements.map((measurement) => measurement.attributes?.bulkhead).sort(), ['fast', 'slow']);
  for (const measurement of measurements) assert.deepEqual(Object.keys(measurement.attributes ?? {}).sort(), ['bulkhead', 'controller', 'service']);
  instrumentation.dispose();
});

test('OTel metric callbacks isolate collection failures and repeated disposal removes exact registrations', () => {
  const factory = createFactory();
  const controller = factory.concurrency({ name: 'otel-disposal', limit: 1 });
  const meter = new FakeMeter();
  let errors = 0;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const instrumentation = createLazphoOpenTelemetry({ controller, meter, onError: () => { errors += 1; } });
    assert.equal(meter.callbacks(), 1);
    const originalStats = controller.stats;
    controller.stats = () => { throw new Error('snapshot failed'); };
    assert.doesNotThrow(() => meter.collect());
    controller.stats = originalStats;
    instrumentation.dispose();
    instrumentation.dispose();
    assert.equal(meter.callbacks(), 0);
  }
  assert.equal(errors, 5);
  factory.close();
});

test('numeric lifecycle and breaker mappings are stable and bounded', () => {
  assert.deepEqual((['running', 'draining', 'closed'] as const).map(lifecycleValue), [0, 1, 2]);
  assert.deepEqual((['closed', 'open', 'half_open'] as const).map(breakerValue), [0, 1, 2]);
});
