import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BulkheadQueueFullError,
  CircuitBreakerOpenError,
  ControllerAbortError,
  ControllerLifecycleError,
  ControllerTimeoutError,
  QueueAbortedError,
  QueueFullError,
  QueueWaitTimeoutError,
  createFactory
} from '../index.js';
import { createRequestAbortSignal, instrumentNodeHttp } from '../adapters/node-http.js';
import type { AdaptiveDecisionEvent, ConcurrencyController, MetricsSnapshot } from '../types.js';

type ScenarioName = 'fast' | 'slow' | 'cpu' | 'database' | 'saturated' | 'retry' | 'mixed' | 'bulkhead' | 'payments' | 'recovery' | 'timeout' | 'cancel';
type OutcomeName = 'success' | 'queue_rejected' | 'bulkhead_rejected' | 'queue_timeout' | 'execution_timeout' | 'breaker_open' | 'downstream_failure' | 'cancelled' | 'other_failure';

interface ScenarioDefinition {
  readonly name: ScenarioName;
  readonly route: string;
  readonly description: string;
  readonly requests: number;
  readonly concurrency: number;
  readonly abortAfterMs?: number;
  readonly delayBeforeMs?: number;
}

interface TimelinePoint {
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly scenario: string;
  readonly metrics: MetricsSnapshot;
  readonly diagnoses: Readonly<Record<string, string>>;
  readonly dependencyActive: Readonly<Record<string, number>>;
}

interface NamedDecision extends AdaptiveDecisionEvent {
  readonly controller: 'database' | 'payments';
}

class DependencyHttpError extends Error { public constructor(public readonly statusCode: number) { super(`Dependency returned HTTP ${statusCode}`); } }
class DependencyRequestError extends Error { public constructor(public readonly cause: unknown) { super('Dependency request failed.'); } }

const host = '127.0.0.1';
const port = parsePort(process.env.LAZPHO_DASHBOARD_PORT, 1912);
const smoke = process.argv.includes('--smoke');
const factory = createFactory({ maxRoutes: 32, latencySampleSize: 256, rpsWindowSeconds: 10, eventLoopResolutionMs: 20 });
const decisions: NamedDecision[] = [];

const database = factory.concurrency({ name: 'database', limit: 4, maxQueueSize: 48, maxQueueWaitMs: 700, latencySampleSize: 128 });
const databaseAdaptive = factory.adaptiveConcurrency({
  name: 'database-adaptive', controller: database, minLimit: 2, maxLimit: 16, targetP95Ms: 90,
  maxErrorRate: 0.05, mode: 'auto', evaluationIntervalMs: 1_000, increaseStep: 2,
  queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 300, maxRejectionRate: 0.05, maxTimeoutRate: 0.03 },
  onDecision: (event) => rememberDecision('database', event)
});
const payments = factory.concurrency({
  name: 'payments', limit: 4, maxQueueSize: 32, maxQueueWaitMs: 500, latencySampleSize: 128,
  bulkheads: { reads: { maxConcurrent: 3, maxQueue: 20 }, writes: { maxConcurrent: 1, maxQueue: 8 } },
  circuitBreaker: { failureThreshold: 4, resetTimeoutMs: 2_000, halfOpenMaxAttempts: 1 }
});
const paymentsAdaptive = factory.adaptiveConcurrency({
  name: 'payments-adaptive', controller: payments, minLimit: 2, maxLimit: 10, targetP95Ms: 120,
  maxErrorRate: 0.05, mode: 'auto', evaluationIntervalMs: 1_000, increaseStep: 1,
  queuePressure: { maxUtilization: 0.8, maxQueueWaitP95Ms: 300, maxRejectionRate: 0.05, maxTimeoutRate: 0.03 },
  onDecision: (event) => rememberDecision('payments', event)
});
const reports = factory.concurrency({ name: 'long-reports', limit: 2, maxQueueSize: 8, maxQueueWaitMs: 1_500, latencySampleSize: 64 });

const dependencyActive: Record<string, number> = { database: 0, payments: 0 };
const dependencyPeak: Record<string, number> = { database: 0, payments: 0 };
const timeline: TimelinePoint[] = [];
const startedAt = Date.now();
let dependencyPort = 0;
let runningScenario = '';
let scenarioProgress = { completed: 0, total: 0 };
let scenarioResults: Array<{ name: ScenarioName; durationMs: number; outcomes: Record<OutcomeName, number> }> = [];
let shuttingDown = false;

