import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('core and pre-existing adapter runtime graphs contain no framework imports', async () => {
  const files = [
    '../index.js',
    '../adapters/fetch.js',
    '../adapters/node-http.js',
    '../observability.js',
    '../adapters/opentelemetry.js'
  ];
  for (const relative of files) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+['"](?:express|fastify|fastify-plugin|@nestjs\/)|require\(['"](?:express|fastify|fastify-plugin|@nestjs\/))/);
  }
  const core = await import('../index.js');
  assert.equal(typeof core.createFactory, 'function');
});
