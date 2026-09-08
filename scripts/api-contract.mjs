import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(root, 'api/public-api.json');
const typesPath = resolve(root, 'api/public-types.json');
const mode = process.argv[2];
if (mode !== 'check' && mode !== 'update') throw new Error('Usage: node scripts/api-contract.mjs <check|update>');

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const entries = Object.fromEntries(Object.entries(packageJson.exports).map(([subpath, target]) => [
  subpath === '.' ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`,
  target
]));

const modules = {};
for (const [specifier, target] of Object.entries(entries)) {
  const module = await import(`${pathToFileURL(resolve(root, target.import)).href}?api-contract`);
  modules[specifier] = module;
}

const core = modules[packageJson.name];
const config = modules[`${packageJson.name}/config`];
const otel = modules[`${packageJson.name}/opentelemetry`];
const express = modules[`${packageJson.name}/express`];
const errorCases = [
  ['QueueFullError', ['contract', 4]],
  ['BulkheadQueueFullError', ['contract', 'payments', 2]],
  ['UnknownBulkheadError', ['contract', 'missing']],
  ['QueueAbortedError', ['contract']],
  ['ControllerAbortError', ['contract']],
  ['ControllerTimeoutError', ['contract', 100]],
  ['QueueWaitTimeoutError', ['contract', 100]],
  ['ControllerLifecycleError', ['contract', 'accept new work']],
  ['CircuitBreakerOpenError', ['contract']],
  ['DuplicateControllerNameError', ['contract']],
  ['ControllerLimitError', [100]]
];
const errors = {};
const httpMapping = {};
for (const [name, args] of errorCases) {
  const error = new core[name](...args);
  const mapped = express.mapLazphoErrorToHttp(error);
  errors[name] = {
    base: Object.getPrototypeOf(Object.getPrototypeOf(error)).constructor.name,
    classification: core.classifyLazphoError(error),
    code: error.code,
    metadata: Object.keys(error).filter((key) => key !== 'code').sort()
  };
  httpMapping[name] = mapped ?? null;
}

const presets = {};
for (const name of config.listLazphoPresets()) presets[name] = config.createLazphoPreset(name);
const warningConfig = config.createLazphoPreset('balanced', {
  concurrency: { limit: 95, maxQueueSize: 2_500, bulkheads: { huge: { maxConcurrent: 101, maxQueue: 2_100 } } },
  adaptive: { maxLimit: 100, targetP95Ms: 5 }
});
const fixedConfig = config.createLazphoPreset('balanced', {
  concurrency: { limit: 8 }, adaptive: { minLimit: 8, maxLimit: 8 }
});
const warningCodes = [...new Set([
  ...config.inspectLazphoConfig(warningConfig).warnings.map(({ code }) => code),
  ...config.inspectLazphoConfig(fixedConfig).warnings.map(({ code }) => code)
])].sort();

const contract = JSON.parse(JSON.stringify(sortObject({
  package: {
    name: packageJson.name,
    type: packageJson.type,
    sideEffects: packageJson.sideEffects,
    engines: packageJson.engines,
    exports: packageJson.exports,
    peerDependencies: packageJson.peerDependencies,
    peerDependenciesMeta: packageJson.peerDependenciesMeta
  },
  runtimeExports: Object.fromEntries(Object.entries(modules).map(([specifier, module]) => [specifier, Object.keys(module).sort()])),
  errors,
  httpMapping,
  presets,
  warningCodes,
  metricNames: otel.LAZPHO_OTEL_METRIC_NAMES,
  numericMappings: {
    lifecycle: Object.fromEntries(['running', 'draining', 'closed'].map((state) => [state, otel.lifecycleValue(state)])),
    breaker: Object.fromEntries(['closed', 'open', 'half_open'].map((state) => [state, otel.breakerValue(state)]))
  }
})));
const publicTypes = sortObject(await declarationClosure(entries));

if (mode === 'update') {
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(typesPath, `${JSON.stringify(publicTypes, null, 2)}\n`);
  console.log('Updated api/public-api.json and api/public-types.json. Review and classify the API change before committing.');
} else {
  const expectedContract = JSON.parse(await readFile(contractPath, 'utf8'));
  const expectedTypes = JSON.parse(await readFile(typesPath, 'utf8'));
  const differences = structuredDifferences(expectedContract, contract);
  const typeDifferences = declarationDifferences(expectedTypes, publicTypes);
  if (differences.length || typeDifferences.length) {
    console.error('Public API changed:');
    for (const difference of [...differences, ...typeDifferences]) console.error(difference);
    console.error('\nReview the semver impact, then run npm run api:update to accept the contract intentionally.');
    process.exitCode = 1;
  } else {
    console.log(`Public API contract matches ${Object.keys(entries).length} subpaths and ${Object.keys(publicTypes).length} declaration files.`);
  }
}

async function declarationClosure(publicEntries) {
  const pending = Object.values(publicEntries).map(({ types }) => resolve(root, types));
  const seen = new Set();
  const output = {};
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = normalizeText(await readFile(path, 'utf8'));
    output[relative(root, path).replaceAll('\\', '/')] = text;
    const importPattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;
    for (const match of text.matchAll(importPattern)) {
      const dependency = resolve(dirname(path), match[1].replace(/\.js$/, '.d.ts'));
      if (dependency.startsWith(resolve(root, 'dist'))) pending.push(dependency);
    }
  }
  return output;
}

function normalizeText(value) {
  return `${value.replaceAll('\r\n', '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim()}\n`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function structuredDifferences(expected, actual) {
  const before = flatten(expected);
  const after = flatten(actual);
  const differences = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(key)) differences.push(`ADDED: ${key} = ${after.get(key)}`);
    else if (!after.has(key)) differences.push(`REMOVED: ${key} = ${before.get(key)}`);
    else if (before.get(key) !== after.get(key)) differences.push(`CHANGED: ${key}: ${before.get(key)} -> ${after.get(key)}`);
  }
  return differences;
}

function declarationDifferences(expected, actual) {
  const differences = [];
  for (const file of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (!(file in expected)) differences.push(`ADDED TYPE FILE: ${file}`);
    else if (!(file in actual)) differences.push(`REMOVED TYPE FILE: ${file}`);
    else if (expected[file] !== actual[file]) {
      const before = expected[file].split('\n');
      const after = actual[file].split('\n');
      const line = Math.max(0, before.findIndex((value, index) => value !== after[index]));
      differences.push(`CHANGED TYPE: ${file}:${line + 1}\n  before: ${before[line] ?? '<end>'}\n  after:  ${after[line] ?? '<end>'}`);
    }
  }
  return differences;
}

function flatten(value, path = '', output = new Map()) {
  if (!value || typeof value !== 'object') output.set(path, JSON.stringify(value));
  else if (Array.isArray(value)) value.forEach((entry, index) => flatten(entry, `${path}[${index}]`, output));
  else Object.keys(value).forEach((key) => flatten(value[key], path ? `${path}.${key}` : key, output));
  return output;
}
