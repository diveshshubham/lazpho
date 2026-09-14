import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLazphoCliArguments } from '../cli.js';

test('CLI parses generic OpenAPI Load Lab options', () => {
  const parsed = parseLazphoCliArguments([
    'load-lab',
    '--target',
    'http://127.0.0.1:4000',
    '--openapi=/api/docs-json',
    '--port',
    '4100',
    '--max-in-flight=32',
    '--header-env',
    'authorization:TEST_AUTHORIZATION',
    '--header=x-api-key:value',
    '--reports',
    'load-reports',
  ], { TEST_AUTHORIZATION: 'Bearer secret' });
  assert.equal(parsed.command, 'load-lab');
  if (parsed.command !== 'load-lab') return;
  assert.equal(parsed.options.targetBaseUrl, 'http://127.0.0.1:4000');
  assert.equal(parsed.options.openApiPath, '/api/docs-json');
  assert.equal(parsed.options.port, 4100);
  assert.equal(parsed.options.maxInFlight, 32);
  assert.deepEqual(parsed.options.headers, {
    authorization: 'Bearer secret',
    'x-api-key': 'value',
  });
  assert.equal(parsed.options.reportDirectory, 'load-reports');
});

test('CLI help and validation are deterministic', () => {
  assert.deepEqual(parseLazphoCliArguments([]), { command: 'help' });
  assert.deepEqual(parseLazphoCliArguments(['--help']), { command: 'help' });
  assert.throws(() => parseLazphoCliArguments(['unknown']), /Unknown Lazpho command/);
  assert.throws(() => parseLazphoCliArguments(['load-lab']), /--target is required/);
  assert.throws(
    () => parseLazphoCliArguments(['load-lab', '--target', 'http://localhost', '--port', 'wrong']),
    /--port must be an integer/,
  );
  assert.throws(
    () => parseLazphoCliArguments(['load-lab', '--target', 'http://localhost', '--header', 'broken']),
    /name:value/,
  );
  assert.throws(
    () => parseLazphoCliArguments([
      'load-lab', '--target', 'http://localhost', '--header-env', 'authorization:MISSING_TOKEN',
    ], {}),
    /MISSING_TOKEN is not set/,
  );
  assert.throws(
    () => parseLazphoCliArguments([
      'load-lab', '--target', 'http://localhost',
      '--header', 'Authorization:literal',
      '--header-env', 'authorization:TEST_AUTHORIZATION',
    ], { TEST_AUTHORIZATION: 'secret-from-environment' }),
    /Duplicate request header/,
  );
});
