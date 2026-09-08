import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { LatencySamples } from './latency-samples.js';
import type { ConcurrencyMetrics, MetricsSnapshot } from './types.js';

export type LazphoLoadTestMode = 'once' | 'latency' | 'load';

export interface LazphoLoadEndpoint {
  /** Stable identifier used by the dashboard and report filenames. */
  readonly id: string;
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative URL beginning with /. Query strings are allowed. */
  readonly path: string;
  readonly description: string;
  /** Only endpoints explicitly marked safe can execute. */
  readonly safe: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Optional application-owned fixture setup, run once before measurements. */
  setup?(context: LazphoLoadFixtureContext): Promise<unknown> | unknown;
  /** Builds a request from the setup fixture. It must remain within the configured target. */
  request?(context: LazphoLoadRequestContext): LazphoLoadRequest;
  /** Optional application-owned cleanup, run once after metrics are captured. */
  cleanup?(context: LazphoLoadCleanupContext): Promise<void> | void;
  /** Per-request timeout. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

export interface LazphoLoadFixtureContext {
  readonly signal: AbortSignal;
  readonly targetBaseUrl: string;
  readonly runId: string;
}

export interface LazphoLoadRequestContext {
  readonly sequence: number;
  readonly fixture: unknown;
  readonly runId: string;
}

export interface LazphoLoadCleanupContext extends LazphoLoadFixtureContext {
  readonly fixture: unknown;
}

export interface LazphoLoadRequest {
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface LazphoLoadProfile {
  readonly mode: LazphoLoadTestMode;
  /** Required for load mode. Maximum 1,000,000. */
  readonly requestsPerSecond?: number;
  /** Load duration. Defaults to 10 seconds. Maximum 5 minutes. */
  readonly durationSeconds?: number;
  /** Measured sequential requests for latency mode. Defaults to 50. */
  readonly requests?: number;
}

export interface LazphoControllerImpact {
  readonly name: string;
  readonly limit: number;
  readonly maxQueueSize: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly completed: number;
  readonly failed: number;
  readonly rejected: number;
  readonly timedOut: number;
  readonly stayedWithinLimit: boolean;
}

export interface LazphoLoadRunResult {
  readonly id: string;
  readonly endpointId: string;
  readonly method: string;
  readonly path: string;
  readonly mode: LazphoLoadTestMode;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly requestedRps: number | null;
  readonly requestedRequests: number;
  readonly attemptedRequests: number;
  readonly completedRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly generatorLimitedRequests: number;
  readonly achievedRps: number;
  readonly averageMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly statusCodes: Readonly<Record<string, number>>;
  readonly responseSample?: string;
  readonly controllers: readonly LazphoControllerImpact[];
  readonly interpretation: readonly string[];
}

export interface LazphoLoadLabOptions {
  /** Base URL of the application being tested. */
  readonly targetBaseUrl: string;
  readonly endpoints: readonly LazphoLoadEndpoint[];
  /** Supplies application-local Lazpho metrics for impact evidence. */
  readonly metrics?: () => MetricsSnapshot;
  /** Loopback host only. Defaults to 127.0.0.1. */
  readonly host?: '127.0.0.1' | '::1' | 'localhost';
  /** Defaults to 1913. Use 0 for an ephemeral test port. */
  readonly port?: number;
  /** Remote targets are rejected by default to prevent accidental external load. */
  readonly allowRemoteTarget?: boolean;
  /** Maximum simultaneous requests created by this process. Defaults to 256. */
  readonly maxInFlight?: number;
  /** Maximum completed runs retained in memory. Defaults to 50. */
  readonly historySize?: number;
  /** Optional directory for standalone HTML and JSON reports. */
  readonly reportDirectory?: string;
  readonly apiToken?: string;
  onRunError?(error: unknown, endpointId: string): void;
}

export interface LazphoLoadLabState {
  readonly targetBaseUrl: string;
  /** Public catalog intentionally excludes configured headers and request bodies. */
  readonly endpoints: readonly LazphoLoadEndpointSummary[];
  readonly presets: readonly number[];
  readonly active: Readonly<{
    id: string;
    endpointId: string;
    mode: LazphoLoadTestMode;
    attemptedRequests: number;
    completedRequests: number;
    successfulRequests: number;
    failedRequests: number;
    generatorLimitedRequests: number;
  }> | null;
  readonly history: readonly LazphoLoadRunResult[];
  readonly metrics?: MetricsSnapshot;
}

