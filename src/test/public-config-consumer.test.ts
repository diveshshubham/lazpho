import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';
import { createLazphoPreset, inspectLazphoConfig, listLazphoPresets, resolveLazphoConfig, validateLazphoConfig } from '../config.js';
import type { LazphoConfigInspection, LazphoConfigOverrides, LazphoConfigWarningCode, LazphoPresetName, ResolvedLazphoConfig } from '../config.js';

test('public configuration types support presets, overrides, validation, inspection, and controllers', async () => {
  const name: LazphoPresetName = 'balanced';
  const overrides: LazphoConfigOverrides = {
    concurrency: { name: 'typed-config', bulkheads: { payments: { maxConcurrent: 2, maxQueue: 4 } } },
    adaptive: { name: 'typed-adaptive', maxLimit: 24 }
  };
  const config: ResolvedLazphoConfig = createLazphoPreset(name, overrides);
  validateLazphoConfig(config);
  const inspection: LazphoConfigInspection = inspectLazphoConfig(config);
  const codes: readonly LazphoConfigWarningCode[] = inspection.warnings.map(({ code }) => code);
  const copied = resolveLazphoConfig(config);
  assert.deepEqual(copied, config);
  assert.ok(listLazphoPresets().includes(name));
  assert.deepEqual(codes, []);

  const factory = createFactory();
  const controller = factory.concurrency(config.concurrency);
  const adaptive = factory.adaptiveConcurrency({ ...config.adaptive, controller });
  assert.equal(await controller.run(() => 'ok', { bulkhead: 'payments' }), 'ok');
  await adaptive.close();
  factory.close();
});
