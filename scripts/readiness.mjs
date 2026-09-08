import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const api = JSON.parse(await readFile(resolve(root, 'api/public-api.json'), 'utf8'));
const requiredDocs = ['README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/api.md', 'docs/operations.md', 'docs/compatibility.md', 'docs/versioning.md', 'docs/migration.md', 'docs/phase8-validation.md', 'docs/phase8b-bottleneck-lab.md', 'docs/phase8-application-integration.md', 'docs/vision-and-usage.md', 'docs/load-lab.md', 'docs/stage3-validation.md', 'docs/stage3b-fault-validation.md', 'docs/1.0-readiness.md'];

await check('package identity and canonical SemVer', () => {
  assert.equal(packageJson.name, 'lazpho');
  assert.equal(semver.valid(packageJson.version), packageJson.version);
  assert.equal(packageJson.private, undefined);
});
await check('eleven declared ESM/type entry points', () => {
  assert.equal(Object.keys(packageJson.exports).length, 11);
  for (const target of Object.values(packageJson.exports)) assert.ok(target.import && target.types);
});
await check('release documentation files', () => Promise.all(requiredDocs.map((file) => access(resolve(root, file)))));
await check('public API snapshot matches package identity', () => {
  assert.equal(api.package.name, packageJson.name);
  assert.deepEqual(Object.keys(api.runtimeExports).sort(), Object.keys(packageJson.exports).map((key) => key === '.' ? packageJson.name : `${packageJson.name}/${key.slice(2)}`).sort());
});
await check('verified release artifact manifest', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/package-manifest.json'), 'utf8'));
  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

await check('canonical repository URL and package metadata', () => {
  assert.equal(packageJson.repository?.url, 'git+https://github.com/diveshshubham/lazpho.git');
  assert.equal(packageJson.homepage, 'https://github.com/diveshshubham/lazpho#readme');
  assert.equal(packageJson.bugs?.url, 'https://github.com/diveshshubham/lazpho/issues');
});
await check('documented private vulnerability-reporting channel', async () => {
  const security = await readFile(resolve(root, 'SECURITY.md'), 'utf8');
  assert.match(security, /github\.com\/diveshshubham\/lazpho\/security\/advisories\/new/);
});
await check('documented canonical branch protection', async () => {
  const readiness = await readFile(resolve(root, 'docs/1.0-readiness.md'), 'utf8');
  assert.match(readiness, /\[x\] Branch protection is enabled on `master`/);
});

console.log('BLOCKED  npm ownership and trusted-publisher association are not verified');
console.log('BLOCKED  maintainer approval of package identity and intended 1.0 public contract');
console.log('BLOCKED  real prerelease/RC install, provenance, and recovery validation');
console.log('\nStatus: NOT_READY_FOR_1_0');

async function check(label, operation) {
  try {
    await operation();
    console.log(`PASS     ${label}`);
  } catch (error) {
    console.error(`FAIL     ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