export interface LazphoLoadEndpointSummary {
  readonly id: string;
  readonly method: LazphoLoadEndpoint['method'];
  readonly path: string;
  readonly description: string;
  readonly safe: boolean;
  readonly fixtureManaged: boolean;
}

export interface LazphoLoadLab {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  state(): LazphoLoadLabState;
  close(): Promise<void>;
}

interface NormalizedEndpoint extends LazphoLoadEndpoint {
  readonly method: LazphoLoadEndpoint['method'];
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

interface LiveRun {
  readonly id: string;
  readonly endpointId: string;
  readonly mode: LazphoLoadTestMode;
  readonly cancellation: AbortController;
  attemptedRequests: number;
  completedRequests: number;
  successfulRequests: number;
  failedRequests: number;
  generatorLimitedRequests: number;
}

interface MutableRunStats {
  attempted: number;
  completed: number;
  successful: number;
  failed: number;
  generatorLimited: number;
  latencyTotal: number;
  latencyMin: number;
  latencyMax: number;
  statusCodes: Record<string, number>;
  responseSample?: string;
}

interface ControllerPeak { active: number; queued: number }
interface ControllerBaseline { completed: number; failed: number; rejected: number; timedOut: number }

const RPS_PRESETS = Object.freeze([10_000, 50_000, 100_000, 1_000_000]);

export async function startLazphoLoadLab(options: LazphoLoadLabOptions): Promise<LazphoLoadLab> {
  if (!options || typeof options !== 'object') throw new TypeError('Load Lab options are required.');
  const target = normalizeTarget(options.targetBaseUrl, options.allowRemoteTarget === true);
  const endpoints = normalizeEndpoints(options.endpoints);
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new RangeError('Lazpho Load Lab may bind only to a loopback host.');
  const requestedPort = boundedInteger(options.port ?? 1913, 0, 65_535, 'port');
  const maxInFlight = boundedInteger(options.maxInFlight ?? 256, 1, 10_000, 'maxInFlight');
  const historySize = boundedInteger(options.historySize ?? 50, 1, 1_000, 'historySize');
  const apiToken = options.apiToken ?? randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(apiToken)) throw new RangeError('apiToken must contain 16 to 256 base64url-safe characters.');
  const reportDirectory = options.reportDirectory ? resolve(options.reportDirectory) : undefined;
  const catalog = Object.freeze(endpoints.map(({ id, method, path, description, safe, setup, request, cleanup }) => Object.freeze({
    id, method, path, description, safe, fixtureManaged: Boolean(setup || request || cleanup)
  })));
  const history: LazphoLoadRunResult[] = [];
  let active: LiveRun | undefined;
  let closed = false;
  let origin = '';

  const safeMetrics = (): MetricsSnapshot | undefined => {
    try { return options.metrics?.(); } catch { return undefined; }
  };

  const state = (): LazphoLoadLabState => Object.freeze({
    targetBaseUrl: target.origin,
    endpoints: catalog,
    presets: RPS_PRESETS,
    active: active ? Object.freeze({
      id: active.id,
      endpointId: active.endpointId,
      mode: active.mode,
      attemptedRequests: active.attemptedRequests,
      completedRequests: active.completedRequests,
      successfulRequests: active.successfulRequests,
      failedRequests: active.failedRequests,
      generatorLimitedRequests: active.generatorLimitedRequests
    }) : null,
    history: Object.freeze([...history]),
    metrics: safeMetrics()
  });

  const begin = (endpointId: string, profileInput: LazphoLoadProfile): 'started' | 'busy' | 'unknown' | 'unsafe' => {
    if (active) return 'busy';
    const endpoint = endpointById.get(endpointId);
    if (!endpoint) return 'unknown';
    if (!endpoint.safe) return 'unsafe';
    const profile = normalizeProfile(profileInput);
    const run: LiveRun = {
      id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
      endpointId,
      mode: profile.mode,
      cancellation: new AbortController(),
      attemptedRequests: 0,
      completedRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      generatorLimitedRequests: 0
    };
    active = run;
    void executeRun(target, endpoint, profile, run, maxInFlight, safeMetrics)
      .then(async (result) => {
        history.push(result);
        while (history.length > historySize) history.shift();
        if (reportDirectory) await writeReports(reportDirectory, result);
      })
      .catch((error) => {
        try { options.onRunError?.(error, endpoint.id); } catch { }
      })
      .finally(() => { if (active === run) active = undefined; });
    return 'started';
  };