const scenarios: readonly ScenarioDefinition[] = [
  { name: 'fast', route: '/lab/fast', description: 'Healthy local route', requests: 60, concurrency: 12 },
  { name: 'slow', route: '/lab/slow', description: 'Legitimate long-running operation', requests: 12, concurrency: 3 },
  { name: 'cpu', route: '/lab/cpu', description: 'Event-loop/CPU bottleneck', requests: 30, concurrency: 6 },
  { name: 'database', route: '/lab/database', description: 'Healthy protected database dependency', requests: 100, concurrency: 24 },
  { name: 'saturated', route: '/lab/saturated', description: 'Database queue saturation', requests: 220, concurrency: 90 },
  { name: 'retry', route: '/lab/retry', description: 'Transient failure followed by a successful bounded retry', requests: 24, concurrency: 8 },
  { name: 'mixed', route: '/lab/mixed', description: 'Database and payments together', requests: 60, concurrency: 20 },
  { name: 'bulkhead', route: '/lab/bulkhead', description: 'Payment-write partition isolation and rejection', requests: 40, concurrency: 30 },
  { name: 'payments', route: '/lab/payments?fail=1', description: 'Downstream failure and circuit-breaker opening', requests: 50, concurrency: 16 },
  { name: 'recovery', route: '/lab/recovery', description: 'Half-open breaker probe and recovery', requests: 4, concurrency: 1, delayBeforeMs: 2_100 },
  { name: 'timeout', route: '/lab/timeout', description: 'Protected execution timeout', requests: 20, concurrency: 10 },
  { name: 'cancel', route: '/lab/cancel', description: 'Incoming disconnect cancellation', requests: 12, concurrency: 12, abortAfterMs: 35 }
];
const routeOutcomes = emptyRouteOutcomes();

const dependencyServer = createServer(async (request, response) => {
  const url = requestUrl(request);
  const dependency = url.pathname === '/payments' ? 'payments' : 'database';
  dependencyActive[dependency] += 1;
  dependencyPeak[dependency] = Math.max(dependencyPeak[dependency], dependencyActive[dependency]);
  try {
    const delayMs = numberParameter(url, 'delay', dependency === 'payments' ? 45 : 35);
    await delay(delayMs);
    if (response.destroyed) return;
    const shouldFail = url.searchParams.get('fail') === '1';
    response.statusCode = shouldFail ? 503 : 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ dependency, ok: !shouldFail, delayMs }));
  } finally {
    dependencyActive[dependency] -= 1;
  }
});

await listen(dependencyServer, 0);
dependencyPort = (dependencyServer.address() as AddressInfo).port;

const instrumentedLabHandler = instrumentNodeHttp(factory, handleLabRoute, { route: (request) => requestUrl(request).pathname });
const dashboardServer = createServer((request, response) => {
  const pathname = requestUrl(request).pathname;
  const handler = pathname.startsWith('/lab/') ? instrumentedLabHandler : handleDashboardRoute;
  void Promise.resolve(handler(request, response)).catch((error) => sendJson(response, 500, { error: String(error) }));
});

await listen(dashboardServer, port);
const evaluator = setInterval(() => {
  databaseAdaptive.evaluateFromMetrics();
  paymentsAdaptive.evaluateFromMetrics();
}, 1_000);
evaluator.unref();
const sampler = setInterval(captureTimeline, 500);
sampler.unref();

console.log(`Lazpho Phase 8B dashboard: http://${host}:${port}`);
console.log('Run every scenario from the dashboard or POST /api/run?scenario=all');

