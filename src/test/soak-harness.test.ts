import assert from 'node:assert/strict';
import test from 'node:test';
import { runSoak } from '../soak/harness.js';

test('short repeated lifecycle soak has no retained controller resources', async () => {
  const result = await runSoak({ seed: 5192026, cycles: 3, tasksPerCycle: 30 });
  assert.equal(result.logicalSubmissions, 90);
  assert.equal(result.finalActive, 0);
  assert.equal(result.finalQueued, 0);
  assert.equal(result.invariantViolations, 0);
  assert.equal(result.maxListenerWarnings, 0);
  assert.equal(result.unhandledRejections, 0);
  assert.equal(result.uncaughtExceptions, 0);
  assert.equal(result.obviousMonotonicHeapGrowth, false);
  assert.ok(result.attempts > 0);
  assert.ok(result.breakerTrips >= result.cycles);
});
