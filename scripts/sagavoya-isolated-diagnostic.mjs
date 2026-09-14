import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const baseUrl = (process.env.SAGAVOYA_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const requestedRps = positiveInteger(process.env.SAGAVOYA_DIAGNOSTIC_RPS || '50', 'SAGAVOYA_DIAGNOSTIC_RPS');
const durationSeconds = positiveInteger(
  process.env.SAGAVOYA_DIAGNOSTIC_SECONDS || '120',
  'SAGAVOYA_DIAGNOSTIC_SECONDS',
);
const phases = parsePhases(process.env.SAGAVOYA_DIAGNOSTIC_PHASES) || [
  { label: 'diagnostic', requestedRps, durationSeconds },
];
const outputDirectory = process.env.SAGAVOYA_DIAGNOSTIC_OUTPUT ||
  'artifacts/sagavoya-isolated-diagnostic';

const credentials = await readCredentials();
const auth = await requestJson(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials),
});
assert.equal(auth.response.status, 200, `Login failed with HTTP ${auth.response.status}.`);
assert.equal(typeof auth.body?.accessToken, 'string', 'Login response did not contain an access token.');

const headers = { authorization: `Bearer ${auth.body.accessToken}` };
await warmUp(headers);
const runs = [];
for (const phase of phases) {
  const before = await metrics(headers);
  const result = await runOpenLoop(headers, phase.requestedRps, phase.durationSeconds);
  const after = await metrics(headers);
  runs.push({
    ...phase,
    ...result,
    controllerDeltas: {
      http: controllerDelta(before.lazpho?.http, after.lazpho?.http),
      mongodb: controllerDelta(before.lazpho?.mongodb, after.lazpho?.mongodb),
    },
    finalControllers: {
      http: controllerState(after.lazpho?.http),
      mongodb: controllerState(after.lazpho?.mongodb),
    },
    finalMongoPool: after.mongoPool ?? null,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  target: `${baseUrl}/api/users/me`,
  authentication: 'Bearer token held in memory only',
  runs,
  interpretation:
    'This isolated run starts after warm-up and does not include metrics sampling in Lazpho HTTP admission. ' +
    'Run the application with HTTP_REQUEST_LOGGING_ENABLED=false to remove per-request log I/O from the measurement.',
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(`${outputDirectory}/latest.json`, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(`${outputDirectory}/latest.html`, renderHtml(report)),
]);

console.log(JSON.stringify(report, null, 2));

async function readCredentials() {
  if (process.env.SAGAVOYA_TEST_EMAIL && process.env.SAGAVOYA_TEST_PASSWORD) {
    return {
      email: process.env.SAGAVOYA_TEST_EMAIL,
      password: process.env.SAGAVOYA_TEST_PASSWORD,
    };
  }

  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    assert.ok(input.trim(), 'Provide credentials through environment variables or JSON stdin.');
    const parsed = JSON.parse(input);
    assert.equal(typeof parsed.email, 'string', 'Credential input requires an email string.');
    assert.equal(typeof parsed.password, 'string', 'Credential input requires a password string.');
    return { email: parsed.email, password: parsed.password };
  }

  throw new Error(
    'Set SAGAVOYA_TEST_EMAIL and SAGAVOYA_TEST_PASSWORD; interactive password entry is intentionally disabled to prevent terminal echo.',
  );
}

async function warmUp(headers) {
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`${baseUrl}/api/users/me`, { headers });
    assert.equal(response.status, 200, `Warm-up failed with HTTP ${response.status}.`);
    await response.arrayBuffer();
  }
}

async function runOpenLoop(headers, phaseRps, phaseDurationSeconds) {
  const total = phaseRps * phaseDurationSeconds;
  const startedAt = performance.now();
  const successes = [];
  const allLatencies = [];
  const statuses = {};
  let peakInFlight = 0;
  let inFlight = 0;
  const pending = new Set();
  const diagnosticSamples = [];
  let sampling = true;
  let samplingFailures = 0;
  const sampler = (async () => {
    while (sampling) {
      await sleep(1_000);
      if (!sampling) break;
      try {
        diagnosticSamples.push(await metrics(headers));
      } catch {
        samplingFailures += 1;
      }
    }
  })();

  for (let index = 0; index < total; index += 1) {
    const dueAt = startedAt + (index * 1_000) / phaseRps;
    const delay = dueAt - performance.now();
    if (delay > 0) await sleep(delay);

    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const task = issue(headers)
      .then(({ status, latencyMs }) => {
        statuses[status] = (statuses[status] || 0) + 1;
        allLatencies.push(latencyMs);
        if (status >= 200 && status < 300) successes.push(latencyMs);
      })
      .catch(() => {
        statuses.network = (statuses.network || 0) + 1;
      })
      .finally(() => {
        inFlight -= 1;
        pending.delete(task);
      });
    pending.add(task);
  }

  await Promise.all(pending);
  const workloadEndedAt = performance.now();
  sampling = false;
  await sampler;
  const wallDurationMs = workloadEndedAt - startedAt;
  const successful = successes.length;
  return {
    attempted: total,
    successful,
    failed: total - successful,
    successRatePercent: round((successful / total) * 100),
    attemptedPerSecond: round(total / (wallDurationMs / 1_000)),
    successfulPerSecond: round(successful / (wallDurationMs / 1_000)),
    wallDurationMs: round(wallDurationMs),
    peakGeneratorInFlight: peakInFlight,
    statusCodes: statuses,
    successfulLatencyMs: summarize(successes),
    allLatencyMs: summarize(allLatencies),
    diagnostics: summarizeDiagnostics(diagnosticSamples, samplingFailures),
  };
}

