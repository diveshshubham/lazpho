import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startLazphoLoadLab,
  type LazphoLoadEndpoint,
  type LazphoLoadLab,
  type LazphoLoadLabOptions,
  type LazphoLoadProfile,
  type LazphoLoadRunResult
} from '../load-lab.js';

test('public Load Lab types support an explicit safe endpoint catalog', () => {
  const endpoint: LazphoLoadEndpoint = {
    id: 'health', method: 'GET', path: '/health', description: 'Health check', safe: true,
    setup: ({ runId }) => ({ runId }),
    request: ({ fixture, sequence }) => ({ path: `/health?sequence=${sequence}`, headers: { 'x-fixture': String(fixture) } }),
    cleanup: async ({ signal }) => { if (signal.aborted) throw signal.reason; }
  };
  const profile: LazphoLoadProfile = { mode: 'load', requestsPerSecond: 10_000, durationSeconds: 10 };
  const options: LazphoLoadLabOptions = { targetBaseUrl: 'http://127.0.0.1:3000', endpoints: [endpoint] };
  const starter: Promise<LazphoLoadLab> = startLazphoLoadLab({ ...options, port: 0 });
  const result = undefined as LazphoLoadRunResult | undefined;
  assert.equal(endpoint.safe, true);
  assert.equal(profile.requestsPerSecond, 10_000);
  assert.ok(starter instanceof Promise);
  assert.equal(result, undefined);
  void starter.then((lab) => lab.close());
});
