import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const replicaUri = process.env.MONGODB_URI || 'mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&retryWrites=true&w=majority&readConcernLevel=majority';
const concurrency = boundedInteger(process.env.REPLICA_CONCURRENCY, 24, 2, 128);
const durationSeconds = boundedInteger(process.env.REPLICA_DURATION_SECONDS, 12, 5, 120);
const maxRequests = boundedInteger(process.env.REPLICA_MAX_REQUESTS, 3_000, 100, 50_000);
const reportDirectory = resolve(exampleRoot, process.env.REPLICA_REPORT_DIRECTORY || 'load-reports');
const runId = `replica-${Date.now()}-${process.pid}`;
const modes = [];

for (const mode of ['direct', 'lazpho']) modes.push(await exerciseMode(mode));

const direct = modes.find(({ mode }) => mode === 'direct');
const lazpho = modes.find(({ mode }) => mode === 'lazpho');
for (const result of modes) {
  assert.notEqual(result.topology.primaryBefore, result.topology.primaryAfter, `${result.mode} mode did not observe a primary change.`);
  assert.notEqual(result.topology.electionIdBefore, result.topology.electionIdAfter, `${result.mode} mode did not observe a new election ID.`);
  assert.ok(result.workload.successful > 0, `${result.mode} mode completed no requests during the election workload.`);
  assert.ok(result.workload.acknowledgedWrites > 0, `${result.mode} mode acknowledged no workload writes.`);
  assert.ok(result.postElectionReadOk, `${result.mode} mode did not recover reads after election.`);
  assert.equal(result.consistency.preElectionSentinelCopies, 3, `${result.mode} pre-election sentinel was not majority-visible on every member.`);
  assert.equal(result.consistency.postElectionSentinelCopies, 3, `${result.mode} post-election sentinel was not majority-visible on every member.`);
  assert.equal(result.consistency.missingAcknowledgedWrites, 0, `${result.mode} lost an acknowledged write.`);
  assert.equal(result.consistency.maximumCopiesPerTitle, 1, `${result.mode} produced a duplicate logical title.`);
}
assert.ok(direct.observed.peakDirectActive > 0, 'Direct-mode database activity was not observed.');
assert.equal(lazpho.observed.controllerLimitViolations, 0, 'Lazpho exceeded its configured MongoDB limit during election.');
assert.ok(lazpho.observed.peakControllerActive > 0, 'Lazpho controller activity was not observed.');
assert.equal(lazpho.metrics.controllers.mongodb.active, 0, 'Lazpho retained active work after election recovery.');
assert.equal(lazpho.metrics.controllers.mongodb.queued, 0, 'Lazpho retained queued work after election recovery.');
assert.equal(lazpho.metrics.controllers.mongodb.circuitBreaker.state, 'closed', 'Lazpho breaker did not close after election recovery.');

const report = {
  id: runId,
  generatedAt: new Date().toISOString(),
  configuration: { replicaUri: redactUri(replicaUri), concurrency, durationSeconds, maxRequests, writeConcern: 'majority', readConcern: 'majority' },
  modes,
  findings: [
    `Both modes observed a real primary change: ${direct.topology.primaryBefore} to ${direct.topology.primaryAfter} and ${lazpho.topology.primaryBefore} to ${lazpho.topology.primaryAfter}.`,
    `The election workloads completed ${direct.workload.successful} direct and ${lazpho.workload.successful} Lazpho HTTP operations; failures and protective outcomes remain visible in the phase table.`,
    'Pre- and post-election sentinel writes became majority-readable from all three members, and every HTTP 201 acknowledged by the application remained present exactly once.',
    `Sampled Lazpho database activity peaked at ${lazpho.observed.peakControllerActive} active and ${lazpho.observed.peakControllerQueued} queued operations with zero limit violations.`,
    'This validates one disposable three-member topology. It does not prove behavior under partitions, replication lag, rollback, regional loss, or every MongoDB deployment setting.'
  ]
};