async function issue(headers) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/users/me`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  await response.arrayBuffer();
  return { status: response.status, latencyMs: performance.now() - startedAt };
}

async function metrics(headers) {
  const { response, body } = await requestJson(`${baseUrl}/api/metrics/summary`, { headers });
  assert.equal(response.status, 200, `Metrics request failed with HTTP ${response.status}.`);
  return body;
}

async function requestJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body };
}

function controllerDelta(before = {}, after = {}) {
  const keys = ['accepted', 'completed', 'rejected', 'bulkheadRejected', 'queueTimedOut'];
  return Object.fromEntries(keys.map((key) => [key, (after[key] || 0) - (before[key] || 0)]));
}

function controllerState(controller = {}) {
  return {
    active: controller.active ?? null,
    queued: controller.queued ?? null,
    limit: controller.limit ?? null,
    queueWaitMs: timingState(controller.queueWait),
    executionMs: timingState(controller.execution),
    totalMs: timingState(controller.total),
  };
}

function timingState(timing = {}) {
  return {
    average: round(timing.averageMs || 0),
    p50: round(timing.p50Ms || 0),
    p95: round(timing.p95Ms || 0),
    p99: round(timing.p99Ms || 0),
  };
}

function summarizeDiagnostics(samples, samplingFailures) {
  const eventLoop = samples.map((sample) => sample.lazpho?.application?.resources?.eventLoopLagMs || 0);
  return {
    samples: samples.length,
    samplingFailures,
    eventLoopLagMs: summarize(eventLoop),
    peaks: {
      httpActive: maximum(samples, (sample) => sample.lazpho?.http?.active),
      httpQueued: maximum(samples, (sample) => sample.lazpho?.http?.queued),
      httpExecutionP95Ms: maximum(samples, (sample) => sample.lazpho?.http?.execution?.p95Ms),
      httpQueueWaitP95Ms: maximum(samples, (sample) => sample.lazpho?.http?.queueWait?.p95Ms),
      mongoActive: maximum(samples, (sample) => sample.lazpho?.mongodb?.active),
      mongoQueued: maximum(samples, (sample) => sample.lazpho?.mongodb?.queued),
      mongoExecutionP95Ms: maximum(samples, (sample) => sample.lazpho?.mongodb?.execution?.p95Ms),
      mongoQueueWaitP95Ms: maximum(samples, (sample) => sample.lazpho?.mongodb?.queueWait?.p95Ms),
      mongoPoolCheckedOut: maximum(samples, (sample) => sample.mongoPool?.checkedOut),
    },
    finalMongoPool: samples.at(-1)?.mongoPool ?? null,
  };
}

function maximum(values, select) {
  return values.reduce((result, value) => Math.max(result, Number(select(value) || 0)), 0);
}

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round(sorted.at(-1)),
  };
}

function percentile(sorted, fraction) {
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  assert.ok(Number.isInteger(parsed) && parsed > 0, `${name} must be a positive integer.`);
  return parsed;
}

function parsePhases(value) {
  if (!value) return null;
  return value.split(',').map((entry, index) => {
    const [label, rps, seconds] = entry.split(':');
    assert.match(label || '', /^[a-z][a-z0-9-]*$/i, `Phase ${index + 1} requires a stable label.`);
    return {
      label,
      requestedRps: positiveInteger(rps, `Phase ${label} RPS`),
      durationSeconds: positiveInteger(seconds, `Phase ${label} duration`),
    };
  });
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function renderHtml(value) {
  const rows = value.runs
    .map((run) => `<tr><td>${escapeHtml(run.label)}</td><td>${run.requestedRps}</td><td>${run.attempted}</td><td>${run.successRatePercent}%</td><td>${run.successfulLatencyMs.p95}</td><td>${escapeHtml(JSON.stringify(run.statusCodes))}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sagavoya isolated diagnostic</title><style>body{font:14px system-ui;max-width:950px;margin:2rem auto;padding:0 1rem;color:#172033}h1,h2{color:#0c4a6e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:.55rem;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#e2e8f0}.note{margin-top:1rem;padding:1rem;background:#eff6ff;border:1px solid #bfdbfe}</style></head><body><h1>Sagavoya isolated authenticated diagnostic</h1><p>Generated ${escapeHtml(value.generatedAt)}</p><table><thead><tr><th>Phase</th><th>RPS</th><th>Attempted</th><th>Success</th><th>Successful P95 ms</th><th>Statuses</th></tr></thead><tbody>${rows}</tbody></table><h2>Controller evidence</h2><pre>${escapeHtml(JSON.stringify(value.runs.map(({ label, controllerDeltas, finalControllers }) => ({ label, controllerDeltas, finalControllers })), null, 2))}</pre><div class="note">${escapeHtml(value.interpretation)}</div></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