  const server = createServer((request, response) => {
    void Promise.resolve().then(async () => {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (origin && request.headers.host !== new URL(origin).host) return json(response, 421, { status: 'invalid_host' });
      if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { status: 'invalid_origin' });
      if (request.method === 'GET' && url.pathname === '/') return html(response, dashboardHtml(apiToken));
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, state());
      const reportMatch = /^\/api\/reports\/([0-9]+-[a-f0-9]{8})\.(json|html)$/.exec(url.pathname);
      if (request.method === 'GET' && reportMatch) {
        const result = history.find((entry) => entry.id === reportMatch[1]);
        if (!result) return json(response, 404, { status: 'not_found' });
        return reportMatch[2] === 'html' ? html(response, reportHtml(result)) : json(response, 200, result);
      }
      if (request.method === 'POST' && !safeToken(request.headers['x-lazpho-dashboard-token'], apiToken)) return json(response, 403, { status: 'forbidden' });
      if (request.method === 'POST' && url.pathname === '/api/run') {
        const body = await readJson(request);
        const result = begin(String(body.endpointId ?? ''), body.profile as LazphoLoadProfile);
        const status = result === 'started' ? 202 : result === 'busy' ? 409 : result === 'unsafe' ? 403 : 404;
        return json(response, status, { status: result });
      }
      if (request.method === 'POST' && url.pathname === '/api/cancel') {
        if (!active) return json(response, 409, { status: 'idle' });
        active.cancellation.abort(new Error('Load test cancelled.'));
        return json(response, 202, { status: 'cancelling' });
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        if (active) return json(response, 409, { status: 'busy' });
        history.length = 0;
        return json(response, 200, { status: 'reset' });
      }
      return json(response, 404, { status: 'not_found' });
    }).catch((error) => json(response, error instanceof SyntaxError || error instanceof RangeError ? 400 : 500, { status: 'invalid_request' }));
  });

  await listen(server, requestedPort, host);
  const address = server.address() as AddressInfo;
  const displayHost = host === '::1' ? '[::1]' : host;
  origin = `http://${displayHost}:${address.port}`;
  return Object.freeze({
    host,
    port: address.port,
    url: origin,
    state,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      active?.cancellation.abort(new Error('Load Lab closed.'));
      await closeServer(server);
    }
  });
}

async function executeRun(
  target: URL,
  endpoint: NormalizedEndpoint,
  profile: Required<LazphoLoadProfile>,
  live: LiveRun,
  maxInFlight: number,
  metrics: () => MetricsSnapshot | undefined
): Promise<LazphoLoadRunResult> {
  const startedAt = Date.now();
  let fixture: unknown;
  let fatal: unknown;
  try {
    fixture = endpoint.setup ? await runHook(
      (signal) => endpoint.setup?.({ signal, targetBaseUrl: target.origin, runId: live.id }),
      endpoint.timeoutMs,
      live.cancellation.signal
    ) : undefined;
  } catch (error) { fatal = error; }
  const began = performance.now();
  const before = controllerBaselines(metrics());
  const peaks = new Map<string, ControllerPeak>();
  const stats: MutableRunStats = {
    attempted: 0, completed: 0, successful: 0, failed: 0, generatorLimited: 0,
    latencyTotal: 0, latencyMin: Number.POSITIVE_INFINITY, latencyMax: 0, statusCodes: {}
  };
  const latencies = new LatencySamples(8_192);
  const sampleMetrics = () => {
    for (const [name, controller] of Object.entries(metrics()?.controllers ?? {})) {
      const peak = peaks.get(name) ?? { active: 0, queued: 0 };
      peak.active = Math.max(peak.active, controller.active);
      peak.queued = Math.max(peak.queued, controller.queued);
      peaks.set(name, peak);
    }
  };
  sampleMetrics();
  const sampler = setInterval(sampleMetrics, 20);
  sampler.unref();
  try {
    let sequence = 0;
    const nextSequence = () => sequence++;
    if (fatal) { /* Setup failure is represented by a failed run with no requests. */ }
    else if (profile.mode === 'once') {
      await requestOnce(target, endpoint, live, nextSequence(), fixture, stats, latencies, true);
    } else if (profile.mode === 'latency') {
      for (let warmup = 0; warmup < 5 && !live.cancellation.signal.aborted; warmup += 1) {
        await requestOnce(target, endpoint, live, nextSequence(), fixture, undefined, undefined, false);
      }
      for (let index = 0; index < profile.requests && !live.cancellation.signal.aborted; index += 1) {
        await requestOnce(target, endpoint, live, nextSequence(), fixture, stats, latencies, index === 0);
      }
    } else {
      await runRateLoad(target, endpoint, profile, live, stats, latencies, maxInFlight, fixture, nextSequence);
    }
  } catch (error) { fatal = error; }
  finally { clearInterval(sampler); sampleMetrics(); }

  const finishedAt = Date.now();
  const durationMs = performance.now() - began;
  const after = metrics();
  const controllerImpact = controllerImpacts(before, after, peaks);
  if (endpoint.cleanup) {
    try {
      await runHook(
        (signal) => endpoint.cleanup?.({ signal, targetBaseUrl: target.origin, runId: live.id, fixture }),
        endpoint.timeoutMs
      );
    } catch (error) { fatal ??= error; }
  }
  const percentiles = latencies.getPercentiles();
  const requestedRequests = profile.mode === 'load'
    ? Math.floor(profile.requestsPerSecond * profile.durationSeconds)
    : profile.mode === 'latency' ? profile.requests : 1;
  stats.generatorLimited = Math.max(stats.generatorLimited, requestedRequests - stats.attempted);
  live.generatorLimitedRequests = stats.generatorLimited;
  const status = live.cancellation.signal.aborted ? 'cancelled' : fatal ? 'failed' : 'completed';
  const result: LazphoLoadRunResult = {
    id: live.id,
    endpointId: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    mode: profile.mode,
    status,
    startedAt,
    finishedAt,
    durationMs,
    requestedRps: profile.mode === 'load' ? profile.requestsPerSecond : null,
    requestedRequests,
    attemptedRequests: stats.attempted,
    completedRequests: stats.completed,
    successfulRequests: stats.successful,
    failedRequests: stats.failed,
    generatorLimitedRequests: stats.generatorLimited,
    achievedRps: stats.completed / Math.max(durationMs / 1_000, 0.001),
    averageMs: stats.completed ? stats.latencyTotal / stats.completed : 0,
    minMs: Number.isFinite(stats.latencyMin) ? stats.latencyMin : 0,
    maxMs: stats.latencyMax,
    ...percentiles,
    statusCodes: Object.freeze({ ...stats.statusCodes }),
    responseSample: stats.responseSample,
    controllers: Object.freeze(controllerImpact),
    interpretation: Object.freeze(interpret(controllerImpact, stats, profile))
  };
  return Object.freeze(result);
}

