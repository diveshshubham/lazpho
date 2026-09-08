import assert from 'node:assert/strict';

const labUrl = new URL(process.env.LOAD_LAB_URL || 'http://127.0.0.1:1913');
const appUrl = new URL(process.env.SIGNALBOARD_URL || 'http://127.0.0.1:3000');
const requestsPerSecond = positiveInteger(process.env.LOAD_LAB_VALIDATION_RPS, 1_000);
const durationSeconds = positiveInteger(process.env.LOAD_LAB_VALIDATION_DURATION_SECONDS, 1);
const latencyRequests = positiveInteger(process.env.LOAD_LAB_VALIDATION_LATENCY_REQUESTS, 5);

const pageResponse = await fetch(labUrl, { signal: AbortSignal.timeout(10_000) });
assert.equal(pageResponse.status, 200, 'Load Lab dashboard must be reachable.');
assert.match(pageResponse.headers.get('content-security-policy') || '', /default-src 'none'/);
const page = await pageResponse.text();
assert.match(page, /Lazpho Load Lab/);
for (const action of ['Send once', 'Test latency', 'Load test']) assert.match(page, new RegExp(action));
const token = page.match(/const token=("[A-Za-z0-9_-]{16,256}")/)?.[1];
assert.ok(token, 'Dashboard page did not contain its loopback API token.');
const apiToken = JSON.parse(token);

let state = await getJson(new URL('/api/state', labUrl));
assert.equal(state.endpoints.length, 5, 'Signalboard must register all five APIs.');
assert.deepEqual(state.presets, [10_000, 50_000, 100_000, 1_000_000]);
for (const endpoint of state.endpoints) {
  assert.equal(endpoint.safe, true, `${endpoint.id} must be explicitly marked safe.`);
  assert.equal(endpoint.headers, undefined, `${endpoint.id} leaked configured headers.`);
  assert.equal(endpoint.body, undefined, `${endpoint.id} leaked a configured body.`);
}

const unauthorized = await fetch(new URL('/api/reset', labUrl), { method: 'POST' });
assert.equal(unauthorized.status, 403, 'Dashboard mutations must require the instance token.');
await post('/api/reset');

const results = [];
for (const mode of ['once', 'latency', 'load']) {
  for (const endpoint of state.endpoints) {
    const profile = mode === 'once'
      ? { mode }
      : mode === 'latency'
        ? { mode, requests: latencyRequests }
        : { mode, requestsPerSecond, durationSeconds };
    const before = state.history.length;
    const accepted = await post('/api/run', { endpointId: endpoint.id, profile }, 202);
    assert.equal(accepted.status, 'started');
    state = await waitForResult(before);
    const result = state.history.at(-1);
    assert.equal(result.endpointId, endpoint.id);
    assert.equal(result.mode, mode);
    assert.equal(result.status, 'completed', `${endpoint.id}/${mode} did not complete.`);
    assert.ok(result.completedRequests > 0, `${endpoint.id}/${mode} completed no requests.`);
    if (mode === 'once') assert.equal(result.successfulRequests, 1, `${endpoint.id}/once was not successful.`);
    for (const controller of result.controllers) {
      assert.equal(controller.stayedWithinLimit, true, `${endpoint.id}/${mode} exceeded ${controller.name}'s limit.`);
    }
    const reportJson = await getJson(new URL(`/api/reports/${result.id}.json`, labUrl));
    assert.equal(reportJson.id, result.id);
    const reportHtml = await fetch(new URL(`/api/reports/${result.id}.html`, labUrl));
    assert.equal(reportHtml.status, 200);
    assert.match(await reportHtml.text(), /What Lazpho did/);
    results.push(result);
  }
}

const ideas = await getJson(new URL('/api/ideas', appUrl));
const runIds = new Set(results.map((result) => result.id));
const leakedFixtures = ideas.filter((idea) => typeof idea.title === 'string'
  && [...runIds].some((runId) => idea.title.includes(runId)));
assert.deepEqual(leakedFixtures, [], 'A managed Load Lab fixture remained in Signalboard.');

const summary = {
  dashboard: labUrl.origin,
  application: appUrl.origin,
  endpoints: state.endpoints.length,
  modes: ['once', 'latency', 'load'],
  runs: results.length,
  completed: results.filter((result) => result.status === 'completed').length,
  attemptedRequests: results.reduce((total, result) => total + result.attemptedRequests, 0),
  successfulRequests: results.reduce((total, result) => total + result.successfulRequests, 0),
  failedRequests: results.reduce((total, result) => total + result.failedRequests, 0),
  generatorLimitedRequests: results.reduce((total, result) => total + result.generatorLimitedRequests, 0),
  controllerLimitViolations: results.flatMap((result) => result.controllers).filter((controller) => !controller.stayedWithinLimit).length,
  leakedFixtures: leakedFixtures.length
};
console.log('Load Lab black-box validation passed.');
console.table([summary]);

async function post(path, body, expectedStatus = 200) {
  const response = await fetch(new URL(path, labUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lazpho-dashboard-token': apiToken
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}.`);
  return response.json();
}

async function waitForResult(previousHistoryLength) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await getJson(new URL('/api/state', labUrl));
    if (!current.active && current.history.length === previousHistoryLength + 1) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Load Lab to finish a run.');
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `${url.pathname} returned ${response.status}.`);
  return response.json();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
