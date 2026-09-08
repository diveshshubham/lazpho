import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018';
const requestCount = positiveInteger(process.env.COMPARE_REQUESTS, 100);
const concurrency = positiveInteger(process.env.COMPARE_CONCURRENCY, 50);
const latencyMs = nonNegativeInteger(process.env.COMPARE_DB_LATENCY_MS, 100);
const targetRps = nonNegativeInteger(process.env.COMPARE_TARGET_RPS, 0);
const durationMs = positiveInteger(process.env.COMPARE_DURATION_MS, 1_000);
const maxRequestsPerEndpoint = positiveInteger(process.env.COMPARE_MAX_REQUESTS, 10_000);
const runId = `${Date.now()}_${process.pid}`;
const results = [];
const modeMetrics = {};
const exampleRoot = fileURLToPath(new URL('..', import.meta.url));

for (const mode of ['direct', 'lazpho']) {
  const port = mode === 'direct' ? 3101 : 3102;
  const databaseName = `lazpho_feedback_compare_${runId}_${mode}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer({ mode, port, databaseName });

  try {
    await waitForServer(baseUrl, child);
    const seed = await requestJson(`${baseUrl}/api/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${mode} benchmark seed`, description: 'Temporary benchmark data' })
    });

    results.push(await runLoad(mode, 'GET /api/ideas', concurrency,
      () => fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(10_000) })));
    results.push(await runLoad(mode, 'GET /api/metrics', concurrency,
      () => fetch(`${baseUrl}/api/metrics`, { signal: AbortSignal.timeout(10_000) })));
    results.push(await runLoad(mode, 'POST /api/ideas', concurrency,
      (index) => fetch(`${baseUrl}/api/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Benchmark idea ${index}`, description: mode }),
        signal: AbortSignal.timeout(10_000)
      })));
    results.push(await runLoad(mode, 'POST /api/ideas/:id/vote', concurrency,
      () => fetch(`${baseUrl}/api/ideas/${seed._id}/vote`, {
        method: 'POST', signal: AbortSignal.timeout(10_000)
      })));
    results.push(await runLoad(mode, 'PATCH /api/ideas/:id/status', concurrency,
      (index) => fetch(`${baseUrl}/api/ideas/${seed._id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: index % 2 ? 'building' : 'planned' }),
        signal: AbortSignal.timeout(10_000)
      })));
    modeMetrics[mode] = await requestJson(`${baseUrl}/api/metrics`);
  } finally {
    await stopServer(child);
    await dropTemporaryDatabase(databaseName);
  }
}

console.log(targetRps
  ? `\nA/B comparison: target ${targetRps.toLocaleString()} RPS for ${durationMs} ms/endpoint, max in-flight ${concurrency}, safety cap ${maxRequestsPerEndpoint.toLocaleString()}, simulated DB latency ${latencyMs} ms`
  : `\nA/B comparison: ${requestCount} requests/endpoint, concurrency ${concurrency}, simulated DB latency ${latencyMs} ms`);
console.table(results);
const report = buildReport();
const reportDirectory = resolve(process.env.COMPARE_REPORT_DIRECTORY || resolve(exampleRoot, 'load-reports'));
await mkdir(reportDirectory, { recursive: true });
const requestedReportName = process.env.COMPARE_REPORT_NAME;
const reportName = requestedReportName && /^[a-zA-Z0-9_-]+$/.test(requestedReportName)
  ? requestedReportName
  : `comparison-${runId}`;