async function runRateLoad(
  target: URL,
  endpoint: NormalizedEndpoint,
  profile: Required<LazphoLoadProfile>,
  live: LiveRun,
  stats: MutableRunStats,
  latencies: LatencySamples,
  maxInFlight: number,
  fixture: unknown,
  nextSequence: () => number
): Promise<void> {
  const durationMs = profile.durationSeconds * 1_000;
  const began = performance.now();
  let planned = 0;
  const inFlight = new Set<Promise<void>>();
  while (!live.cancellation.signal.aborted) {
    const elapsed = performance.now() - began;
    if (elapsed >= durationMs) break;
    const shouldHavePlanned = Math.min(
      Math.floor(elapsed * profile.requestsPerSecond / 1_000),
      Math.floor(profile.requestsPerSecond * profile.durationSeconds)
    );
    const due = shouldHavePlanned - planned;
    if (due > 0) {
      const dispatch = Math.min(due, Math.max(0, maxInFlight - inFlight.size));
      const limited = due - dispatch;
      stats.generatorLimited += limited;
      live.generatorLimitedRequests = stats.generatorLimited;
      planned += due;
      for (let index = 0; index < dispatch; index += 1) {
        const task = requestOnce(target, endpoint, live, nextSequence(), fixture, stats, latencies, stats.attempted === 0)
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    }
    await delay(10, live.cancellation.signal).catch(() => undefined);
  }
  await Promise.allSettled(inFlight);
}

async function requestOnce(
  target: URL,
  endpoint: NormalizedEndpoint,
  live: LiveRun,
  sequence: number,
  fixture: unknown,
  stats?: MutableRunStats,
  latencies?: LatencySamples,
  captureResponse = false
): Promise<void> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('Request timed out.')), endpoint.timeoutMs);
  timeout.unref();
  const cancel = () => abort.abort(live.cancellation.signal.reason);
  if (live.cancellation.signal.aborted) cancel();
  else live.cancellation.signal.addEventListener('abort', cancel, { once: true });
  const began = performance.now();
  if (stats) { stats.attempted += 1; live.attemptedRequests = stats.attempted; }
  try {
    const dynamic = endpoint.request?.({ sequence, fixture, runId: live.id });
    if (dynamic !== undefined && (!dynamic || typeof dynamic !== 'object' || Array.isArray(dynamic))) throw new TypeError('Endpoint request() must return an object.');
    const path = dynamic?.path ?? endpoint.path;
    validateRelativePath(path, endpoint.id);
    const headers = { ...endpoint.headers, ...normalizeHeaders(dynamic?.headers, endpoint.id) };
    let body: string | undefined;
    const bodyValue = dynamic && Object.prototype.hasOwnProperty.call(dynamic, 'body') ? dynamic.body : endpoint.body;
    if (bodyValue !== undefined) {
      body = JSON.stringify(bodyValue);
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
    const response = await fetch(new URL(path, target), { method: endpoint.method, headers, body, signal: abort.signal });
    const sample = await readResponse(response, captureResponse);
    if (stats) {
      const code = String(response.status);
      stats.statusCodes[code] = (stats.statusCodes[code] ?? 0) + 1;
      if (captureResponse && stats.responseSample === undefined) stats.responseSample = sample;
      if (response.ok) stats.successful += 1;
      else stats.failed += 1;
    }
  } catch {
    if (stats) {
      stats.failed += 1;
      stats.statusCodes.network_error = (stats.statusCodes.network_error ?? 0) + 1;
    }
  } finally {
    clearTimeout(timeout);
    live.cancellation.signal.removeEventListener('abort', cancel);
    if (stats && latencies) {
      const duration = performance.now() - began;
      stats.completed += 1;
      stats.latencyTotal += duration;
      stats.latencyMin = Math.min(stats.latencyMin, duration);
      stats.latencyMax = Math.max(stats.latencyMax, duration);
      latencies.add(duration);
      live.completedRequests = stats.completed;
      live.successfulRequests = stats.successful;
      live.failedRequests = stats.failed;
    }
  }
}

