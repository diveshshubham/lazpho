import assert from 'node:assert/strict';
import test from 'node:test';
import { runStressScenario } from '../stress/harness.js';

test('seeded adversarial controller scenarios preserve accounting and lifecycle invariants', async () => {
  for (const seed of [184732, 92821, 771991]) {
    const result = await runStressScenario({ seed, tasks: 250 });
    assert.equal(result.invariantViolations, 0, `seed ${seed}`);
    assert.ok(result.totalAttempts >= result.success, `seed ${seed}`);
    assert.ok(result.retryAttempts >= result.retrySuccesses, `seed ${seed}`);
    assert.equal(result.finalActive, 0, `seed ${seed}`);
    assert.equal(result.finalQueue, 0, `seed ${seed}`);
    assert.equal(
      result.submitted,
      result.success + result.taskFailure + result.cancelled + result.timedOut + result.rejected + result.bulkheadRejected + result.lifecycleRejected,
      `seed ${seed}`
    );
    assert.ok(result.partitions.fast.executions > 0, `seed ${seed}: fast partition made no progress`);
    assert.ok(result.breakerRejected > 0, `seed ${seed}: breaker exercise did not reject queued work`);
  }
});