const reportBase = resolve(reportDirectory, reportName);
await Promise.all([
  writeFile(`${reportBase}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(`${reportBase}.html`, renderReport(report), 'utf8')
]);
console.log(`Combined report: ${reportBase}.html`);
console.log(`COMPARE_REPORT_JSON=${reportBase}.json`);
console.log('Temporary benchmark databases were removed. Results are machine-specific; compare the two modes, not absolute numbers.');

function startServer({ mode, port, databaseName }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: mongoUri,
      MONGODB_DATABASE: databaseName,
      USE_LAZPHO: String(mode === 'lazpho'),
      SIMULATED_DB_LATENCY_MS: String(latencyMs),
      LOAD_LAB: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  const remember = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-4_000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.diagnostics = () => diagnostics.trim();
  return child;
}

async function waitForServer(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup with code ${child.exitCode}.${child.diagnostics?.() ? `\n${child.diagnostics()}` : ''}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/metrics`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${lastError?.message || 'timeout'}${child.diagnostics?.() ? `\n${child.diagnostics()}` : ''}`);
}

async function runLoad(mode, endpoint, workerCount, makeRequest) {
  if (targetRps > 0) return runRateLoad(mode, endpoint, workerCount, makeRequest);
  const count = requestCount;
  let cursor = 0;
  const samples = [];
  const statuses = new Map();
  const startedAt = performance.now();

  async function worker() {
    while (cursor < count) {
      const index = cursor++;
      const requestStartedAt = performance.now();
      try {
        const response = await makeRequest(index);
        await response.arrayBuffer();
        samples.push(performance.now() - requestStartedAt);
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      } catch {
        samples.push(performance.now() - requestStartedAt);
        statuses.set('network', (statuses.get('network') || 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(workerCount, count) }, worker));
  const elapsedMs = performance.now() - startedAt;
  const successes = [...statuses].reduce((total, [status, value]) =>
    typeof status === 'number' && status >= 200 && status < 300 ? total + value : total, 0);

  return {
    mode,
    endpoint,
    '2xx': successes,
    '503': statuses.get(503) || 0,
    '504': statuses.get(504) || 0,
    network: statuses.get('network') || 0,
    other: count - successes - (statuses.get(503) || 0) - (statuses.get(504) || 0) - (statuses.get('network') || 0),
    'p95 ms': Number(percentile(samples, 0.95).toFixed(1)),
    'req/s': Number((count / (elapsedMs / 1_000)).toFixed(1)),
    requestedRps: null,
    scheduled: count,
    generatorLimited: 0,
    safetyCapped: 0
  };
}

async function runRateLoad(mode, endpoint, maxInFlight, makeRequest) {
  const nominalRequests = Math.ceil(targetRps * durationMs / 1_000);
  const safetyLimit = Math.min(nominalRequests, maxRequestsPerEndpoint);
  const statuses = new Map();
  const samples = [];
  const pending = new Set();
  let scheduled = 0;
  const startedAt = performance.now();

  const launch = (index) => {
    const requestStartedAt = performance.now();
    const task = Promise.resolve(makeRequest(index)).then(async (response) => {
      await response.arrayBuffer();
      samples.push(performance.now() - requestStartedAt);
      statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
    }).catch(() => {
      samples.push(performance.now() - requestStartedAt);
      statuses.set('network', (statuses.get('network') || 0) + 1);
    }).finally(() => pending.delete(task));
    pending.add(task);
  };

  while (performance.now() - startedAt < durationMs && scheduled < safetyLimit) {
    const elapsedMs = performance.now() - startedAt;
    const due = Math.min(safetyLimit, Math.floor(targetRps * elapsedMs / 1_000) + 1);
    while (scheduled < due && pending.size < maxInFlight) launch(scheduled++);
    if (scheduled < due && pending.size >= maxInFlight) {
      await Promise.race(pending);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await Promise.all(pending);
  const elapsedMs = performance.now() - startedAt;
  const successes = [...statuses].reduce((total, [status, value]) =>
    typeof status === 'number' && status >= 200 && status < 300 ? total + value : total, 0);
  const rejected = statuses.get(503) || 0;
  const timedOut = statuses.get(504) || 0;
  const network = statuses.get('network') || 0;

  return {
    mode,
    endpoint,
    '2xx': successes,
    '503': rejected,
    '504': timedOut,
    network,
    other: scheduled - successes - rejected - timedOut - network,
    'p95 ms': Number(percentile(samples, 0.95).toFixed(1)),
    'req/s': Number((scheduled / (elapsedMs / 1_000)).toFixed(1)),
    requestedRps: targetRps,
    scheduled,
    generatorLimited: Math.max(0, safetyLimit - scheduled),
    safetyCapped: Math.max(0, nominalRequests - safetyLimit)
  };
}

function buildReport() {
  const direct = summarize('direct');
  const lazpho = summarize('lazpho');
  const controller = modeMetrics.lazpho?.controllers?.mongodb;
  const directPeak = modeMetrics.direct?.directDatabasePeakActive || 0;
  const findings = [
    `The direct application allowed ${directPeak} simultaneous database operations at the observed peak.`,
    controller
      ? `Lazpho enforced a database concurrency limit of ${controller.limit} and a bounded queue of ${controller.maxQueueSize}.`
      : 'Lazpho controller metrics were unavailable.',
    controller?.rejected
      ? `Lazpho deliberately shed ${controller.rejected} operations when bounded capacity was exhausted.`
      : 'This run did not exhaust Lazpho capacity, so it demonstrates healthy-path behavior only.',
    'Rejections during overload are protective behavior; compare useful completions, tail latency, resource bounds, and recovery—not success count alone.',
    targetRps > 0 && results.some((result) => result.generatorLimited > 0 || result.safetyCapped > 0)
      ? 'At least one endpoint did not schedule the full nominal workload. Requested RPS is therefore a test input, not an achieved-throughput claim.'
      : 'The configured workload was fully scheduled; completed throughput can still be lower while requests drain.',
    'These results describe this machine and workload only. They are not universal throughput guarantees.'
  ];
  return {
    id: `comparison-${runId}`,
    generatedAt: new Date().toISOString(),
    configuration: {
      mode: targetRps > 0 ? 'fixed-rate' : 'fixed-count',
      requestsPerEndpoint: targetRps > 0 ? null : requestCount,
      targetRps: targetRps || null,
      durationMs: targetRps > 0 ? durationMs : null,
      maxRequestsPerEndpoint: targetRps > 0 ? maxRequestsPerEndpoint : null,
      maxInFlight: concurrency,
      simulatedDatabaseLatencyMs: latencyMs,
      endpointCount: 5
    },
    summary: { direct, lazpho },
    controller: controller ? {
      limit: controller.limit,
      maxQueueSize: controller.maxQueueSize,
      completed: controller.completed,
      rejected: controller.rejected,
      timedOut: controller.timedOut,
      queueWaitP95Ms: controller.queueWait.p95Ms,
      executionP95Ms: controller.execution.p95Ms
    } : null,
    process: {
      direct: modeMetrics.direct?.process || null,
      lazpho: modeMetrics.lazpho?.process || null
    },
    directDatabasePeakActive: directPeak,
    findings,
    endpoints: results
  };
}

function summarize(mode) {
  const selected = results.filter((result) => result.mode === mode);
  return {
    attempted: selected.reduce((total, result) => total + result.scheduled, 0),
    nominalRequested: selected.reduce((total, result) => total + result.scheduled + result.generatorLimited + result.safetyCapped, 0),
    generatorLimited: selected.reduce((total, result) => total + result.generatorLimited, 0),
    safetyCapped: selected.reduce((total, result) => total + result.safetyCapped, 0),
    successful: selected.reduce((total, result) => total + result['2xx'], 0),
    rejected503: selected.reduce((total, result) => total + result['503'], 0),
    timedOut504: selected.reduce((total, result) => total + result['504'], 0),
    networkErrors: selected.reduce((total, result) => total + result.network, 0),
    worstEndpointP95Ms: Math.max(...selected.map((result) => result['p95 ms'])),
    averageEndpointRps: Number((selected.reduce((total, result) => total + result['req/s'], 0) / selected.length).toFixed(1))
  };
}

function renderReport(report) {
  const summaryCards = Object.entries(report.summary).map(([mode, value]) => `<section class="mode"><h2>${escapeHtml(mode)}</h2><div class="grid">${[
    ['Scheduled', value.attempted], ['Successful', value.successful], ['503 shed', value.rejected503], ['504 timeout', value.timedOut504],
    ['Generator-limited', value.generatorLimited], ['Safety-capped', value.safetyCapped],
    ['Worst P95', `${value.worstEndpointP95Ms} ms`], ['Average endpoint RPS', value.averageEndpointRps]
  ].map(([label, metric]) => `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(metric)}</strong></div>`).join('')}</div></section>`).join('');
  const rows = report.endpoints.map((result) => `<tr><td>${escapeHtml(result.endpoint)}</td><td>${escapeHtml(result.mode)}</td><td>${result.scheduled}</td><td>${result['2xx']}</td><td>${result['503']}</td><td>${result['504']}</td><td>${result.generatorLimited}</td><td>${result.safetyCapped}</td><td>${result['p95 ms']} ms</td><td>${result['req/s']}</td></tr>`).join('');
  const findings = report.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalboard Lazpho comparison</title><style>:root{font-family:system-ui;color:#17201d;background:#f4f7f3}body{max-width:1200px;margin:40px auto;padding:0 20px}h1{font-size:36px}.mode,.findings,.details{background:#fff;border:1px solid #dce4df;border-radius:14px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.card{background:#eef8f3;padding:12px;border-radius:9px}.card span{display:block;color:#617069}.card strong{font-size:22px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.warning{color:#8a4b00}</style></head><body><h1>Signalboard: direct vs Lazpho</h1><p>Identical temporary databases, payloads, workload settings, and simulated dependency latency.</p>${summaryCards}<section class="findings"><h2>What this demonstrates</h2><ul>${findings}</ul></section><section class="details"><h2>Endpoint results</h2><div style="overflow:auto"><table><thead><tr><th>Endpoint</th><th>Mode</th><th>Scheduled</th><th>2xx</th><th>503</th><th>504</th><th>Generator-limited</th><th>Safety-capped</th><th>P95</th><th>Completed RPS</th></tr></thead><tbody>${rows}</tbody></table></div></section><p class="warning">Requested RPS is an input. Use scheduled work, generator limits, and completed RPS to determine what this machine actually exercised.</p></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character);
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`Seed request failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function dropTemporaryDatabase(databaseName) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  try { await client.db(databaseName).dropDatabase(); }
  finally { await client.close(); }
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