if (smoke) {
  const page = await fetch(`http://${host}:${port}/`).then((response) => response.text());
  assert.match(page, /Lazpho Phase 8B/);
  const scenarioCatalog = await fetch(`http://${host}:${port}/api/scenarios`).then((response) => response.json()) as ScenarioDefinition[];
  assert.equal(scenarioCatalog.length, scenarios.length);
  const unknown = await fetch(`http://${host}:${port}/api/run?scenario=unknown`, { method: 'POST' });
  assert.equal(unknown.status, 400);
  const started = await fetch(`http://${host}:${port}/api/run?scenario=all&reduced=1`, { method: 'POST' });
  assert.equal(started.status, 202);
  const conflict = await fetch(`http://${host}:${port}/api/run?scenario=fast`, { method: 'POST' });
  assert.equal(conflict.status, 409);
  await waitForScenarioRun();
  captureTimeline();
  const metrics = factory.getMetrics();
  assert.ok(Object.keys(metrics.routes).length >= scenarios.length, 'smoke run must exercise every lab route');
  assert.ok(database.stats().rejected > 0, 'saturation must produce bounded rejection or timeout evidence');
  assert.ok(database.stats().retriesAttempted > 0 && database.stats().retrySuccesses > 0, 'retry route must retry and recover');
  assert.ok(payments.stats().bulkheadRejected > 0, 'bulkhead route must isolate excess write work');
  assert.ok((payments.stats().circuitBreaker?.breakerRecoveries ?? 0) > 0, 'breaker must recover through a half-open probe');
  const paymentResult = scenarioResults.find(({ name }) => name === 'payments');
  assert.ok((paymentResult?.outcomes.downstream_failure ?? 0) > 0 && (paymentResult?.outcomes.breaker_open ?? 0) > 0, 'payment route must distinguish dependency failure from breaker rejection');
  assert.equal(scenarioResults.reduce((total, result) => total + result.outcomes.other_failure, 0), 0, 'all scenario failures must have an explicit outcome');
  assert.ok(database.stats().executionTimedOut > 0, 'timeout route must exercise execution timeout');
  assert.ok(database.stats().cancelled > 0, 'cancel route must reach the protected operation');
  for (const controller of [database, payments, reports]) {
    assert.equal(controller.stats().active, 0);
    assert.equal(controller.stats().queued, 0);
  }
  const completedScenarios = scenarioResults;
  const reset = await fetch(`http://${host}:${port}/api/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  console.log(JSON.stringify({ routes: Object.keys(metrics.routes), controllers: metrics.controllers, scenarioResults: completedScenarios }, null, 2));
  await shutdown();
} else {
  const stop = () => { void shutdown(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function handleLabRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request);
  const abort = createRequestAbortSignal(request, response);
  try {
    switch (url.pathname) {
      case '/lab/fast':
        await delay(5);
        return sendJson(response, 200, { ok: true });
      case '/lab/slow':
        await reports.run(() => delay(350), { signal: abort.signal, timeoutMs: 1_000 });
        return sendJson(response, 200, { ok: true, expectedSlow: true });
      case '/lab/cpu':
        blockEventLoop(45);
        return sendJson(response, 200, { ok: true });
      case '/lab/database':
        await callDependency(database, '/database?delay=35', abort.signal, { timeoutMs: 300 });
        return sendJson(response, 200, { ok: true });
      case '/lab/saturated':
        await callDependency(database, '/database?delay=80', abort.signal, { timeoutMs: 350 });
        return sendJson(response, 200, { ok: true });
      case '/lab/retry':
        await database.run(async ({ signal, attempt }) => {
          const dependencyResponse = await fetchDependency(`/database?delay=30&fail=${attempt === 1 ? '1' : '0'}`, signal);
          await dependencyResponse.arrayBuffer();
          if (!dependencyResponse.ok) throw new DependencyHttpError(dependencyResponse.status);
        }, { signal: abort.signal, timeoutMs: 250, retry: { attempts: 1, delayMs: 20 } });
        return sendJson(response, 200, { ok: true, recoveredOnRetry: true });
      case '/lab/payments':
        await callDependency(payments, `/payments?delay=55&fail=${url.searchParams.get('fail') === '1' ? '1' : '0'}`, abort.signal, {
          timeoutMs: 300, bulkhead: 'reads'
        });
        return sendJson(response, 200, { ok: true });
      case '/lab/bulkhead':
        await callDependency(payments, '/payments?delay=100&fail=0', abort.signal, { timeoutMs: 350, bulkhead: 'writes' });
        return sendJson(response, 200, { ok: true });
      case '/lab/recovery':
        await callDependency(payments, '/payments?delay=40&fail=0', abort.signal, { timeoutMs: 300, bulkhead: 'reads' });
        return sendJson(response, 200, { ok: true, breakerRecovered: true });
      case '/lab/timeout':
        await callDependency(database, '/database?delay=500', abort.signal, { timeoutMs: 100 });
        return sendJson(response, 200, { ok: true });
      case '/lab/cancel':
        await callDependency(database, '/database?delay=500', abort.signal, { timeoutMs: 1_000 });
        return sendJson(response, 200, { ok: true });
      case '/lab/mixed':
        await Promise.all([
          callDependency(database, '/database?delay=40', abort.signal, { timeoutMs: 300 }),
          callDependency(payments, '/payments?delay=60&fail=0', abort.signal, { timeoutMs: 300, bulkhead: 'writes' })
        ]);
        return sendJson(response, 200, { ok: true });
      default:
        return sendJson(response, 404, { code: 'NOT_FOUND' });
    }
  } catch (error) {
    const outcome = classifyOutcome(error);
    routeOutcomes[url.pathname][outcome] += 1;
    if (response.destroyed || abort.signal.aborted) return;
    return sendJson(response, httpStatus(error), { code: outcome });
  } finally {
    abort.dispose();
  }
}

async function handleDashboardRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request);
  if (request.method === 'GET' && url.pathname === '/') return sendHtml(response, dashboardHtml());
  if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, currentState());
  if (request.method === 'GET' && url.pathname === '/api/scenarios') return sendJson(response, 200, scenarios);
  if (request.method === 'POST' && url.pathname === '/api/run') {
    const selected = url.searchParams.get('scenario') ?? 'all';
    if (runningScenario) return sendJson(response, 409, { code: 'SCENARIO_RUNNING', scenario: runningScenario });
    if (selected !== 'all' && !scenarios.some(({ name }) => name === selected)) return sendJson(response, 400, { code: 'UNKNOWN_SCENARIO' });
    void runSelectedScenarios(selected as ScenarioName | 'all', smoke && url.searchParams.get('reduced') === '1');
    return sendJson(response, 202, { started: selected });
  }
  if (request.method === 'POST' && url.pathname === '/api/reset') {
    if (runningScenario) return sendJson(response, 409, { code: 'SCENARIO_RUNNING' });
    factory.reset();
    timeline.length = 0;
    scenarioResults = [];
    for (const route of Object.keys(routeOutcomes)) routeOutcomes[route] = emptyOutcomes();
    return sendJson(response, 200, { reset: true });
  }
  return sendJson(response, 404, { code: 'NOT_FOUND' });
}

async function callDependency(controller: ConcurrencyController, path: string, signal: AbortSignal, options: Parameters<ConcurrencyController['run']>[1]): Promise<void> {
  await controller.run(async ({ signal: operationSignal }) => {
    const response = await fetchDependency(path, operationSignal);
    await response.arrayBuffer();
    if (!response.ok) throw new DependencyHttpError(response.status);
  }, { ...options, signal });
}

async function fetchDependency(path: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(`http://${host}:${dependencyPort}${path}`, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new DependencyRequestError(error);
  }
}