await mkdir(reportDirectory, { recursive: true });
const reportBase = resolve(reportDirectory, runId);
await Promise.all([
  writeFile(`${reportBase}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(`${reportBase}.html`, renderReport(report), 'utf8')
]);
console.log('\nMongoDB replica-set election validation passed.');
console.table(modes.map(({ mode, topology, workload, consistency }) => ({
  mode,
  primaryBefore: topology.primaryBefore,
  primaryAfter: topology.primaryAfter,
  attempted: workload.attempted,
  successful: workload.successful,
  failed: workload.failed,
  p95Ms: workload.p95Ms,
  acknowledgedWrites: consistency.acknowledgedWrites,
  missingAcknowledgedWrites: consistency.missingAcknowledgedWrites
})));
console.log(`Replica-set report: ${reportBase}.html`);

async function exerciseMode(mode) {
  const databaseName = `lazpho_replica_${runId.replaceAll('-', '_')}_${mode}`;
  const port = mode === 'direct' ? 3131 : 3132;
  const baseUrl = `http://127.0.0.1:${port}`;
  const prefix = `${runId} ${mode}`;
  const child = startServer({ mode, port, databaseName });
  let sampler;
  try {
    await waitForServer(baseUrl, child);
    await waitForHealthyReplicaSet();
    const topologyBefore = await getPrimary();
    const preElection = await createIdea(baseUrl, `${prefix} sentinel before`);
    sampler = startMetricSampler(baseUrl);
    const workloadPromise = runElectionWorkload(baseUrl, prefix);
    await delay(750);
    await stepDownPrimary();
    const topologyAfter = await waitForChangedPrimary(topologyBefore.primary);
    const workload = await workloadPromise;
    await waitForApplicationRecovery(baseUrl);
    const postElection = await createIdea(baseUrl, `${prefix} sentinel after`);
    const postElectionReadOk = (await fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(5_000) })).ok;
    const metrics = await getJson(`${baseUrl}/api/metrics`);
    const observed = await sampler.stop();
    sampler = undefined;
    const consistency = await verifyConsistency({ databaseName, prefix, preElection, postElection, acknowledged: workload.acknowledged });
    return {
      mode,
      topology: {
        primaryBefore: topologyBefore.primary,
        primaryAfter: topologyAfter.primary,
        electionIdBefore: String(topologyBefore.electionId || ''),
        electionIdAfter: String(topologyAfter.electionId || '')
      },
      workload: summarizeWorkload(workload),
      postElectionReadOk,
      consistency,
      observed,
      metrics
    };
  } finally {
    await sampler?.stop();
    await stopServer(child);
    await dropTemporaryDatabase(databaseName);
  }
}

async function runElectionWorkload(baseUrl, prefix) {
  const deadline = Date.now() + durationSeconds * 1_000;
  const statuses = new Map();
  const latencies = [];
  const acknowledged = [];
  let sequence = 0;
  const started = performance.now();
  async function worker(workerId) {
    while (Date.now() < deadline && sequence < maxRequests) {
      sequence += 1;
      const current = sequence;
      const began = performance.now();
      try {
        const isWrite = current % 2 === 0;
        const response = await fetch(`${baseUrl}/api/ideas`, isWrite ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `${prefix} write ${current}`, description: `worker ${workerId}` }),
          signal: AbortSignal.timeout(5_000)
        } : { signal: AbortSignal.timeout(5_000) });
        const body = await response.json().catch(() => undefined);
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (response.status === 201 && body?._id) acknowledged.push({ id: String(body._id), title: body.title });
      } catch {
        statuses.set('network', (statuses.get('network') || 0) + 1);
      }
      latencies.push(performance.now() - began);
      await delay(10);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  return { statuses, latencies, acknowledged, durationMs: performance.now() - started };
}

function summarizeWorkload({ statuses, latencies, acknowledged, durationMs }) {
  const attempted = [...statuses.values()].reduce((sum, value) => sum + value, 0);
  const successful = [...statuses].reduce((sum, [status, count]) => typeof status === 'number' && status >= 200 && status < 300 ? sum + count : sum, 0);
  return {
    attempted,
    successful,
    failed: attempted - successful,
    created201: statuses.get(201) || 0,
    rejected503: statuses.get(503) || 0,
    timedOut504: statuses.get(504) || 0,
    serverError500: statuses.get(500) || 0,
    networkErrors: statuses.get('network') || 0,
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    durationMs: Number(durationMs.toFixed(1)),
    acknowledgedWrites: acknowledged.length
  };
}

async function verifyConsistency({ databaseName, prefix, preElection, postElection, acknowledged }) {
  const client = new MongoClient(replicaUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const collection = client.db(databaseName).collection('ideas');
    const ids = acknowledged.map(({ id }) => new ObjectId(id));
    const acknowledgedPresent = ids.length ? await collection.countDocuments({ _id: { $in: ids } }) : 0;
    const duplicates = await collection.aggregate([
      { $match: { title: { $regex: `^${escapeRegex(prefix)}` } } },
      { $group: { _id: '$title', copies: { $sum: 1 } } },
      { $group: { _id: null, maximum: { $max: '$copies' } } }
    ]).next();
    const status = await client.db('admin').command({ replSetGetStatus: 1 });
    const preElectionSentinelCopies = await waitForMemberCopies(status.members.map(({ name }) => name), databaseName, preElection._id);
    const postElectionSentinelCopies = await waitForMemberCopies(status.members.map(({ name }) => name), databaseName, postElection._id);
    return {
      members: status.members.map(({ name, stateStr, health }) => ({ name, state: stateStr, health })),
      acknowledgedWrites: acknowledged.length,
      missingAcknowledgedWrites: acknowledged.length - acknowledgedPresent,
      maximumCopiesPerTitle: duplicates?.maximum || 1,
      preElectionSentinelCopies,
      postElectionSentinelCopies
    };
  } finally { await client.close(); }
}

async function waitForMemberCopies(members, databaseName, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let copies = 0;
    for (const member of members) {
      const client = new MongoClient(`mongodb://${member}/?directConnection=true&readPreference=secondaryPreferred`, { serverSelectionTimeoutMS: 2_000 });
      try {
        await client.connect();
        if (await client.db(databaseName).collection('ideas').findOne({ _id: new ObjectId(String(id)) }, { readConcern: { level: 'majority' } })) copies += 1;
      } catch { }
      finally { await client.close(); }
    }
    if (copies === members.length) return copies;
    await delay(200);
  }
  return 0;
}

