import assert from 'node:assert/strict';
import test from 'node:test';
import { createLazphoApplication, startLazphoDashboard } from '../application.js';

test('application registry centralizes controllers, route mappings, request metrics, and shutdown', async () => {
  const application = createLazphoApplication({
    controllers: {
      database: { limit: 2, maxQueueSize: 4 },
      payments: { limit: 1, maxQueueSize: 2 }
    },
    adaptiveControllers: {
      databasePolicy: { controller: 'database', minLimit: 1, maxLimit: 4, targetP95Ms: 100, maxErrorRate: 0.1, mode: 'observe', evaluationIntervalMs: 1 }
    },
    routeControllers: {
      '/users/:id': ['database'],
      '/checkout': ['database', 'payments', 'payments']
    }
  });

  assert.deepEqual(Object.keys(application.controllers), ['database', 'payments']);
  assert.deepEqual(application.routeControllers['/checkout'], ['database', 'payments']);
  assert.equal(await application.run('database', () => 42), 42);
  assert.equal(application.controller('database').stats().completed, 1);
  assert.equal(application.evaluateAdaptive(Date.now()).databasePolicy?.mode, 'observe');
  assert.equal(application.adaptiveControllers.databasePolicy?.lifecycle(), 'running');
  assert.throws(() => application.controller('missing'), /Unknown Lazpho controller/);

  const request = application.startRequest('/users/:id', 'GET');
  request.finish(200);
  request.finish(500);
  assert.equal(application.getMetrics().routes['/users/:id']?.totalRequests, 1);
  assert.throws(() => application.startRequest('users/123', 'GET'), /stable template/);

  application.resetRequestMetrics();
  assert.deepEqual(application.getMetrics().routes, {});
  await application.close();
  await application.close();
  assert.equal(application.controller('database').lifecycle(), 'closed');
});

test('application configuration rejects ambiguous ownership and unsafe mappings before construction', async () => {
  const external = createLazphoApplication();
  assert.throws(() => createLazphoApplication({ factory: external.factory, factoryOptions: {} }), /cannot be supplied together/);
  assert.throws(() => createLazphoApplication({ controllers: { 'not safe!': { limit: 1 } } }), /safe characters/);
  assert.throws(() => createLazphoApplication({
    controllers: { database: { limit: 1 } },
    routeControllers: { '/users': ['missing'] }
  }), /unknown controller/);
  assert.throws(() => createLazphoApplication({
    controllers: { database: { limit: 1 } },
    adaptiveControllers: { policy: { controller: 'missing', minLimit: 1, maxLimit: 2, targetP95Ms: 10, maxErrorRate: 0.1 } }
  }), /unknown controller/);
  await external.close();
});