async function runSelectedScenarios(selected: ScenarioName | 'all', reduced: boolean): Promise<void> {
  const selectedScenarios = selected === 'all' ? scenarios : scenarios.filter(({ name }) => name === selected);
  runningScenario = selected;
  scenarioResults = [];
  try {
    for (const definition of selectedScenarios) {
      if (definition.delayBeforeMs) await delay(definition.delayBeforeMs);
      const requests = reduced ? Math.max(definition.name === 'saturated' ? 80 : 4, Math.ceil(definition.requests / 3)) : definition.requests;
      scenarioProgress = { completed: 0, total: requests };
      const result = await runLoad({ ...definition, requests });
      scenarioResults.push(result);
      await waitForControllersToDrain();
      captureTimeline();
    }
  } finally {
    runningScenario = '';
    scenarioProgress = { completed: 0, total: 0 };
  }
}

async function runLoad(definition: ScenarioDefinition): Promise<{ name: ScenarioName; durationMs: number; outcomes: Record<OutcomeName, number> }> {
  const outcomes = emptyOutcomes();
  let cursor = 0;
  const began = performance.now();
  const workers = Array.from({ length: Math.min(definition.concurrency, definition.requests) }, async () => {
    while (cursor < definition.requests) {
      cursor += 1;
      const abort = new AbortController();
      const abortTimer = definition.abortAfterMs === undefined ? undefined : setTimeout(() => abort.abort(), definition.abortAfterMs);
      try {
        const response = await fetch(`http://${host}:${port}${definition.route}`, { signal: abort.signal });
        const body = await response.json() as { code?: OutcomeName };
        outcomes[response.ok ? 'success' : body.code ?? 'other_failure'] += 1;
      } catch (error) {
        outcomes[abort.signal.aborted ? 'cancelled' : classifyOutcome(error)] += 1;
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
        scenarioProgress.completed += 1;
      }
    }
  });
  await Promise.all(workers);
  return { name: definition.name, durationMs: performance.now() - began, outcomes };
}

