import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'lazpho-compat-'));
if (!basename(temporary).startsWith('lazpho-compat-')) throw new Error('Refusing to use an unexpected compatibility directory.');
const npmCli = process.env.npm_execpath;
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
assert.ok([18, 20, 22, 24].includes(nodeMajor), `Node ${nodeMajor} is outside the supported 18/20/22/24 matrix.`);

try {
  const tarball = process.env.COMPAT_TARBALL
    ? resolve(root, process.env.COMPAT_TARBALL)
    : await createTarball();
  await access(tarball);

  const coreConsumer = join(temporary, 'core-consumer');
  await prepareConsumer(coreConsumer);
  runNpm(['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', '--omit=peer', '--omit=optional', tarball], coreConsumer);
  await cp(resolve(root, 'compat/runtime-core.mjs'), join(coreConsumer, 'runtime-core.mjs'));
  run(process.execPath, ['runtime-core.mjs'], coreConsumer);
  for (const absent of ['express', 'fastify', '@nestjs/common', 'rxjs']) {
    await assert.rejects(access(join(coreConsumer, 'node_modules', absent)));
  }

  const fullConsumer = join(temporary, 'full-consumer');
  await prepareConsumer(fullConsumer);
  const frameworkPackages = await frameworkPackageSpecs();
  runNpm(['install', '--prefer-offline', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball, ...frameworkPackages], fullConsumer);
  await cp(resolve(root, 'compat/runtime-all.mjs'), join(fullConsumer, 'runtime-all.mjs'));
  await cp(resolve(root, 'compat/consumer.ts'), join(fullConsumer, 'consumer.ts'));
  run(process.execPath, ['runtime-all.mjs'], fullConsumer);
  const installedPackage = join(fullConsumer, 'node_modules', ...packageJson.name.split('/'));
  await assert.rejects(access(join(installedPackage, 'src')));
  await assert.rejects(access(join(installedPackage, 'compat')));

  const compilerMode = process.env.COMPAT_TYPESCRIPT_MODE ?? 'both';
  assert.ok(['both', 'minimum', 'current', 'none'].includes(compilerMode), `Unknown COMPAT_TYPESCRIPT_MODE: ${compilerMode}`);
  const compilers = [
    ['minimum', resolve(root, 'node_modules/typescript-minimum/bin/tsc')],
    ['current', resolve(root, 'node_modules/typescript/bin/tsc')]
  ].filter(([label]) => compilerMode === 'both' || compilerMode === label);
  for (const [label, compiler] of compilers) {
    run(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable', '--types', 'node', 'consumer.ts'], fullConsumer);
    console.log(`Packed TypeScript consumer passed with ${label} compiler.`);
  }

  const installed = {};
  for (const name of ['express', 'fastify', 'fastify-plugin', '@nestjs/common', 'rxjs']) {
    installed[name] = JSON.parse(await readFile(join(fullConsumer, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  console.log(`Compatibility passed on Node ${process.versions.node}: ${JSON.stringify(installed)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function createTarball() {
  runNpm(['pack', '--silent', '--pack-destination', temporary], root);
  const tarballName = (await readdir(temporary)).find((name) => name.endsWith('.tgz'));
  assert.ok(tarballName, 'npm pack did not create a tarball.');
  return join(temporary, tarballName);
}

async function prepareConsumer(directory) {
  await writeFile(join(temporary, '.compat-root'), 'lazpho compatibility temporary directory\n', { flag: 'a' });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
}

async function frameworkPackageSpecs() {
  const names = ['express', 'fastify', 'fastify-plugin', '@nestjs/common', 'rxjs', 'reflect-metadata', '@types/express', '@types/node'];
  const environmentNames = {
    express: 'COMPAT_EXPRESS_VERSION',
    fastify: 'COMPAT_FASTIFY_VERSION',
    'fastify-plugin': 'COMPAT_FASTIFY_PLUGIN_VERSION',
    '@nestjs/common': 'COMPAT_NESTJS_VERSION',
    rxjs: 'COMPAT_RXJS_VERSION',
    'reflect-metadata': 'COMPAT_REFLECT_METADATA_VERSION',
    '@types/express': 'COMPAT_EXPRESS_TYPES_VERSION',
    '@types/node': 'COMPAT_NODE_TYPES_VERSION'
  };
  return Promise.all(names.map(async (name) => {
    const selected = process.env[environmentNames[name]];
    const version = selected ?? JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    return `${name}@${version}`;
  }));
}

function runNpm(args, cwd) {
  if (!npmCli) throw new Error('npm_execpath is unavailable; run compatibility through npm run compat.');
  run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
}
