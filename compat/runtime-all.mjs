import assert from 'node:assert/strict';

const expected = [
  'lazpho', 'lazpho/config', 'lazpho/application', 'lazpho/load-lab', 'lazpho/openapi-load-lab', 'lazpho/fetch', 'lazpho/node-http',
  'lazpho/observability', 'lazpho/opentelemetry', 'lazpho/express',
  'lazpho/fastify', 'lazpho/nestjs'
];
for (const specifier of expected) assert.ok(await import(specifier));
console.log('All packed public runtime subpaths resolved.');