function captureTimeline(): void {
  const metrics = factory.getMetrics();
  timeline.push({ timestamp: Date.now(), elapsedMs: Date.now() - startedAt, scenario: runningScenario, metrics, diagnoses: diagnose(metrics), dependencyActive: { ...dependencyActive } });
  if (timeline.length > 120) timeline.shift();
}

function rememberDecision(controller: NamedDecision['controller'], event: AdaptiveDecisionEvent): void {
  decisions.push({ controller, ...event });
  if (decisions.length > 80) decisions.shift();
}

function currentState() {
  const metrics = factory.getMetrics();
  return {
    startedAt, runningScenario, scenarioProgress, scenarioResults, scenarios,
    routeOutcomes, metrics, diagnoses: diagnose(metrics), dependencyActive,
    dependencyPeak, decisions: decisions.slice(-40), timeline
  };
}

function diagnose(metrics: MetricsSnapshot): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [route, routeMetrics] of Object.entries(metrics.routes)) {
    const controllerName = routeController(route);
    const controller = controllerName ? metrics.controllers[controllerName] : undefined;
    if (route === '/lab/cpu' && metrics.resources.eventLoopLagMs > 25) result[route] = 'event-loop / CPU pressure';
    else if (controller && controller.queueWait.p95Ms > Math.max(50, controller.execution.p95Ms)) result[route] = 'local admission queue';
    else if (controller && controller.execution.p95Ms > 100) result[route] = 'downstream execution';
    else if (routeMetrics.errors > 0) result[route] = 'failure / timeout path';
    else if (route === '/lab/slow') result[route] = 'expected long-running work';
    else result[route] = 'healthy / no dominant bottleneck';
  }
  return result;
}

function routeController(route: string): string | undefined {
  if (['/lab/database', '/lab/saturated', '/lab/timeout', '/lab/cancel'].includes(route)) return 'database';
  if (['/lab/payments', '/lab/recovery', '/lab/bulkhead'].includes(route)) return 'payments';
  if (route === '/lab/retry') return 'database';
  if (route === '/lab/slow') return 'long-reports';
  return undefined;
}

function classifyOutcome(error: unknown): OutcomeName {
  if (error instanceof BulkheadQueueFullError) return 'bulkhead_rejected';
  if (error instanceof QueueFullError) return 'queue_rejected';
  if (error instanceof QueueWaitTimeoutError) return 'queue_timeout';
  if (error instanceof ControllerTimeoutError) return 'execution_timeout';
  if (error instanceof CircuitBreakerOpenError) return 'breaker_open';
  if (error instanceof QueueAbortedError || error instanceof ControllerAbortError) return 'cancelled';
  if (isDependencyFailure(error)) return 'downstream_failure';
  return 'other_failure';
}

function httpStatus(error: unknown): number {
  if (error instanceof ControllerTimeoutError || error instanceof QueueWaitTimeoutError) return 504;
  if (error instanceof QueueFullError || error instanceof BulkheadQueueFullError || error instanceof CircuitBreakerOpenError || error instanceof ControllerLifecycleError) return 503;
  if (isDependencyFailure(error)) return 502;
  return 500;
}

async function waitForControllersToDrain(): Promise<void> {
  while ([database, payments, reports].some((controller) => controller.stats().active > 0 || controller.stats().queued > 0)) await delay(10);
}

async function waitForScenarioRun(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (runningScenario && Date.now() < deadline) await delay(20);
  assert.equal(runningScenario, '', 'scenario API did not finish within 30 seconds');
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(evaluator);
  clearInterval(sampler);
  await Promise.all([databaseAdaptive.close(), paymentsAdaptive.close(), reports.close()]);
  await Promise.all([closeServer(dashboardServer), closeServer(dependencyServer)]);
  factory.close();
}

