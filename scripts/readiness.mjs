import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const api = JSON.parse(await readFile(resolve(root, 'api/public-api.json'), 'utf8'));
const readiness = await readFile(resolve(root, 'docs/1.0-readiness.md'), 'utf8');
const releaseWorkflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
const requiredDocs = ['README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/getting-started.md', 'docs/adoption-guide.md', 'docs/testing.md', 'docs/signalboard-comparison.md', 'docs/api.md', 'docs/operations.md', 'docs/compatibility.md', 'docs/versioning.md', 'docs/migration.md', 'docs/application-benchmark.md', 'docs/bottleneck-lab.md', 'docs/application-integration.md', 'docs/vision-and-usage.md', 'docs/load-lab.md', 'docs/signalboard-validation.md', 'docs/mongodb-fault-validation.md', 'docs/mongodb-replica-set-validation.md', 'docs/1.0-readiness.md'];

await check('package identity and canonical SemVer', () => {
  assert.equal(packageJson.name, 'lazpho');
  assert.equal(semver.valid(packageJson.version), packageJson.version);
  assert.equal(packageJson.private, undefined);
});
await check('twelve declared ESM/type entry points', () => {
  assert.equal(Object.keys(packageJson.exports).length, 12);
  for (const target of Object.values(packageJson.exports)) assert.ok(target.import && target.types);
});
await check('release documentation files', () => Promise.all(requiredDocs.map((file) => access(resolve(root, file)))));
await check('public API snapshot matches package identity', () => {
  assert.equal(api.package.name, packageJson.name);
  assert.deepEqual(api.package.bin, packageJson.bin);
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
  assert.match(readiness, /\[x\] Branch protection is enabled on `master`/);
});
await check('stable version and release notes are prepared', () => {
  assert.equal(packageJson.version, '1.0.0');
  assert.match(changelog, /^## 1\.0\.0 - \d{4}-\d{2}-\d{2}$/m);
  assert.match(readiness, /\[x\] Maintainer approved the 1\.0 release notes and stable-version decision/);
});
await check('maintainer accepted the documented 1.x API contract', () => {
  assert.match(readiness, /\[x\] Maintainer approved the stable release and accepts `createFactory`/);
});
await check('published RC ownership, provenance, and recovery evidence', () => {
  assert.match(readiness, /\[x\] The package name is `lazpho`; `0\.1\.0-rc\.2` is publicly installed/);
  assert.match(readiness, /\[x\] `0\.1\.0-rc\.2` was published by the exact-artifact workflow/);
  assert.match(readiness, /github\.com\/diveshshubham\/lazpho\/actions\/runs\/34328526989/);
  assert.match(readiness, /registry\.npmjs\.org\/-\/npm\/v1\/attestations\/lazpho@0\.1\.0-rc\.2/);
});
await check('OIDC-only npm release workflow', () => {
  assert.match(releaseWorkflow, /id-token: write/);
  assert.match(releaseWorkflow, /npm publish \.\/artifacts\/\*\.tgz/);
  assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

const externalBlockers = [
  {
    label: 'npm trusted-publisher binding for diveshshubham/lazpho and release.yml',
    complete: /\[x\] npm trusted publishing is configured for `diveshshubham\/lazpho` and `release\.yml`/.test(readiness)
  },
  {
    label: 'published npm README and maintainer documentation review',
    complete: /\[x\] The published RC exposes `README\.md` through npm metadata/.test(readiness)
  }
];
for (const blocker of externalBlockers) {
  if (blocker.complete) console.log(`PASS     ${blocker.label}`);
  else {
    console.log(`BLOCKED  ${blocker.label}`);
    process.exitCode = 1;
  }
}
console.log(`\nStatus: ${externalBlockers.every(({ complete }) => complete) && !process.exitCode ? 'READY_FOR_1_0' : 'NOT_READY_FOR_1_0'}`);

async function check(label, operation) {
  try {
    await operation();
    console.log(`PASS     ${label}`);
  } catch (error) {
    console.error(`FAIL     ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
