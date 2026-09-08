import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { startMongoFaultProxy } from './mongo-fault-proxy.mjs';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const upstreamUri = new URL(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018');
const upstreamHost = upstreamUri.hostname;
const upstreamPort = Number(upstreamUri.port || 27017);
const concurrency = boundedInteger(process.env.FAULT_CONCURRENCY, 32, 1, 128);
const batchRequests = boundedInteger(process.env.FAULT_BATCH_REQUESTS, 80, 10, 2_000);
const latencyMs = boundedInteger(process.env.FAULT_LATENCY_MS, 150, 1, 2_000);
const soakSeconds = boundedInteger(process.env.FAULT_SOAK_SECONDS, 20, 3, 300);
const reportDirectory = resolve(exampleRoot, process.env.FAULT_REPORT_DIRECTORY || 'load-reports');
const runId = `fault-${Date.now()}-${process.pid}`;
const proxy = await startMongoFaultProxy({ upstreamHost, upstreamPort });
const proxyUri = `mongodb://${proxy.host}:${proxy.port}/?directConnection=true&serverSelectionTimeoutMS=750&connectTimeoutMS=500&socketTimeoutMS=2500&heartbeatFrequencyMS=250`;
const modes = [];

try {
  for (const mode of ['direct', 'lazpho']) modes.push(await exerciseMode(mode));
} finally {
  proxy.recover();
  await proxy.close();
}

const direct = modes.find(({ mode }) => mode === 'direct');
const lazpho = modes.find(({ mode }) => mode === 'lazpho');
assert.ok(direct.phases.healthy.successful > 0 && lazpho.phases.healthy.successful > 0, 'Healthy requests must succeed in both modes.');
assert.ok(direct.phases.outage.failed > 0 && lazpho.phases.outage.failed > 0, 'The transport outage must be visible in both modes.');
assert.ok(direct.phases.recovery.successful > 0 && lazpho.phases.recovery.successful > 0, 'Both modes must recover after transport restoration.');
assert.ok(direct.metrics.directDatabasePeakActive > 8, 'Direct mode did not demonstrate dependency fan-out above Lazpho\'s limit.');
assert.equal(lazpho.observed.controllerLimitViolations, 0, 'Lazpho exceeded its configured MongoDB limit.');
assert.ok(lazpho.observed.peakControllerActive > 0, 'The metric sampler did not observe Lazpho database work.');
assert.equal(lazpho.metrics.controllers.mongodb.active, 0, 'Lazpho retained active work after the fault run.');
assert.equal(lazpho.metrics.controllers.mongodb.queued, 0, 'Lazpho retained queued work after the fault run.');
assert.ok(lazpho.metrics.controllers.mongodb.circuitBreaker.breakerTrips > 0, 'The MongoDB outage did not trip the Lazpho breaker.');
assert.equal(lazpho.metrics.controllers.mongodb.circuitBreaker.state, 'closed', 'The Lazpho breaker did not recover to closed.');

const report = {
  id: runId,
  generatedAt: new Date().toISOString(),
  configuration: { upstream: `${upstreamHost}:${upstreamPort}`, concurrency, batchRequests, injectedRoundTripLatencyMs: latencyMs * 2, soakSeconds },
  proxy: proxy.snapshot(),
  modes,
  findings: [
    `Direct mode reached ${direct.metrics.directDatabasePeakActive} simultaneous database operations; sampled Lazpho work peaked at ${lazpho.observed.peakControllerActive} and remained within its limit of ${lazpho.metrics.controllers.mongodb.limit}.`,
    `The transport outage produced ${direct.phases.outage.failed} direct-mode and ${lazpho.phases.outage.failed} Lazpho-mode failed HTTP requests, making the dependency failure observable.`,
    `After transport recovery, direct mode completed ${direct.phases.recovery.successful} successful requests and Lazpho completed ${lazpho.phases.recovery.successful}.`,
    `Lazpho recorded ${lazpho.metrics.controllers.mongodb.circuitBreaker.breakerTrips} breaker trip(s), ${lazpho.metrics.controllers.mongodb.rejected} capacity rejection(s), and ${lazpho.metrics.controllers.mongodb.timedOut} execution timeout(s).`,
    'The proxy cuts TCP connections to simulate transport loss and failover-style reconnect pressure; it does not emulate a MongoDB replica-set election or data consistency behavior.',
    'Results are machine- and workload-specific. Protective 503/504 responses are intentional outcomes and must not be hidden inside an aggregate success rate.'
  ]
};

await mkdir(reportDirectory, { recursive: true });
const reportBase = resolve(reportDirectory, runId);
await Promise.all([
  writeFile(`${reportBase}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(`${reportBase}.html`, renderReport(report), 'utf8')
]);
console.log('\nStage 3B MongoDB fault and recovery validation passed.');
console.table(modes.flatMap(({ mode, phases }) => Object.entries(phases).map(([phase, value]) => ({ mode, phase, ...value }))));
console.log(`Fault report: ${reportBase}.html`);

async function exerciseMode(mode) {
  proxy.recover();
  const port = mode === 'direct' ? 3121 : 3122;
  const databaseName = `lazpho_stage3b_${runId.replaceAll('-', '_')}_${mode}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer({ mode, port, databaseName });
  let sampler;
  try {
    await waitForServer(baseUrl, child);
    sampler = startMetricSampler(baseUrl);
    await request(`${baseUrl}/api/ideas`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} ${mode}`, description: 'Stage 3B temporary seed' })
    });
    const phases = {};
    phases.healthy = await runBatch(baseUrl, batchRequests, concurrency);
    proxy.setLatency(latencyMs);
    phases.latency = await runBatch(baseUrl, batchRequests, concurrency);
    proxy.disconnect();
    phases.outage = await runBatch(baseUrl, Math.max(10, Math.floor(batchRequests / 2)), concurrency);
    proxy.recover();
    await waitForRecovery(baseUrl);
    phases.recovery = await runBatch(baseUrl, batchRequests, concurrency);
    phases.mixedSoak = await runMixedSoak(baseUrl);
    proxy.recover();
    await waitForRecovery(baseUrl);
    const metrics = await getJson(`${baseUrl}/api/metrics`);
    const observed = await sampler.stop();
    sampler = undefined;
    return { mode, phases, metrics, observed };
  } finally {
    await sampler?.stop();
    proxy.recover();
    await stopServer(child);
    await dropTemporaryDatabase(databaseName);
  }
}

function startMetricSampler(baseUrl) {
  const observed = { peakDirectActive: 0, peakControllerActive: 0, peakControllerQueued: 0, controllerLimitViolations: 0, samples: 0 };
  let pending;
  const sample = async () => {
    try {
      const metrics = await getJson(`${baseUrl}/api/metrics`);
      observed.samples += 1;
      observed.peakDirectActive = Math.max(observed.peakDirectActive, metrics.directDatabaseActive || 0);
      const controller = metrics.controllers?.mongodb;
      if (controller) {
        observed.peakControllerActive = Math.max(observed.peakControllerActive, controller.active);
        observed.peakControllerQueued = Math.max(observed.peakControllerQueued, controller.queued);
        if (controller.active > controller.limit) observed.controllerLimitViolations += 1;
      }
    } catch { }
  };
  const timer = setInterval(() => { if (!pending) pending = sample().finally(() => { pending = undefined; }); }, 10);
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await sample();
      return Object.freeze({ ...observed });
    }
  };
}

function startServer({ mode, port, databaseName }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: exampleRoot,
    env: { ...process.env, PORT: String(port), MONGODB_URI: proxyUri, MONGODB_DATABASE: databaseName, USE_LAZPHO: String(mode === 'lazpho'), SIMULATED_DB_LATENCY_MS: '0', LOAD_LAB: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  const remember = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.diagnostics = () => diagnostics.trim();
  return child;
}

async function runBatch(baseUrl, count, workers) {
  let cursor = 0;
  const statuses = new Map();
  const latencies = [];
  const started = performance.now();
  async function worker() {
    while (cursor < count) {
      cursor += 1;
      const began = performance.now();
      try {
        const response = await fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(4_000) });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      } catch {
        statuses.set('network', (statuses.get('network') || 0) + 1);
      }
      latencies.push(performance.now() - began);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, count) }, worker));
  return summarize(statuses, latencies, performance.now() - started);
}

async function runMixedSoak(baseUrl) {
  const statuses = new Map();
  const latencies = [];
  let running = true;
  const started = performance.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (running) {
      const began = performance.now();
      try {
        const response = await fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(4_000) });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      } catch { statuses.set('network', (statuses.get('network') || 0) + 1); }
      latencies.push(performance.now() - began);
    }
  });
  const deadline = Date.now() + soakSeconds * 1_000;
  while (Date.now() < deadline) {
    proxy.recover();
    await delay(700);
    proxy.setLatency(latencyMs);
    await delay(700);
    proxy.disconnect();
    await delay(300);
  }
  proxy.recover();
  running = false;
  await Promise.all(workers);
  return summarize(statuses, latencies, performance.now() - started);
}

function summarize(statuses, latencies, durationMs) {
  const total = [...statuses.values()].reduce((sum, count) => sum + count, 0);
  const successful = [...statuses].reduce((sum, [status, count]) => typeof status === 'number' && status >= 200 && status < 300 ? sum + count : sum, 0);
  const failed = total - successful;
  return {
    attempted: total,
    successful,
    failed,
    rejected503: statuses.get(503) || 0,
    timedOut504: statuses.get(504) || 0,
    serverError500: statuses.get(500) || 0,
    networkErrors: statuses.get('network') || 0,
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    durationMs: Number(durationMs.toFixed(1))
  };
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup with code ${child.exitCode}.\n${child.diagnostics?.() || ''}`);
    try { if ((await fetch(`${baseUrl}/api/metrics`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { }
    await delay(100);
  }
  throw new Error(`Server did not become ready.\n${child.diagnostics?.() || ''}`);
}

async function waitForRecovery(baseUrl) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { }
    await delay(100);
  }
  throw new Error('Application did not recover after MongoDB transport restoration.');
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error(`Request failed with ${response.status}: ${await response.text()}`);
  return response;
}

async function getJson(url) {
  const response = await request(url);
  return response.json();
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function dropTemporaryDatabase(databaseName) {
  const client = new MongoClient(upstreamUri.href, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  try { await client.db(databaseName).dropDatabase(); }
  finally { await client.close(); }
}

function renderReport(value) {
  const rows = value.modes.flatMap(({ mode, phases }) => Object.entries(phases).map(([phase, result]) => `<tr><td>${mode}</td><td>${phase}</td><td>${result.attempted}</td><td>${result.successful}</td><td>${result.failed}</td><td>${result.rejected503}</td><td>${result.timedOut504}</td><td>${result.serverError500}</td><td>${result.p95Ms} ms</td></tr>`)).join('');
  const findings = value.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalboard Stage 3B fault report</title><style>body{max-width:1100px;margin:40px auto;padding:0 20px;color:#17201d;font:14px system-ui}section{border:1px solid #dce4df;border-radius:12px;padding:18px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.warn{color:#8a4b00}</style></head><body><h1>Signalboard Stage 3B fault report</h1><p>Controlled MongoDB transport latency, connection loss, recovery, and mixed-fault soak.</p><section><h2>Results</h2><table><thead><tr><th>Mode</th><th>Phase</th><th>Attempted</th><th>2xx</th><th>Failed</th><th>503</th><th>504</th><th>500</th><th>P95</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Interpretation</h2><ul>${findings}</ul></section><p class="warn">This is a bounded transport-fault experiment, not a MongoDB replica-set correctness or throughput certification.</p><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></body></html>`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
