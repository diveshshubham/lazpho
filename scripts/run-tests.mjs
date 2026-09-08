import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiledTests = (await readdir(resolve(root, 'dist/test'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => resolve(root, 'dist/test', entry.name));
const scriptTests = (await readdir(resolve(root, 'scripts'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => resolve(root, 'scripts', entry.name));
const tests = [...compiledTests, ...scriptTests].sort();

if (tests.length === 0) throw new Error('No test files were discovered.');

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
