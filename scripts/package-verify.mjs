import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const outputArgument = process.argv[2] === '--output' ? process.argv[3] : 'artifacts';
if (!outputArgument) throw new Error('Usage: node scripts/package-verify.mjs [--output <workspace-directory>]');
const outputDirectory = resolve(root, outputArgument);
const relativeOutput = relative(root, outputDirectory);
if (!relativeOutput || relativeOutput.startsWith(`..${sep}`) || relativeOutput === '..') {
  throw new Error('Package verification output must be a directory inside the workspace.');
}

await validateMetadata();
runNpm(['run', 'package:build'], root);
await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(outputDirectory)) {
  if (entry === 'package-manifest.json' || entry.endsWith('.tgz') || entry.endsWith('.tgz.sha256')) {
    await rm(resolve(outputDirectory, entry), { force: true });
  }
}
const expectedName = `${packageJson.name.replace(/^@/, '').replaceAll('/', '-')}-${packageJson.version}.tgz`;
const expectedTarball = resolve(outputDirectory, expectedName);
await rm(expectedTarball, { force: true });
await rm(`${expectedTarball}.sha256`, { force: true });
await rm(resolve(outputDirectory, 'package-manifest.json'), { force: true });

const packed = runNpmJson(['pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory], root)[0];
assert.equal(packed.filename, expectedName);
assert.ok(packed.size < 2_000_000, `Packed tarball unexpectedly exceeds 2 MB (${packed.size} bytes).`);
const paths = packed.files.map(({ path }) => path).sort();
validateFileList(paths);
await access(expectedTarball);

runNpm(['run', 'compat:consumer'], root, { COMPAT_TARBALL: expectedTarball });
const sha256 = createHash('sha256').update(await readFile(expectedTarball)).digest('hex');
await writeFile(`${expectedTarball}.sha256`, `${sha256}  ${basename(expectedTarball)}\n`);
await writeFile(resolve(outputDirectory, 'package-manifest.json'), `${JSON.stringify({
  name: packed.name,
  version: packed.version,
  filename: packed.filename,
  size: packed.size,
  unpackedSize: packed.unpackedSize,
  sha256,
  files: paths
}, null, 2)}\n`);
console.log(`Verified ${expectedName}: ${paths.length} files, ${packed.size} packed bytes, SHA-256 ${sha256}`);

async function validateMetadata() {
  assert.equal(semver.valid(packageJson.version), packageJson.version, 'package version must be canonical SemVer');
  assert.equal(packageJson.private, undefined, 'publishable package must not be private');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.sideEffects, false);
  assert.deepEqual(packageJson.files, ['dist', 'docs', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md']);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.engines.node, '>=18.0.0');
  await Promise.all(['LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/compatibility.md'].map((path) => access(resolve(root, path))));
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  assert.match(readme, /\(docs\/compatibility\.md\)/);
  const expectedPeers = ['@nestjs/common', 'express', 'fastify', 'fastify-plugin', 'rxjs'];
  assert.deepEqual(Object.keys(packageJson.peerDependencies).sort(), expectedPeers);
  assert.deepEqual(Object.keys(packageJson.peerDependenciesMeta).sort(), expectedPeers);
  for (const peer of expectedPeers) assert.equal(packageJson.peerDependenciesMeta[peer].optional, true);
  for (const target of Object.values(packageJson.exports)) {
    assert.ok(target.import && target.types, 'each public subpath requires import and types targets');
  }
  if (!packageJson.repository) console.log('Package metadata note: canonical repository URL is not configured.');
}

function validateFileList(paths) {
  const allowed = /^(?:dist\/|docs\/[^/]+\.md$|README\.md$|LICENSE$|CHANGELOG\.md$|SECURITY\.md$|CONTRIBUTING\.md$|package\.json$)/;
  for (const path of paths) assert.match(path, allowed, `Unexpected package path: ${path}`);
  for (const required of ['LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/api.md', 'docs/operations.md', 'docs/compatibility.md', 'docs/versioning.md', 'docs/migration.md', 'docs/phase8-validation.md', 'docs/phase8b-bottleneck-lab.md', 'docs/phase8-application-integration.md', 'docs/vision-and-usage.md', 'docs/load-lab.md', 'docs/stage3-validation.md', 'docs/stage3b-fault-validation.md', 'docs/stage3c-replica-set-validation.md', 'docs/1.0-readiness.md', 'package.json']) assert.ok(paths.includes(required), `Missing ${required}`);
  for (const target of Object.values(packageJson.exports)) {
    for (const path of [target.import, target.types].map((value) => value.replace(/^\.\//, ''))) {
      assert.ok(paths.includes(path), `Missing exported artifact ${path}`);
    }
  }
  for (const forbidden of [/^src\//, /^api\//, /^compat\//, /^scripts\//, /^dist\/(?:test|benchmark|stress|soak|example)\//, /(?:^|\/)(?:coverage|node_modules)(?:\/|$)/, /\.(?:log|tgz)$/]) {
    assert.equal(paths.some((path) => forbidden.test(path)), false, `Forbidden package content matched ${forbidden}`);
  }
}

function runNpm(args, cwd, environment = {}) {
  if (!npmCli) throw new Error('npm_execpath is unavailable; invoke this script through npm.');
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment }
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}.`);
  return result.stdout;
}

function runNpmJson(args, cwd) {
  const output = runNpm(args, cwd);
  return JSON.parse(output.slice(output.indexOf('[')));
}
