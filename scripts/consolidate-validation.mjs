import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const sagavoyaPath = path.resolve(
  repositoryRoot,
  process.env.SAGAVOYA_VALIDATION_REPORT || 'artifacts/sagavoya-corrected-gate/latest.json',
);
const faultDirectory = path.resolve(
  repositoryRoot,
  process.env.MONGODB_FAULT_REPORT_DIRECTORY || 'examples/feedback-board/load-reports',
);
const outputDirectory = path.resolve(
  repositoryRoot,
  process.env.VALIDATION_REPORT_DIRECTORY || 'artifacts/release-validation',
);

const sagavoya = JSON.parse(await readFile(sagavoyaPath, 'utf8'));
const faultPath = await latestFaultReport(faultDirectory);
const fault = JSON.parse(await readFile(faultPath, 'utf8'));
const lazphoFault = fault.modes.find(({ mode }) => mode === 'lazpho');
const directFault = fault.modes.find(({ mode }) => mode === 'direct');
assert.ok(lazphoFault && directFault, 'Fault report must contain direct and Lazpho modes.');

const sagavoyaRuns = sagavoya.runs ?? sagavoya.soak?.runs;
assert.ok(Array.isArray(sagavoyaRuns), 'Sagavoya report must contain runs or soak.runs.');
const soak = Object.fromEntries(sagavoyaRuns.map((run) => [run.label, run]));
for (const phase of ['steady', 'capacity', 'overload', 'recovery']) {
  assert.ok(soak[phase], `Sagavoya report is missing the ${phase} phase.`);
}

const checks = [
  check('Sagavoya steady success >= 99%', soak.steady.successRatePercent >= 99, `${soak.steady.successRatePercent}%`),
  check('Sagavoya steady successful p95 <= 500 ms', soak.steady.successfulLatencyMs.p95 <= 500, `${soak.steady.successfulLatencyMs.p95} ms`),
  check('Sagavoya capacity success >= 99%', soak.capacity.successRatePercent >= 99, `${soak.capacity.successRatePercent}%`),
  check('Sagavoya capacity successful p95 <= 500 ms', soak.capacity.successfulLatencyMs.p95 <= 500, `${soak.capacity.successfulLatencyMs.p95} ms`),
  check('Sagavoya overload successful p95 <= 500 ms', soak.overload.successfulLatencyMs.p95 <= 500, `${soak.overload.successfulLatencyMs.p95} ms`),
  check('Sagavoya recovery success >= 99%', soak.recovery.successRatePercent >= 99, `${soak.recovery.successRatePercent}%`),
  check(
    'Sagavoya controllers drain after every phase',
    sagavoyaRuns.every((run) => !run.finalControllers || Object.values(run.finalControllers).every(({ active, queued }) => active === 0 && queued === 0)),
    sagavoyaRuns.map((run) => `${run.label}:${Object.values(run.finalControllers ?? {}).map(({ active, queued }) => `${active}/${queued}`).join(',') || 'legacy'}`).join('; '),
  ),
  check('MongoDB healthy traffic succeeds', directFault.phases.healthy.successful > 0 && lazphoFault.phases.healthy.successful > 0, `${directFault.phases.healthy.successful}/${lazphoFault.phases.healthy.successful}`),
  check('MongoDB outage is visible', directFault.phases.outage.failed > 0 && lazphoFault.phases.outage.failed > 0, `${directFault.phases.outage.failed}/${lazphoFault.phases.outage.failed}`),
  check('MongoDB traffic recovers', directFault.phases.recovery.successful > 0 && lazphoFault.phases.recovery.successful > 0, `${directFault.phases.recovery.successful}/${lazphoFault.phases.recovery.successful}`),
  check('MongoDB controller stays within limit', lazphoFault.observed.controllerLimitViolations === 0, `${lazphoFault.observed.controllerLimitViolations} violation(s)`),
  check('MongoDB controller drains', lazphoFault.metrics.controllers.mongodb.active === 0 && lazphoFault.metrics.controllers.mongodb.queued === 0, `active=${lazphoFault.metrics.controllers.mongodb.active}, queued=${lazphoFault.metrics.controllers.mongodb.queued}`),
  check('MongoDB breaker recovers closed', lazphoFault.metrics.controllers.mongodb.circuitBreaker.state === 'closed' && lazphoFault.metrics.controllers.mongodb.circuitBreaker.breakerTrips > 0, `${lazphoFault.metrics.controllers.mongodb.circuitBreaker.breakerTrips} trip(s), ${lazphoFault.metrics.controllers.mongodb.circuitBreaker.state}`),
];

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: checks.every(({ passed }) => passed) ? 'READY' : 'NOT_READY',
  sources: {
    sagavoya: path.relative(repositoryRoot, sagavoyaPath).replaceAll('\\', '/'),
    mongodbFault: path.relative(repositoryRoot, faultPath).replaceAll('\\', '/'),
  },
  recommendation: sagavoya.recommendation,
  sagavoyaSoak: sagavoyaRuns.map(({ label, requestedRps, durationSeconds, attempted, successful, successRatePercent, successfulPerSecond, successfulLatencyMs, statusCodes, sampledControllerPeaks, sampledMemoryPeaks }) => ({
    label,
    requestedRps,
    durationSeconds,
    attempted,
    successful,
    successRatePercent,
    successfulPerSecond,
    p95Ms: successfulLatencyMs.p95,
    statusCodes,
    sampledControllerPeaks,
    sampledMemoryPeaks,
  })),
  mongodbFault: {
    id: fault.id,
    direct: directFault.phases,
    lazpho: lazphoFault.phases,
    observed: lazphoFault.observed,
    controller: {
      limit: lazphoFault.metrics.controllers.mongodb.limit,
      active: lazphoFault.metrics.controllers.mongodb.active,
      queued: lazphoFault.metrics.controllers.mongodb.queued,
      breaker: lazphoFault.metrics.controllers.mongodb.circuitBreaker,
    },
  },
  checks,
  limitations: [
    'These are local single-machine integration results, not production capacity or million-RPS certification.',
    'Successful latency excludes controlled 503/504 outcomes, which are not successful business operations.',
    'Sagavoya operational metrics bypassed application admission, and per-request logging was disabled for the corrected load measurement.',
    'The MongoDB proxy validates transport pressure and recovery, not replica-set correctness or consistency.',
  ],
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(path.join(outputDirectory, 'latest.html'), renderHtml(report), 'utf8'),
]);
console.log(`Validation report: ${report.status}`);
console.table(checks);
console.log(`Reports written to ${outputDirectory}`);
if (report.status !== 'READY') process.exitCode = 1;