async function stepDownPrimary() {
  const client = new MongoClient(replicaUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    // Keep the former primary ineligible beyond the observation deadline so a
    // successful assertion proves another member actually won an election.
    await client.db('admin').command({ replSetStepDown: 30, secondaryCatchUpPeriodSecs: 5, force: true });
  } catch (error) {
    if (!/not primary|node is recovering|connection|socket|closed/i.test(String(error))) throw error;
  } finally { await client.close(); }
}

async function getPrimary() {
  const client = new MongoClient(replicaUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const hello = await client.db('admin').command({ hello: 1 });
    return { primary: hello.primary || hello.me, electionId: hello.electionId };
  } finally { await client.close(); }
}

async function waitForChangedPrimary(previous) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const current = await getPrimary();
      if (current.primary && current.primary !== previous) return current;
    } catch { }
    await delay(200);
  }
  throw new Error(`Replica set did not elect a primary different from ${previous}.`);
}

async function waitForHealthyReplicaSet() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const client = new MongoClient(replicaUri, { serverSelectionTimeoutMS: 3_000 });
    try {
      await client.connect();
      const status = await client.db('admin').command({ replSetGetStatus: 1 });
      if (status.members.length === 3 && status.members.every(({ stateStr }) => ['PRIMARY', 'SECONDARY'].includes(stateStr))) return;
    } catch { }
    finally { await client.close(); }
    await delay(250);
  }
  throw new Error('Replica set did not return to one primary and two secondaries.');
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
  return { async stop() { clearInterval(timer); await pending; await sample(); return Object.freeze({ ...observed }); } };
}

function startServer({ mode, port, databaseName }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: exampleRoot,
    env: { ...process.env, PORT: String(port), MONGODB_URI: replicaUri, MONGODB_DATABASE: databaseName, USE_LAZPHO: String(mode === 'lazpho'), SIMULATED_DB_LATENCY_MS: '0', LOAD_LAB: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  const remember = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.diagnostics = () => diagnostics.trim();
  return child;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup with code ${child.exitCode}.\n${child.diagnostics?.() || ''}`);
    try { if ((await fetch(`${baseUrl}/api/metrics`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { }
    await delay(100);
  }
  throw new Error(`Server did not become ready.\n${child.diagnostics?.() || ''}`);
}

async function waitForApplicationRecovery(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/ideas`, { signal: AbortSignal.timeout(3_000) })).ok) return; } catch { }
    await delay(150);
  }
  throw new Error('Application did not recover after replica-set election.');
}

async function createIdea(baseUrl, title) {
  const response = await fetch(`${baseUrl}/api/ideas`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: 'Replica-set majority-write sentinel' }),
    signal: AbortSignal.timeout(5_000)
  });
  if (response.status !== 201) throw new Error(`Sentinel write failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Request failed with ${response.status}.`);
  return response.json();
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function dropTemporaryDatabase(databaseName) {
  const client = new MongoClient(replicaUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    await client.db(databaseName).dropDatabase({ writeConcern: { w: 'majority' } });
    const databases = await client.db('admin').admin().listDatabases({ nameOnly: true });
    assert.ok(!databases.databases.some(({ name }) => name === databaseName), `Temporary database ${databaseName} was not removed.`);
  }
  finally { await client.close(); }
}

function renderReport(value) {
  const rows = value.modes.map(({ mode, topology, workload, consistency }) => `<tr><td>${mode}</td><td>${topology.primaryBefore}</td><td>${topology.primaryAfter}</td><td>${workload.attempted}</td><td>${workload.successful}</td><td>${workload.failed}</td><td>${workload.rejected503}</td><td>${workload.timedOut504}</td><td>${workload.p95Ms} ms</td><td>${consistency.missingAcknowledgedWrites}</td></tr>`).join('');
  const findings = value.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalboard MongoDB replica-set report</title><style>body{max-width:1200px;margin:40px auto;padding:0 20px;color:#17201d;font:14px system-ui}section{border:1px solid #dce4df;border-radius:12px;padding:18px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.warn{color:#8a4b00}</style></head><body><h1>Signalboard MongoDB replica-set report</h1><p>Real three-member MongoDB primary election with majority durability checks.</p><section><h2>Results</h2><table><thead><tr><th>Mode</th><th>Primary before</th><th>Primary after</th><th>Attempted</th><th>2xx</th><th>Failed</th><th>503</th><th>504</th><th>P95</th><th>Missing acknowledged writes</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Interpretation</h2><ul>${findings}</ul></section><p class="warn">This is bounded election evidence, not certification for every topology or partition scenario.</p><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></body></html>`;
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

function redactUri(value) {
  try { const url = new URL(value); if (url.password) url.password = 'REDACTED'; return url.toString(); }
  catch { return 'mongodb://REDACTED'; }
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