async function readResponse(response: Response, capture: boolean): Promise<string | undefined> {
  if (!response.body) return capture ? '' : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < 16_384) {
    const { value, done } = await reader.read();
    if (done) break;
    if (capture) chunks.push(value);
    size += value.byteLength;
  }
  if (size >= 16_384) await reader.cancel();
  if (!capture) return undefined;
  const joined = new Uint8Array(Math.min(size, 16_384));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, joined.length - offset);
    joined.set(part, offset);
    offset += part.length;
    if (offset >= joined.length) break;
  }
  return new TextDecoder().decode(joined);
}

function controllerImpacts(
  before: Readonly<Record<string, ControllerBaseline>>,
  after: MetricsSnapshot | undefined,
  peaks: ReadonlyMap<string, ControllerPeak>
): LazphoControllerImpact[] {
  const output: LazphoControllerImpact[] = [];
  for (const [name, current] of Object.entries(after?.controllers ?? {})) {
    const previous = before[name];
    const peak = peaks.get(name) ?? { active: 0, queued: 0 };
    output.push(Object.freeze({
      name,
      limit: current.limit,
      maxQueueSize: current.maxQueueSize,
      peakActive: peak.active,
      peakQueued: peak.queued,
      completed: delta(current, previous, 'completed'),
      failed: delta(current, previous, 'failed'),
      rejected: delta(current, previous, 'rejected'),
      timedOut: delta(current, previous, 'timedOut'),
      stayedWithinLimit: peak.active <= current.limit
    }));
  }
  return output;
}

function controllerBaselines(snapshot: MetricsSnapshot | undefined): Readonly<Record<string, ControllerBaseline>> {
  const output: Record<string, ControllerBaseline> = {};
  for (const [name, controller] of Object.entries(snapshot?.controllers ?? {})) {
    output[name] = {
      completed: controller.completed,
      failed: controller.failed,
      rejected: controller.rejected,
      timedOut: controller.timedOut
    };
  }
  return output;
}

function delta(current: ConcurrencyMetrics, previous: ControllerBaseline | undefined, key: 'completed' | 'failed' | 'rejected' | 'timedOut'): number {
  return Math.max(0, current[key] - (previous?.[key] ?? 0));
}

