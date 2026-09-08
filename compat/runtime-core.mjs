import assert from 'node:assert/strict';
import { createFactory } from 'lazpho';
import { createLazphoPreset } from 'lazpho/config';
import { createProtectedFetch } from 'lazpho/fetch';

assert.equal(typeof fetch, 'function');
assert.equal(typeof Request, 'function');
assert.equal(typeof Response, 'function');
assert.equal(typeof AbortController, 'function');
assert.equal(typeof AbortSignal, 'function');
const factory = createFactory();
const preset = createLazphoPreset('balanced');
const controller = factory.concurrency(preset.concurrency);
assert.equal(await controller.run(async () => 42), 42);
const protectedFetch = createProtectedFetch({ controller, fetch: async (_input, init) => {
  assert.ok(init?.signal instanceof AbortSignal);
  return new Response('ok');
} });
assert.equal((await protectedFetch('https://example.invalid')).status, 200);
await controller.close();
factory.close();
await assert.rejects(import('lazpho/partition-scheduler'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
await assert.rejects(import('lazpho/concurrency-controller'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
console.log('Packed core consumer passed without framework peers.');
