import assert from 'node:assert/strict';
import test from 'node:test';
import { ControllerLifecycleError, createFactory } from '../index.js';

interface Gate {
  wait: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, open: release };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function adaptive(factory = createFactory(), work = factory.concurrency({ name: 'lifecycle-work', limit: 2 })) {
  return {
    work,
    limiter: factory.adaptiveConcurrency({
      name: 'lifecycle-control',
      controller: work,
      minLimit: 1,
      maxLimit: 10,
      targetP95Ms: 100,
      maxErrorRate: 0.01,
      mode: 'auto'
    })
  };
}

test('an empty limiter closes promptly and exposes its lifecycle', async () => {
  const { limiter } = adaptive();
  assert.equal(limiter.snapshot().lifecycle, 'running');
  await limiter.close();
  assert.equal(limiter.lifecycle(), 'closed');
  assert.equal(limiter.snapshot().lifecycle, 'closed');
  await limiter.close();
});

test('close waits for active work and rejects new work while draining', async () => {
  const { work, limiter } = adaptive();
  const release = gate();
  const active = work.run(() => release.wait);
  await flush();
  const closing = limiter.close();
  assert.equal(limiter.lifecycle(), 'draining');
  await assert.rejects(work.run(() => undefined), ControllerLifecycleError);
  let resolved = false;
  void closing.then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false);
  release.open();
  await active;
  await closing;
  assert.equal(limiter.lifecycle(), 'closed');
  await assert.rejects(work.run(() => undefined), ControllerLifecycleError);
});

test('queued work drains in FIFO order during shutdown without accepting new work', async () => {
  const { work, limiter } = adaptive();
  const release = gate();
  const started: number[] = [];
  const first = work.run(async () => { started.push(1); await release.wait; });
  const second = work.run(async () => { started.push(2); await release.wait; });
  const third = work.run(() => { started.push(3); });
  await flush();
  assert.deepEqual(started, [1, 2]);
  assert.equal(work.stats().queued, 1);
  const closing = limiter.close();
  await assert.rejects(work.run(() => undefined), ControllerLifecycleError);
  release.open();
  await Promise.all([first, second, third]);
  await closing;
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().queued, 0);
});

test('concurrent close calls share draining completion and task failures do not reject shutdown', async () => {
  const { work, limiter } = adaptive();
  const release = gate();
  const failed = work.run(async () => { await release.wait; throw new Error('expected failure'); });
  const completed = work.run(() => 'completed');
  const firstClose = limiter.close();
  const secondClose = limiter.close();
  assert.equal(firstClose, secondClose);
  release.open();
  await assert.rejects(failed, /expected failure/);
  assert.equal(await completed, 'completed');
  await Promise.all([firstClose, secondClose]);
  assert.equal(limiter.lifecycle(), 'closed');
});

test('runtime configuration is rejected during draining and closure preserves accepted work', async () => {
  const { work, limiter } = adaptive();
  const release = gate();
  const active = work.run(() => release.wait);
  const closing = limiter.close();
  assert.throws(() => limiter.updateConfig({ maxLimit: 5 }), ControllerLifecycleError);
  assert.equal(limiter.snapshot().controller.maxLimit, 10);
  release.open();
  await active;
  await closing;
  assert.throws(() => limiter.updateConfig({ maxLimit: 5 }), ControllerLifecycleError);
});