function interpret(controllers: readonly LazphoControllerImpact[], stats: MutableRunStats, profile: Required<LazphoLoadProfile>): string[] {
  const messages: string[] = [];
  if (profile.mode === 'load' && stats.generatorLimited > 0) messages.push('The local generator did not achieve the requested rate; scale out generators before drawing target-RPS conclusions.');
  for (const controller of controllers) {
    if (controller.peakActive > 0 && controller.stayedWithinLimit) messages.push(`${controller.name} kept observed active work at ${controller.peakActive}, within its limit of ${controller.limit}.`);
    else if (controller.completed > 0) messages.push(`${controller.name} completed ${controller.completed} protected operations; they settled too quickly for the 20 ms peak sampler to observe active work.`);
    if (controller.peakQueued > 0) messages.push(`${controller.name} absorbed a peak queue of ${controller.peakQueued}, within its bounded capacity of ${controller.maxQueueSize}.`);
    if (controller.rejected > 0 || controller.timedOut > 0) messages.push(`${controller.name} shed ${controller.rejected} requests and timed out ${controller.timedOut} instead of allowing unbounded pressure.`);
  }
  if (!controllers.length) messages.push('No Lazpho metrics provider was connected, so this run measures HTTP behavior only.');
  else if (controllers.every((controller) => controller.peakQueued === 0 && controller.rejected === 0 && controller.timedOut === 0)) messages.push('No Lazpho saturation occurred; this run validates only the healthy path, not overload protection.');
  return messages;
}

function normalizeTarget(value: string, allowRemote: boolean): URL {
  let target: URL;
  try { target = new URL(value); } catch { throw new TypeError('targetBaseUrl must be an absolute HTTP URL.'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new TypeError('targetBaseUrl must be an HTTP origin without credentials, path, query, or fragment.');
  }
  if (!allowRemote && !['127.0.0.1', '::1', 'localhost'].includes(target.hostname)) throw new RangeError('Remote load targets require allowRemoteTarget: true.');
  return target;
}

function normalizeEndpoints(input: readonly LazphoLoadEndpoint[]): readonly NormalizedEndpoint[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new RangeError('endpoints must contain 1 to 100 entries.');
  const ids = new Set<string>();
  return Object.freeze(input.map((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object') throw new TypeError('Each endpoint must be an object.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(endpoint.id)) throw new TypeError('Endpoint id must contain 1 to 128 safe characters.');
    if (ids.has(endpoint.id)) throw new RangeError(`Duplicate endpoint id: ${endpoint.id}.`);
    ids.add(endpoint.id);
    const method = String(endpoint.method).toUpperCase() as LazphoLoadEndpoint['method'];
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError(`Endpoint ${endpoint.id} has an unsupported method.`);
    validateRelativePath(endpoint.path, endpoint.id);
    if (typeof endpoint.description !== 'string' || endpoint.description.length === 0 || endpoint.description.length > 256) throw new TypeError(`Endpoint ${endpoint.id} description must contain 1 to 256 characters.`);
    if (typeof endpoint.safe !== 'boolean') throw new TypeError(`Endpoint ${endpoint.id} safe must be explicit.`);
    const headers = normalizeHeaders(endpoint.headers, endpoint.id);
    const timeoutMs = boundedInteger(endpoint.timeoutMs ?? 5_000, 1, 60_000, `Endpoint ${endpoint.id} timeoutMs`);
    if (endpoint.body !== undefined) JSON.stringify(endpoint.body);
    for (const callback of ['setup', 'request', 'cleanup'] as const) {
      if (endpoint[callback] !== undefined && typeof endpoint[callback] !== 'function') throw new TypeError(`Endpoint ${endpoint.id} ${callback} must be a function.`);
    }
    return Object.freeze({ ...endpoint, method, headers: Object.freeze(headers), timeoutMs });
  }));
}

function validateRelativePath(path: string, endpointId: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 2_048) throw new TypeError(`Endpoint ${endpointId} path must be a relative URL beginning with /.`);
  const parsed = new URL(path, 'http://localhost');
  if (parsed.origin !== 'http://localhost' || parsed.username || parsed.password || parsed.hash) throw new TypeError(`Endpoint ${endpointId} path must remain within the configured target.`);
}

function normalizeHeaders(input: Readonly<Record<string, string>> | undefined, endpointId: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 4_096) throw new TypeError(`Endpoint ${endpointId} contains an invalid header.`);
    if (['host', 'content-length', 'connection'].includes(name.toLowerCase())) throw new TypeError(`Endpoint ${endpointId} cannot override ${name}.`);
    headers[name] = value;
  }
  return headers;
}

function normalizeProfile(input: LazphoLoadProfile): Required<LazphoLoadProfile> {
  if (!input || !['once', 'latency', 'load'].includes(input.mode)) throw new TypeError('profile.mode must be once, latency, or load.');
  return Object.freeze({
    mode: input.mode,
    requestsPerSecond: input.mode === 'load' ? boundedInteger(input.requestsPerSecond ?? 0, 1, 1_000_000, 'requestsPerSecond') : 1,
    durationSeconds: input.mode === 'load' ? boundedInteger(input.durationSeconds ?? 10, 1, 300, 'durationSeconds') : 1,
    requests: input.mode === 'latency' ? boundedInteger(input.requests ?? 50, 1, 10_000, 'requests') : 1
  });
}

