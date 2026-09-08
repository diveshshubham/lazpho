import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';

test('legacy factory and zero-argument run usage remains compatible', async () => {
  const factory = createFactory();
  const controller = factory.concurrency({ limit: 1 });
  const value = await controller.run(async () => 42);
  assert.equal(value, 42);
  await controller.close();
  assert.equal(controller.lifecycle(), 'closed');
  factory.close();
});