function isDependencyFailure(error: unknown): boolean {
  return error instanceof DependencyHttpError
    || error instanceof DependencyRequestError
    || (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number');
}
function parsePort(value: string | undefined, fallback: number): number { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new RangeError('LAZPHO_DASHBOARD_PORT must be an integer from 1 to 65535.'); return parsed; }
function requestUrl(request: IncomingMessage): URL { return new URL(request.url ?? '/', `http://${host}`); }
function numberParameter(url: URL, name: string, fallback: number): number { const value = Number(url.searchParams.get(name) ?? fallback); return Number.isFinite(value) && value >= 0 ? Math.min(value, 5_000) : fallback; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function blockEventLoop(milliseconds: number): void { const until = performance.now() + milliseconds; while (performance.now() < until) { /* diagnostic busy work */ } }
function emptyOutcomes(): Record<OutcomeName, number> { return { success: 0, queue_rejected: 0, bulkhead_rejected: 0, queue_timeout: 0, execution_timeout: 0, breaker_open: 0, downstream_failure: 0, cancelled: 0, other_failure: 0 }; }
function emptyRouteOutcomes(): Record<string, Record<OutcomeName, number>> { return Object.fromEntries(scenarios.map(({ route }) => [new URL(route, 'http://local').pathname, emptyOutcomes()])); }
function listen(server: Server, selectedPort: number): Promise<void> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(selectedPort, host, () => { server.removeListener('error', reject); resolve(); }); }); }
function closeServer(server: Server): Promise<void> { return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
function sendJson(response: ServerResponse, statusCode: number, value: unknown): void { if (response.destroyed || response.writableEnded) return; response.statusCode = statusCode; response.setHeader('content-type', 'application/json; charset=utf-8'); response.setHeader('cache-control', 'no-store'); response.end(JSON.stringify(value)); }
function sendHtml(response: ServerResponse, value: string): void { response.statusCode = 200; response.setHeader('content-type', 'text/html; charset=utf-8'); response.setHeader('cache-control', 'no-store'); response.end(value); }

function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lazpho Bottleneck Lab</title><style>
  :root{color-scheme:dark;--bg:#07111f;--panel:#0e1d31;--line:#213653;--text:#e8f1ff;--muted:#8da5c4;--good:#4ade80;--warn:#fbbf24;--bad:#fb7185;--accent:#38bdf8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#123052 0,var(--bg) 35%);color:var(--text);font:14px system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:24px}h1{margin:0;font-size:28px}h2{font-size:16px;margin:0 0 12px}.sub{color:var(--muted);margin:6px 0 20px}.toolbar,.grid{display:flex;gap:10px;flex-wrap:wrap}.toolbar{margin-bottom:20px}button{background:#153251;color:var(--text);border:1px solid #2d5278;border-radius:8px;padding:9px 13px;cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{opacity:.45}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:16px}.card,.panel{background:rgba(14,29,49,.92);border:1px solid var(--line);border-radius:12px;padding:16px}.value{font-size:25px;font-weight:700}.muted{color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);white-space:nowrap}.scroll{overflow:auto}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}progress{width:100%;accent-color:var(--accent)}canvas{width:100%;height:180px;background:#091526;border-radius:8px}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.two{grid-template-columns:1fr}}</style></head><body><main>
  <h1>Lazpho Phase 8B · Bottleneck Lab</h1><p class="sub">Full-path route, dependency, queue, adaptive, failure, cancellation, and resource diagnostics · localhost:${port}</p>
  <div class="toolbar" id="buttons"></div><div class="card" style="margin-bottom:16px"><b id="running">Idle</b><progress id="progress" value="0" max="1"></progress></div>
  <section class="grid" id="summary"></section><section class="two"><div class="panel"><h2>Controllers</h2><div class="scroll"><table><thead><tr><th>Name</th><th>Limit</th><th>Active</th><th>Queued</th><th>Queue P95</th><th>Exec P95</th><th>Rejected</th><th>Timeouts</th></tr></thead><tbody id="controllers"></tbody></table></div></div>
  <div class="panel"><h2>Adaptive decisions</h2><div class="scroll"><table><thead><tr><th>Controller</th><th>Limit</th><th>State</th><th>Changes</th><th>Last reason</th></tr></thead><tbody id="adaptive"></tbody></table></div></div></section>
  <section class="panel" style="margin-top:16px"><h2>Incoming routes and likely bottleneck</h2><div class="scroll"><table><thead><tr><th>Route</th><th>Requests</th><th>Errors</th><th>RPS</th><th>P50</th><th>P95</th><th>P99</th><th>Diagnosis</th></tr></thead><tbody id="routes"></tbody></table></div></section>
  <section class="panel" style="margin-top:16px"><h2>Limit timeline</h2><canvas id="chart" width="1200" height="180"></canvas></section>
  <section class="panel" style="margin-top:16px"><h2>Scenario results</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Duration</th><th>Success</th><th>Queue rejected</th><th>Bulkhead rejected</th><th>Queue timeout</th><th>Execution timeout</th><th>Breaker open</th><th>Downstream failure</th><th>Cancelled</th></tr></thead><tbody id="results"></tbody></table></div></section>
  <script>
  const scenarios=${JSON.stringify(scenarios)};const buttons=document.querySelector('#buttons');for(const s of [{name:'all',description:'Run all'},...scenarios]){const b=document.createElement('button');b.textContent=s.name;b.title=s.description;b.onclick=()=>fetch('/api/run?scenario='+s.name,{method:'POST'});buttons.append(b)}const reset=document.createElement('button');reset.textContent='reset views';reset.onclick=()=>fetch('/api/reset',{method:'POST'});buttons.append(reset);
  const n=v=>new Intl.NumberFormat().format(Math.round(v||0)),ms=v=>n(v)+' ms',cells=(values)=>'<tr>'+values.map(v=>'<td>'+v+'</td>').join('')+'</tr>';
  async function refresh(){const s=await fetch('/api/state').then(r=>r.json());document.querySelector('#running').textContent=s.runningScenario?'Running '+s.runningScenario:'Idle';const p=document.querySelector('#progress');p.max=Math.max(1,s.scenarioProgress.total);p.value=s.scenarioProgress.completed;for(const b of buttons.querySelectorAll('button'))b.disabled=!!s.runningScenario;
  const m=s.metrics;document.querySelector('#summary').innerHTML=[['Requests',m.totalRequests],['Active routes',m.activeRequests],['Route P95',ms(m.p95Ms)],['Event-loop lag',ms(m.resources.eventLoopLagMs)],['Database peak',s.dependencyPeak.database],['Payments peak',s.dependencyPeak.payments]].map(x=>'<div class="card"><div class="muted">'+x[0]+'</div><div class="value">'+x[1]+'</div></div>').join('');
  document.querySelector('#controllers').innerHTML=Object.entries(m.controllers).map(([k,v])=>cells([k,v.limit,v.active,v.queued,ms(v.queueWait.p95Ms),ms(v.execution.p95Ms),v.rejected,v.timedOut])).join('');
  document.querySelector('#adaptive').innerHTML=Object.entries(m.adaptiveControllers).map(([k,v])=>cells([k,v.currentLimit,v.controllerState,v.limitChanges,v.lastDecision?.reason||'-'])).join('');
  document.querySelector('#routes').innerHTML=Object.entries(m.routes).map(([k,v])=>cells([k,v.totalRequests,v.errors,n(v.requestsPerSecond),ms(v.p50Ms),ms(v.p95Ms),ms(v.p99Ms),s.diagnoses[k]||'-'])).join('');
  document.querySelector('#results').innerHTML=s.scenarioResults.map(r=>cells([r.name,ms(r.durationMs),r.outcomes.success,r.outcomes.queue_rejected,r.outcomes.bulkhead_rejected,r.outcomes.queue_timeout,r.outcomes.execution_timeout,r.outcomes.breaker_open,r.outcomes.downstream_failure,r.outcomes.cancelled])).join('');draw(s.timeline)}
  function draw(points){const c=document.querySelector('#chart'),x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);const series=['database','payments'];series.forEach((name,j)=>{x.strokeStyle=j?'#fbbf24':'#38bdf8';x.lineWidth=2;x.beginPath();points.forEach((p,i)=>{const v=p.metrics.controllers[name]?.limit||0,px=i/Math.max(1,points.length-1)*(c.width-30)+15,py=c.height-15-v/20*(c.height-30);i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke();x.fillStyle=x.strokeStyle;x.fillText(name,15,15+j*16)})}refresh();setInterval(refresh,1000);
  </script></main></body></html>`;
}