async function writeReports(directory: string, result: LazphoLoadRunResult): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8'),
    writeFile(resolve(directory, `${result.id}.html`), reportHtml(result), 'utf8')
  ]);
}

function reportHtml(result: LazphoLoadRunResult): string {
  const rows = result.controllers.map((controller) => `<tr><td>${escapeHtml(controller.name)}</td><td>${controller.limit}</td><td>${controller.peakActive}</td><td>${controller.peakQueued}</td><td>${controller.rejected}</td><td>${controller.timedOut}</td></tr>`).join('');
  const findings = result.interpretation.map((message) => `<li>${escapeHtml(message)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lazpho Load Lab report</title><style>body{max-width:980px;margin:40px auto;padding:0 20px;color:#17201d;font:14px system-ui}h1{font-size:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.card{padding:14px;border:1px solid #dce4df;border-radius:10px}.value{font-size:22px;font-weight:700}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.note{background:#eef8f3;padding:16px;border-radius:10px}</style></head><body><h1>Lazpho Load Lab report</h1><p>${escapeHtml(result.method)} ${escapeHtml(result.path)} · ${escapeHtml(result.mode)} · ${escapeHtml(result.status)}</p><div class="grid">${[['Attempted',result.attemptedRequests],['Completed',result.completedRequests],['Achieved RPS',format(result.achievedRps)],['P50',format(result.p50Ms)+' ms'],['P95',format(result.p95Ms)+' ms'],['P99',format(result.p99Ms)+' ms'],['Failed',result.failedRequests],['Generator limited',result.generatorLimitedRequests]].map(([label,value])=>`<div class="card"><div>${label}</div><div class="value">${value}</div></div>`).join('')}</div><h2>What Lazpho did</h2><div class="note"><ul>${findings}</ul></div><h2>Controller evidence</h2><table><thead><tr><th>Controller</th><th>Limit</th><th>Peak active</th><th>Peak queued</th><th>Rejected</th><th>Timed out</th></tr></thead><tbody>${rows}</tbody></table><h2>Configuration and results</h2><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></body></html>`;
}

function dashboardHtml(apiToken: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lazpho Load Lab</title><style>
  :root{color-scheme:dark;--bg:#07120f;--panel:#10231d;--line:#28483d;--text:#edf8f3;--muted:#99b7aa;--accent:#35d399;--danger:#ff8c82}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#123428,var(--bg) 55%);color:var(--text);font:14px system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px}h1{font-size:34px;margin:0}.muted{color:var(--muted)}.toolbar,.endpoint,.summary,.history{background:rgba(16,35,29,.96);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}.toolbar{display:flex;gap:12px;align-items:end;flex-wrap:wrap}label{display:grid;gap:5px;color:var(--muted)}select,input,button{border:1px solid var(--line);border-radius:7px;background:#17382d;color:var(--text);padding:8px 11px}button{cursor:pointer;font-weight:700}button.primary{background:var(--accent);color:#052016;border-color:var(--accent)}button:disabled{opacity:.4;cursor:not-allowed}.path{font:600 15px ui-monospace,monospace}.method{display:inline-block;min-width:62px;color:var(--accent)}.actions{display:flex;gap:8px;margin-top:13px}.unsafe{color:var(--danger)}.managed{color:var(--accent);margin-top:9px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}.metric{background:#0c1b17;padding:12px;border-radius:8px}.value{font-size:21px;font-weight:750}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}a{color:var(--accent)}#notice{min-height:20px;margin-top:10px}</style></head><body><main><h1>Lazpho Load Lab</h1><p class="muted">Controlled endpoint checks and evidence of bounded application behavior. Requested RPS is never confused with achieved RPS.</p><div class="toolbar"><label>Load target<select id="rps"><option value="10000">10k RPS</option><option value="50000">50k RPS</option><option value="100000">100k RPS</option><option value="1000000">1m RPS</option></select></label><label>Duration<input id="duration" type="number" min="1" max="300" value="10"></label><button id="cancel">Cancel active run</button><button id="reset">Reset history</button></div><div id="notice" class="muted"></div><section id="active" class="summary"></section><section id="endpoints"></section><section class="history"><h2>Reports</h2><div style="overflow:auto"><table><thead><tr><th>Endpoint</th><th>Mode</th><th>Status</th><th>Achieved RPS</th><th>P95</th><th>Failures</th><th>Report</th></tr></thead><tbody id="history"></tbody></table></div></section><script>
  const token=${JSON.stringify(apiToken)},q=s=>document.querySelector(s);async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-lazpho-dashboard-token':token},body:body&&JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.status||'Request failed');return data}function button(text,handler,disabled=false){const b=document.createElement('button');b.textContent=text;b.disabled=disabled;b.onclick=handler;return b}async function run(endpointId,mode){try{await post('/api/run',{endpointId,profile:{mode,requestsPerSecond:Number(q('#rps').value),durationSeconds:Number(q('#duration').value),requests:50}});notice('Run started')}catch(e){notice(e.message,true)}await refresh()}function notice(value,error=false){q('#notice').textContent=value;q('#notice').style.color=error?'var(--danger)':''}function metric(label,value){const d=document.createElement('div');d.className='metric';const l=document.createElement('div');l.className='muted';l.textContent=label;const v=document.createElement('div');v.className='value';v.textContent=value;d.append(l,v);return d}async function refresh(){const s=await fetch('/api/state').then(r=>r.json());const active=q('#active');active.replaceChildren();const title=document.createElement('h2');title.textContent=s.active?'Active run':'Idle';active.append(title);const grid=document.createElement('div');grid.className='grid';for(const [label,value] of s.active?[['Endpoint',s.active.endpointId],['Mode',s.active.mode],['Attempted',s.active.attemptedRequests],['Completed',s.active.completedRequests],['Success',s.active.successfulRequests],['Failed',s.active.failedRequests],['Generator limited',s.active.generatorLimitedRequests]]:[['Target',s.targetBaseUrl],['Registered APIs',s.endpoints.length]])grid.append(metric(label,value));active.append(grid);const list=q('#endpoints');if(!list.children.length){for(const e of s.endpoints){const card=document.createElement('article');card.className='endpoint';const path=document.createElement('div');path.className='path';const method=document.createElement('span');method.className='method';method.textContent=e.method;path.append(method,document.createTextNode(e.path));const desc=document.createElement('p');desc.className='muted';desc.textContent=e.description;const actions=document.createElement('div');actions.className='actions';actions.append(button('Send once',()=>run(e.id,'once'),!e.safe),button('Test latency',()=>run(e.id,'latency'),!e.safe),button('Load test',()=>run(e.id,'load'),!e.safe));card.append(path,desc,actions);if(!e.safe){const warning=document.createElement('div');warning.className='unsafe';warning.textContent='Disabled: application has not marked this endpoint safe for automated execution.';card.append(warning)}else if(e.fixtureManaged){const managed=document.createElement('div');managed.className='managed';managed.textContent='Managed fixture: setup and cleanup stay application-owned.';card.append(managed)}list.append(card)}}const history=q('#history');history.replaceChildren();for(const r of [...s.history].reverse()){const tr=document.createElement('tr');for(const value of [r.endpointId,r.mode,r.status,Math.round(r.achievedRps),Math.round(r.p95Ms)+' ms',r.failedRequests]){const td=document.createElement('td');td.textContent=value;tr.append(td)}const links=document.createElement('td');const html=document.createElement('a');html.href='/api/reports/'+r.id+'.html';html.textContent='HTML';html.target='_blank';const json=document.createElement('a');json.href='/api/reports/'+r.id+'.json';json.textContent='JSON';json.style.marginLeft='10px';links.append(html,json);tr.append(links);history.append(tr)}}q('#cancel').onclick=()=>post('/api/cancel').then(refresh).catch(e=>notice(e.message,true));q('#reset').onclick=()=>post('/api/reset').then(()=>{q('#endpoints').replaceChildren();refresh()}).catch(e=>notice(e.message,true));refresh();setInterval(refresh,500);
  </script></main></body></html>`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new RangeError('Request body exceeds 16 KiB.');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('JSON body must be an object.');
  return value as Record<string, unknown>;
}

function safeToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolvePromise(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
    server.closeIdleConnections();
  });
}

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener('abort', aborted); resolvePromise(); }
    function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function runHook<T>(operation: (signal: AbortSignal) => Promise<T | undefined> | T | undefined, timeoutMs: number, callerSignal?: AbortSignal): Promise<T | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Load Lab endpoint hook timed out.')), timeoutMs);
  timeout.unref();
  const cancel = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function format(value: number): string { return Number.isFinite(value) ? value.toFixed(1) : '0.0'; }