function check(name, passed, observed) {
  return { name, passed, observed };
}

async function latestFaultReport(directory) {
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!/^fault-.*\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    candidates.push({ file, modified: (await stat(file)).mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  assert.ok(candidates.length > 0, `No MongoDB fault JSON report found in ${directory}.`);
  return candidates[0].file;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderHtml(value) {
  const checkRows = value.checks.map(({ name, passed, observed }) =>
    `<tr><td>${escapeHtml(name)}</td><td class="${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(observed)}</td></tr>`,
  ).join('');
  const soakRows = value.sagavoyaSoak.map((phase) =>
    `<tr><td>${escapeHtml(phase.label)}</td><td>${phase.requestedRps}</td><td>${phase.durationSeconds}</td><td>${phase.successful}/${phase.attempted}</td><td>${phase.successRatePercent}%</td><td>${phase.p95Ms} ms</td><td>${escapeHtml(JSON.stringify(phase.statusCodes))}</td></tr>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lazpho release validation</title><style>body{font:14px system-ui;max-width:1150px;margin:2rem auto;padding:0 1rem;color:#172033}h1,h2{color:#0c4a6e}.status{font-size:1.4rem;font-weight:700}.pass{color:#15803d;font-weight:700}.fail{color:#b91c1c;font-weight:700}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #cbd5e1;padding:.55rem;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#e2e8f0}.note{background:#fff7ed;border:1px solid #fed7aa;padding:1rem;border-radius:.6rem}</style></head><body><h1>Lazpho consolidated release validation</h1><p class="status ${value.status === 'READY' ? 'pass' : 'fail'}">${value.status}</p><p>Generated ${escapeHtml(value.generatedAt)}</p><h2>Acceptance checks</h2><table><thead><tr><th>Check</th><th>Status</th><th>Observed</th></tr></thead><tbody>${checkRows}</tbody></table><h2>Sagavoya authenticated soak</h2><table><thead><tr><th>Phase</th><th>RPS</th><th>Seconds</th><th>Successful</th><th>Rate</th><th>Successful p95</th><th>Statuses</th></tr></thead><tbody>${soakRows}</tbody></table><h2>MongoDB transport recovery</h2><p>Controller limit ${value.mongodbFault.controller.limit}; peak sampled active ${value.mongodbFault.observed.peakControllerActive}; limit violations ${value.mongodbFault.observed.controllerLimitViolations}; breaker trips ${value.mongodbFault.controller.breaker.breakerTrips}; final breaker ${value.mongodbFault.controller.breaker.state}; final active/queued ${value.mongodbFault.controller.active}/${value.mongodbFault.controller.queued}.</p><div class="note"><strong>Interpretation:</strong><ul>${value.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></body></html>`;
}
