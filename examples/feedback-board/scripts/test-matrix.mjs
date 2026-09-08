import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const reportDirectory = resolve(exampleRoot, process.env.MATRIX_REPORT_DIRECTORY || 'load-reports');
const targets = parseTargets(process.env.MATRIX_RPS || '10000,50000,100000,1000000');
const repetitions = positiveInteger(process.env.MATRIX_REPETITIONS, 3);
const durationMs = positiveInteger(process.env.MATRIX_DURATION_MS, 1_000);
const maxInFlight = positiveInteger(process.env.MATRIX_MAX_IN_FLIGHT, 256);
const maxRequests = positiveInteger(process.env.MATRIX_MAX_REQUESTS, 10_000);
const latencyMs = nonNegativeInteger(process.env.MATRIX_DB_LATENCY_MS, 100);
const matrixId = `matrix-${Date.now()}-${process.pid}`;
const runs = [];

await mkdir(reportDirectory, { recursive: true });
console.log(`Signalboard test matrix ${matrixId}`);
console.log(`${targets.map(formatNumber).join(', ')} requested RPS; ${repetitions} repetition(s); ${durationMs} ms/endpoint; max ${maxRequests.toLocaleString()} requests/endpoint.`);

for (const targetRps of targets) {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const reportName = `${matrixId}-${targetRps}-r${repetition}`;
    console.log(`\n[${runs.length + 1}/${targets.length * repetitions}] ${formatNumber(targetRps)} requested RPS, repetition ${repetition}`);
    await runComparison({ targetRps, repetition, reportName });
    const reportPath = resolve(reportDirectory, `${reportName}.json`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    runs.push({ targetRps, repetition, reportPath, report });
  }
}

const matrix = buildMatrixReport();
const reportBase = resolve(reportDirectory, matrixId);
await Promise.all([
  writeFile(`${reportBase}.json`, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8'),
  writeFile(`${reportBase}.html`, renderMatrixReport(matrix), 'utf8')
]);

console.log('\nMatrix summary');
console.table(matrix.scenarios.map((scenario) => ({
  'requested RPS': scenario.targetRps,
  runs: scenario.runs,
  'direct success': scenario.direct.medianSuccessful,
  'Lazpho success': scenario.lazpho.medianSuccessful,
  'Lazpho 503': scenario.lazpho.medianRejected503,
  'direct completed RPS': scenario.direct.medianEndpointRps,
  'Lazpho completed RPS': scenario.lazpho.medianEndpointRps,
  'direct worst p95 ms': scenario.direct.medianWorstP95Ms,
  'Lazpho worst p95 ms': scenario.lazpho.medianWorstP95Ms,
  'generator-limited': scenario.generatorLimited,
  'safety-capped': scenario.safetyCapped
})));
console.log(`Consolidated report: ${reportBase}.html`);
console.log('Requested RPS is never presented as achieved RPS. Review generator and safety limits before interpreting application behavior.');

function runComparison({ targetRps, reportName }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['scripts/compare.mjs'], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        COMPARE_TARGET_RPS: String(targetRps),
        COMPARE_DURATION_MS: String(durationMs),
        COMPARE_CONCURRENCY: String(maxInFlight),
        COMPARE_MAX_REQUESTS: String(maxRequests),
        COMPARE_DB_LATENCY_MS: String(latencyMs),
        COMPARE_REPORT_DIRECTORY: reportDirectory,
        COMPARE_REPORT_NAME: reportName
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostics = '';
    child.stdout.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000); });
    child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000); });
    child.on('error', rejectPromise);
    child.on('exit', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`Comparison exited with code ${code}.\n${diagnostics.trim()}`)));
  });
}