test('loopback dashboard exposes only registered scenarios with bounded run, cancel, timeout, and reset behavior', async () => {
  const application = createLazphoApplication({
    controllers: { database: { limit: 1, maxQueueSize: 2 } },
    routeControllers: { '/users/:id': ['database'] }
  });
  const timer = application.startRequest('/users/:id', 'GET');
  timer.finish(200);
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const errors: string[] = [];
  const apiToken = 'application-test-token';
  const dashboard = await startLazphoDashboard({
    application,
    port: 0,
    apiToken,
    historySize: 3,
    onScenarioError: (_error, scenario) => errors.push(scenario),
    scenarios: [
      { name: 'healthy', description: 'Explicit safe read', run: async () => { await gate; return { outcomes: { success: 2 } }; } },
      { name: 'failure', description: 'Explicit failure', run: () => { throw new Error('private failure'); } },
      { name: 'timeout', description: 'Timeout even when callback ignores cancellation', timeoutMs: 15, run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { outcomes: { too_late: 1 } };
      } },
      { name: 'cancel', description: 'Cooperative cancellation', run: ({ signal }) => waitForAbort(signal) }
    ]
  });

  assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await fetch(dashboard.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lazpho application dashboard/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const catalog = await getJson<Array<{ name: string }>>(`${dashboard.url}/api/scenarios`);
  assert.deepEqual(catalog.map(({ name }) => name), ['healthy', 'failure', 'timeout', 'cancel']);
  assert.equal((await fetch(`${dashboard.url}/api/state`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${dashboard.url}/api/run?scenario=healthy`, { method: 'POST' })).status, 403);
  assert.equal((await post(`${dashboard.url}/api/run?scenario=unknown`, apiToken)).status, 404);

  assert.equal((await post(`${dashboard.url}/api/run?scenario=healthy`, apiToken)).status, 202);
  assert.equal((await post(`${dashboard.url}/api/run?scenario=failure`, apiToken)).status, 409);
  assert.equal((await post(`${dashboard.url}/api/reset`, apiToken)).status, 409);
  releaseGate();
  await waitUntilIdle(dashboard);
  assert.equal(dashboard.state().history[0]?.result?.outcomes.success, 2);

  assert.equal((await post(`${dashboard.url}/api/run?scenario=failure`, apiToken)).status, 202);
  await waitUntilIdle(dashboard);
  assert.equal(dashboard.state().history.at(-1)?.status, 'failed');
  assert.deepEqual(errors, ['failure']);

  assert.equal((await post(`${dashboard.url}/api/run?scenario=timeout`, apiToken)).status, 202);
  await waitUntilIdle(dashboard);
  assert.equal(dashboard.state().history.at(-1)?.status, 'timed_out');

  assert.equal((await post(`${dashboard.url}/api/run?scenario=cancel`, apiToken)).status, 202);
  assert.equal((await post(`${dashboard.url}/api/cancel`, apiToken)).status, 202);
  await waitUntilIdle(dashboard);
  assert.equal(dashboard.state().history.at(-1)?.status, 'cancelled');
  assert.equal(dashboard.state().history.length, 3);

  const state = await getJson<{ diagnoses: Record<string, string>; metrics: { routes: Record<string, unknown> } }>(`${dashboard.url}/api/state`);
  assert.equal(state.diagnoses['/users/:id'], 'no_dominant_bottleneck');
  assert.ok(state.metrics.routes['/users/:id']);
  assert.equal((await post(`${dashboard.url}/api/reset`, apiToken)).status, 200);
  assert.equal(dashboard.state().history.length, 0);
  assert.deepEqual(dashboard.state().metrics.routes, {});

  await dashboard.close();
  await dashboard.close();
  assert.equal(application.controller('database').lifecycle(), 'running');
  await application.close();
});

test('dashboard validates loopback, scenario metadata, results, and reserved names', async () => {
  const application = createLazphoApplication();
  await assert.rejects(startLazphoDashboard({ application, host: '0.0.0.0' as '127.0.0.1' }), /loopback/);
  await assert.rejects(startLazphoDashboard({ application, port: -1 }), /port/);
  await assert.rejects(startLazphoDashboard({ application, apiToken: 'short' }), /apiToken/);
  await assert.rejects(startLazphoDashboard({ application, scenarios: [
    { name: 'all', description: 'reserved', run: () => ({ outcomes: {} }) }
  ] }), /reserved/);
  await assert.rejects(startLazphoDashboard({ application, scenarios: [
    { name: 'unsafe scenario', description: 'invalid', run: () => ({ outcomes: {} }) }
  ] }), /safe characters/);

  const dashboard = await startLazphoDashboard({ application, port: 0, apiToken: 'validation-token', scenarios: [
    { name: 'invalid-result', description: 'Result validation', run: () => ({ outcomes: { bad: -1 } }) }
  ] });
  assert.equal((await post(`${dashboard.url}/api/run?scenario=invalid-result`, 'validation-token')).status, 202);
  await waitUntilIdle(dashboard);
  assert.equal(dashboard.state().history[0]?.status, 'failed');
  await dashboard.close();
  await application.close();
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}

function post(url: string, apiToken: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'x-lazpho-dashboard-token': apiToken } });
}

async function waitUntilIdle(dashboard: { state(): { runningScenario: string | null } }): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (dashboard.state().runningScenario && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dashboard.state().runningScenario, null);
}

function waitForAbort(signal: AbortSignal): Promise<{ outcomes: { success: number } }> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
