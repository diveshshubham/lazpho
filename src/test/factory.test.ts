import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../index.js';

test('aggregates global requests, errors, and percentiles', () => {
  const factory = createFactory({ rpsWindowSeconds: 10 });
  for (const durationMs of [10, 20, 30, 40, 50]) {
    factory.recordRequest({ route: '/users', method: 'GET', statusCode: 200, durationMs });
  }
  factory.recordRequest({ route: '/users', method: 'GET', statusCode: 500, durationMs: 100 });
  const metrics = factory.getMetrics();
  assert.equal(metrics.totalRequests, 6);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.p50Ms, 30);
  assert.equal(metrics.p95Ms, 100);
  assert.equal(metrics.p99Ms, 100);
  assert.equal(metrics.routes['/users']?.totalRequests, 6);
  assert.ok(metrics.requestsPerSecond > 0);
  factory.close();
});

test('tracks active request lifecycle and only finishes once', () => {
  const factory = createFactory();
  const timer = factory.startRequest('/health', 'GET');
  assert.equal(factory.getMetrics().activeRequests, 1);
  timer.finish(200);
  timer.finish(500);
  const metrics = factory.getMetrics();
  assert.equal(metrics.activeRequests, 0);
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.errors, 0);
  factory.close();
});

test('bounds route cardinality using the overflow route', () => {
  const factory = createFactory({ maxRoutes: 2 });
  factory.recordRequest({ route: '/one', method: 'GET', statusCode: 200, durationMs: 1 });
  factory.recordRequest({ route: '/two', method: 'GET', statusCode: 200, durationMs: 1 });
  factory.recordRequest({ route: '/three', method: 'GET', statusCode: 200, durationMs: 1 });
  const metrics = factory.getMetrics();
  assert.deepEqual(Object.keys(metrics.routes).sort(), ['/one', '/two', '__other__'].sort());
  assert.equal(metrics.routes.__other__?.totalRequests, 1);
  factory.close();
});

test('disabled instrumentation is a no-op', () => {
  const factory = createFactory({ enabled: false });
  factory.recordRequest({ route: '/private', method: 'GET', statusCode: 500, durationMs: 10 });
  assert.equal(factory.getMetrics().totalRequests, 0);
  factory.close();
});