function buildMatrixReport() {
  const scenarios = targets.map((targetRps) => {
    const selected = runs.filter((run) => run.targetRps === targetRps);
    const summarizeMode = (mode) => ({
      medianAttempted: median(selected.map(({ report }) => report.summary[mode].attempted)),
      medianSuccessful: median(selected.map(({ report }) => report.summary[mode].successful)),
      medianRejected503: median(selected.map(({ report }) => report.summary[mode].rejected503)),
      medianTimedOut504: median(selected.map(({ report }) => report.summary[mode].timedOut504)),
      medianWorstP95Ms: median(selected.map(({ report }) => report.summary[mode].worstEndpointP95Ms)),
      medianEndpointRps: median(selected.map(({ report }) => report.summary[mode].averageEndpointRps)),
      medianPeakDatabaseConcurrency: mode === 'direct'
        ? median(selected.map(({ report }) => report.directDatabasePeakActive))
        : median(selected.map(({ report }) => report.controller?.limit || 0)),
      medianRssMiB: median(selected.map(({ report }) => (report.process?.[mode]?.rssBytes || 0) / 1024 / 1024)),
      medianHeapUsedMiB: median(selected.map(({ report }) => (report.process?.[mode]?.heapUsedBytes || 0) / 1024 / 1024)),
      medianCpuSeconds: median(selected.map(({ report }) => ((report.process?.[mode]?.cpuUserMicroseconds || 0) + (report.process?.[mode]?.cpuSystemMicroseconds || 0)) / 1_000_000))
    });
    return {
      targetRps,
      runs: selected.length,
      direct: summarizeMode('direct'),
      lazpho: summarizeMode('lazpho'),
      generatorLimited: selected.some(({ report }) => Object.values(report.summary).some((summary) => summary.generatorLimited > 0)),
      safetyCapped: selected.some(({ report }) => Object.values(report.summary).some((summary) => summary.safetyCapped > 0)),
      runReports: selected.map(({ repetition, reportPath }) => ({ repetition, reportPath }))
    };
  });
  return {
    id: matrixId,
    generatedAt: new Date().toISOString(),
    configuration: { targets, repetitions, durationMs, maxInFlight, maxRequestsPerEndpoint: maxRequests, simulatedDatabaseLatencyMs: latencyMs },
    interpretation: [
      'Each cell is the median of repeated, isolated A/B runs using the same endpoint payloads and dependency latency.',
      'Requested RPS is an input, not achieved throughput. Generator-limited means the local process could not schedule its safety-bounded workload in time.',
      'Safety-capped means the nominal request count exceeded the configured per-endpoint ceiling; that scenario does not prove the selected RPS.',
      'Lazpho 503 responses are deliberate overload shedding. Evaluate them together with useful completions, tail latency, bounded concurrency, and recovery.',
      'Results are machine- and workload-specific and are not universal production throughput guarantees.'
    ],
    scenarios
  };
}

function renderMatrixReport(report) {
  const rows = report.scenarios.map((scenario) => `<tr><td>${formatNumber(scenario.targetRps)}</td><td>${scenario.runs}</td><td>${scenario.direct.medianSuccessful}</td><td>${scenario.lazpho.medianSuccessful}</td><td>${scenario.lazpho.medianRejected503}</td><td>${scenario.direct.medianEndpointRps}</td><td>${scenario.lazpho.medianEndpointRps}</td><td>${scenario.direct.medianWorstP95Ms}</td><td>${scenario.lazpho.medianWorstP95Ms}</td><td>${scenario.direct.medianPeakDatabaseConcurrency}</td><td>${scenario.lazpho.medianPeakDatabaseConcurrency}</td><td>${scenario.direct.medianRssMiB}</td><td>${scenario.lazpho.medianRssMiB}</td><td>${scenario.direct.medianCpuSeconds}</td><td>${scenario.lazpho.medianCpuSeconds}</td><td>${scenario.generatorLimited ? 'yes' : 'no'}</td><td>${scenario.safetyCapped ? 'yes' : 'no'}</td></tr>`).join('');
  const notes = report.interpretation.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  const headers = ['Requested RPS', 'Runs', 'Direct 2xx', 'Lazpho 2xx', 'Lazpho 503', 'Direct completed RPS', 'Lazpho completed RPS', 'Direct worst P95 ms', 'Lazpho worst P95 ms', 'Direct DB peak', 'Lazpho limit', 'Direct RSS MiB', 'Lazpho RSS MiB', 'Direct CPU seconds', 'Lazpho CPU seconds', 'Generator limited', 'Safety capped']
    .map((header) => `<th>${header}</th>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalboard stress-test matrix</title><style>:root{font-family:system-ui;color:#17201d;background:#f4f7f3}body{max-width:1400px;margin:40px auto;padding:0 20px}section{background:#fff;border:1px solid #dce4df;border-radius:14px;padding:18px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #ddd}th{font-size:13px;color:#53615b}.warn{color:#8a4b00}</style></head><body><h1>Signalboard stress-test matrix</h1><p>Direct MongoDB access compared with Lazpho across repeated requested-rate scenarios. Every API is exercised sequentially at each rate in each mode.</p><section><h2>Configuration</h2><p>${report.configuration.repetitions} repetitions · ${report.configuration.durationMs} ms per endpoint · ${formatNumber(report.configuration.maxInFlight)} max in-flight · ${formatNumber(report.configuration.maxRequestsPerEndpoint)} request safety cap · ${report.configuration.simulatedDatabaseLatencyMs} ms simulated DB latency</p></section><section><h2>Median results</h2><div style="overflow:auto"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>How to read this</h2><ul>${notes}</ul></section><p class="warn">A selected rate is not a throughput claim unless the detailed run reports show it was scheduled and achieved without generator or safety limits.</p></body></html>`;
}

function parseTargets(value) {
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new Error('MATRIX_RPS must be a comma-separated list of positive integers.');
  }
  return [...new Set(parsed)];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(value.toFixed(1));
}

function formatNumber(value) { return Number(value).toLocaleString('en-US'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
