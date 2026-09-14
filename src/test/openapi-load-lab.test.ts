import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
  discoverLazphoOpenApiEndpoints,
  startLazphoOpenApiLoadLab,
} from '../openapi-load-lab.js';

const document = {
  openapi: '3.0.0',
  paths: {
    '/health': {
      get: { operationId: 'health', summary: 'Health check' },
      post: { operationId: 'health-write', summary: 'Health mutation' },
    },
    '/users/{id}': {
      get: { operationId: 'user', summary: 'User by id' },
    },
    '/search': {
      get: {
        operationId: 'search',
        parameters: [{ name: 'query', in: 'query', required: true }],
      },
    },
    '/admin': {
      get: {
        operationId: 'health',
        parameters: [{ name: 'x-api-key', in: 'header', required: true }],
      },
    },
  },
};

test('OpenAPI discovery enables only parameter-free safe reads', () => {
  const endpoints = discoverLazphoOpenApiEndpoints(document, {
    headers: { 'x-api-key': 'secret' },
  });
  assert.equal(endpoints.length, 5);
  assert.equal(endpoints.find(({ path }) => path === '/health' && path)?.safe, true);
  assert.equal(endpoints.find(({ method }) => method === 'POST')?.safe, false);
  assert.equal(endpoints.find(({ path }) => path === '/users/{id}')?.safe, false);
  assert.equal(endpoints.find(({ path }) => path === '/search')?.safe, false);
  assert.equal(endpoints.find(({ path }) => path === '/admin')?.safe, true);
  assert.equal(new Set(endpoints.map(({ id }) => id)).size, endpoints.length);
  assert.equal(endpoints[0]?.headers?.['x-api-key'], 'secret');
});

test('OpenAPI Load Lab discovers a local application and executes its safe endpoint', async () => {
  let healthRequests = 0;
  let discoveryAuthorized = false;
  const target = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/openapi.json') {
      discoveryAuthorized = request.headers.authorization === 'Bearer secret';
      response.end(JSON.stringify(document));
      return;
    }
    if (request.url === '/health') healthRequests += 1;
    response.end(JSON.stringify({ ok: true }));
  });
  const targetBaseUrl = await listen(target);
  const token = 'openapi-load-lab-test-token';
  const lab = await startLazphoOpenApiLoadLab({
    targetBaseUrl,
    port: 0,
    apiToken: token,
    headers: { authorization: 'Bearer secret' },
  });

  try {
    const state = lab.state();
    assert.equal(state.endpoints.length, 5);
    assert.equal(discoveryAuthorized, true);
    assert.equal('headers' in state.endpoints[0]!, false);
    const response = await fetch(`${lab.url}/api/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lazpho-dashboard-token': token,
      },
      body: JSON.stringify({ endpointId: 'health', profile: { mode: 'once' } }),
    });
    assert.equal(response.status, 202);
    await waitUntilIdle(lab);
    assert.equal(healthRequests, 1);
    assert.equal(lab.state().history[0]?.successfulRequests, 1);
  } finally {
    await lab.close();
    await close(target);
  }
});

test('OpenAPI Load Lab rejects remote discovery and malformed documents', async () => {
  await assert.rejects(
    startLazphoOpenApiLoadLab({ targetBaseUrl: 'https://example.com', document }),
    /Remote targets are disabled/,
  );
  assert.throws(() => discoverLazphoOpenApiEndpoints({ paths: {} }), /no supported operations/);
  assert.throws(
    () => discoverLazphoOpenApiEndpoints({}),
    /must contain a paths object/,
  );
});

test('OpenAPI Load Lab accepts bounded catalogs larger than one hundred operations', async () => {
  const paths = Object.fromEntries(
    Array.from({ length: 187 }, (_, index) => [
      `/route-${index}`,
      { get: { operationId: `route-${index}`, summary: 'x'.repeat(500) } },
    ]),
  );
  const lab = await startLazphoOpenApiLoadLab({
    targetBaseUrl: 'http://127.0.0.1:9',
    document: { openapi: '3.0.0', paths },
    port: 0,
  });
  try {
    assert.equal(lab.state().endpoints.length, 187);
    assert.equal(lab.state().endpoints[0]?.description.length, 256);
  } finally {
    await lab.close();
  }
});

async function waitUntilIdle(lab: { state(): { active: unknown } }): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (lab.state().active && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(lab.state().active, null);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address.'));
        return;
      }
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
