import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createFactory } from '../factory.js';
import { startLazphoLoadLab, type LazphoLoadRunResult } from '../load-lab.js';

test('Load Lab executes registered safe endpoints and exposes bounded reports', async () => {
  const factory = createFactory();
  const dependency = factory.concurrency({ name: 'database', limit: 1, maxQueueSize: 2 });
  const targetPaths: string[] = [];
  let cleanedFixture = false;
  const target = createServer((request, response) => {
    targetPaths.push(request.url ?? '');
    void dependency.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    }).catch(() => {
      response.statusCode = 503;
      response.end(JSON.stringify({ code: 'OVERLOADED' }));
    });
  });
  const targetUrl = await listen(target);
  const token = 'load-lab-test-token';
  const errors: string[] = [];
  const lab = await startLazphoLoadLab({
    targetBaseUrl: targetUrl,
    port: 0,
    apiToken: token,
    maxInFlight: 8,
    metrics: () => factory.getMetrics(),
    onRunError: (_error, endpointId) => errors.push(endpointId),
    endpoints: [
      { id: 'health', method: 'GET', path: '/health', description: 'Safe health check', safe: true, headers: { authorization: 'secret' } },
      { id: 'delete', method: 'DELETE', path: '/items/1', description: 'Unsafe mutation', safe: false },
      {
        id: 'fixture-update', method: 'PATCH', path: '/items/:id', description: 'Managed fixture mutation', safe: true,
        setup: () => ({ id: 'fixture-123' }),
        request: ({ fixture, sequence }) => ({ path: `/items/${(fixture as { id: string }).id}`, body: { sequence } }),
        cleanup: ({ fixture }) => { cleanedFixture = (fixture as { id: string }).id === 'fixture-123'; }
      }
    ]
  });

  const page = await fetch(lab.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lazpho Load Lab/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);

  const initial = await getJson<{ endpoints: Array<Record<string, unknown>> }>(`${lab.url}/api/state`);
  assert.equal(initial.endpoints.length, 3);
  assert.equal(initial.endpoints[0]?.headers, undefined);
  assert.equal(initial.endpoints[2]?.fixtureManaged, true);
  assert.equal((await run(lab.url, token, 'delete', { mode: 'once' })).status, 403);
  assert.equal((await fetch(`${lab.url}/api/run`, { method: 'POST' })).status, 403);

  assert.equal((await run(lab.url, token, 'health', { mode: 'once' })).status, 202);
  await waitUntilIdle(lab);
  const result = lab.state().history[0];
  assert.equal(result?.status, 'completed');
  assert.equal(result?.successfulRequests, 1);
  assert.equal(result?.statusCodes['200'], 1);
  assert.match(result?.responseSample ?? '', /"ok":true/);
  assert.equal(result?.controllers[0]?.stayedWithinLimit, true);
  assert.equal(result?.controllers[0]?.completed, 1);

  const reportJson = await getJson<LazphoLoadRunResult>(`${lab.url}/api/reports/${result?.id}.json`);
  assert.equal(reportJson.endpointId, 'health');
  const reportHtml = await fetch(`${lab.url}/api/reports/${result?.id}.html`);
  assert.match(await reportHtml.text(), /What Lazpho did/);

  assert.equal((await run(lab.url, token, 'fixture-update', { mode: 'once' })).status, 202);
  await waitUntilIdle(lab);
  assert.equal(cleanedFixture, true);
  assert.ok(targetPaths.includes('/items/fixture-123'));

  assert.equal((await run(lab.url, token, 'health', { mode: 'latency', requests: 3 })).status, 202);
  await waitUntilIdle(lab);
  assert.equal(lab.state().history[2]?.completedRequests, 3);

  assert.equal((await run(lab.url, token, 'health', { mode: 'load', requestsPerSecond: 1_000, durationSeconds: 1 })).status, 202);
  await waitUntilIdle(lab);
  const load = lab.state().history[3];
  assert.equal(load?.requestedRequests, 1_000);
  assert.ok((load?.attemptedRequests ?? 0) > 0);
  assert.ok((load?.generatorLimitedRequests ?? 0) > 0);
  assert.equal(load?.controllers[0]?.stayedWithinLimit, true);
  assert.ok((load?.controllers[0]?.rejected ?? 0) > 0);
  assert.deepEqual(errors, []);

  await lab.close();
  await dependency.close();
  factory.close();
  await close(target);
});

test('Load Lab rejects remote targets and invalid or unsafe configuration', async () => {
  const endpoint = { id: 'safe', method: 'GET' as const, path: '/', description: 'Safe endpoint', safe: true };
  await assert.rejects(startLazphoLoadLab({ targetBaseUrl: 'https://example.com', endpoints: [endpoint] }), /Remote load targets/);
  await assert.rejects(startLazphoLoadLab({ targetBaseUrl: 'http://127.0.0.1/path', endpoints: [endpoint] }), /origin/);
  await assert.rejects(startLazphoLoadLab({ targetBaseUrl: 'http://127.0.0.1', endpoints: [{ ...endpoint, path: '//example.com' }] }), /relative URL/);
  await assert.rejects(startLazphoLoadLab({ targetBaseUrl: 'http://127.0.0.1', endpoints: [{ ...endpoint, headers: { host: 'example.com' } }] }), /cannot override/);
});

async function run(url: string, token: string, endpointId: string, profile: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lazpho-dashboard-token': token },
    body: JSON.stringify({ endpointId, profile })
  });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}

async function waitUntilIdle(lab: { state(): { active: unknown } }): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (lab.state().active && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lab.state().active, null);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Expected TCP address.'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
