import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createFactory } from './factory.js';
import type {
  AdaptiveConcurrencyOptions,
  AdaptiveDecision,
  ClosedLoopAdaptiveConcurrencyController,
  ConcurrencyController,
  ConcurrencyOptions,
  Factory,
  FactoryOptions,
  MetricsSnapshot,
  RequestTimer,
  RunContext,
  RunOptions
} from './types.js';

export interface LazphoApplicationOptions {
  /** Uses an externally owned factory. Omit to let this application integration create and close one. */
  readonly factory?: Factory;
  readonly factoryOptions?: FactoryOptions;
  /** Stable capacity-pool names mapped to controller configuration. */
  readonly controllers?: Readonly<Record<string, Omit<ConcurrencyOptions, 'name'>>>;
  /** Named adaptive policies linked to one of the fixed controllers above. Evaluation remains application-owned. */
  readonly adaptiveControllers?: Readonly<Record<string, Omit<AdaptiveConcurrencyOptions, 'name' | 'controller'> & { readonly controller: string }>>;
  /** Stable route templates mapped to the capacity pools they can consume. */
  readonly routeControllers?: Readonly<Record<string, readonly string[]>>;
  /** Close an externally supplied factory when the application closes. Defaults to false. */
  readonly closeFactoryOnShutdown?: boolean;
}

export interface LazphoApplication {
  readonly factory: Factory;
  readonly controllers: Readonly<Record<string, ConcurrencyController>>;
  readonly adaptiveControllers: Readonly<Record<string, ClosedLoopAdaptiveConcurrencyController>>;
  readonly routeControllers: Readonly<Record<string, readonly string[]>>;
  controller(name: string): ConcurrencyController;
  run<T>(controller: string, operation: (context: RunContext) => Promise<T> | T, options?: RunOptions): Promise<T>;
  evaluateAdaptive(timestamp?: number): Readonly<Record<string, AdaptiveDecision>>;
  startRequest(route: string, method: string): RequestTimer;
  getMetrics(): MetricsSnapshot;
  resetRequestMetrics(): void;
  close(): Promise<void>;
}

export interface LazphoScenarioContext {
  readonly application: LazphoApplication;
  readonly signal: AbortSignal;
}

export interface LazphoScenarioResult {
  /** Bounded, non-negative counters such as success, failed, timeout, or rejected. */
  readonly outcomes: Readonly<Record<string, number>>;
}

export interface LazphoScenario {
  readonly name: string;
  readonly description: string;
  /** Maximum callback time before its signal is aborted. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  run(context: LazphoScenarioContext): Promise<LazphoScenarioResult> | LazphoScenarioResult;
}

export interface LazphoDashboardOptions {
  readonly application: LazphoApplication;
  /** Loopback host only. Defaults to 127.0.0.1. */
  readonly host?: '127.0.0.1' | '::1' | 'localhost';
  /** Defaults to 1912. Use 0 only for an ephemeral test port. */
  readonly port?: number;
  readonly scenarios?: readonly LazphoScenario[];
  /** Maximum completed runs retained in memory. Defaults to 50. */
  readonly historySize?: number;
  /** Optional mutation token. Omit to generate a random token embedded only in the served dashboard page. */
  readonly apiToken?: string;
  onScenarioError?(error: unknown, scenario: string): void;
}

export interface LazphoScenarioRun {
  readonly scenario: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly result?: LazphoScenarioResult;
}

export interface LazphoDashboardState {
  readonly runningScenario: string | null;
  readonly scenarios: readonly Readonly<{ name: string; description: string; timeoutMs: number }>[];
  readonly history: readonly LazphoScenarioRun[];
  readonly metrics: MetricsSnapshot;
  readonly diagnoses: Readonly<Record<string, string>>;
}

export interface LazphoDashboard {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  state(): LazphoDashboardState;
  close(): Promise<void>;
}

export function createLazphoApplication(options: LazphoApplicationOptions = {}): LazphoApplication {
  if (options.factory && options.factoryOptions) throw new TypeError('factory and factoryOptions cannot be supplied together.');
  const controllerDefinitions = Object.entries(options.controllers ?? {});
  const controllerNames = new Set(controllerDefinitions.map(([name]) => name));
  for (const name of controllerNames) validateName(name, 'controller');
  for (const [route, names] of Object.entries(options.routeControllers ?? {})) {
    validateRoute(route);
    if (!Array.isArray(names) || names.length > 16) throw new RangeError(`routeControllers[${route}] must contain at most 16 controller names.`);
    for (const name of names) {
      if (!controllerNames.has(name)) throw new RangeError(`routeControllers[${route}] references unknown controller ${name}.`);
    }
  }
  const adaptiveDefinitions = Object.entries(options.adaptiveControllers ?? {});
  for (const [name, adaptiveOptions] of adaptiveDefinitions) {
    validateName(name, 'adaptive controller');
    if (!controllerNames.has(adaptiveOptions.controller)) throw new RangeError(`Adaptive controller ${name} references unknown controller ${adaptiveOptions.controller}.`);
  }
  const factory = options.factory ?? createFactory(options.factoryOptions);
  const ownsFactory = !options.factory || options.closeFactoryOnShutdown === true;
  const controllers: Record<string, ConcurrencyController> = {};
  for (const [name, controllerOptions] of controllerDefinitions) {
    controllers[name] = factory.concurrency({ ...controllerOptions, name });
  }
  const adaptiveControllers: Record<string, ClosedLoopAdaptiveConcurrencyController> = {};
  for (const [name, adaptiveOptions] of adaptiveDefinitions) {
    const { controller, ...configuration } = adaptiveOptions;
    adaptiveControllers[name] = factory.adaptiveConcurrency({ ...configuration, name, controller: controllers[controller] });
  }
  const routeControllers: Record<string, readonly string[]> = {};
  for (const [route, names] of Object.entries(options.routeControllers ?? {})) {
    validateRoute(route);
    const unique = [...new Set(names)];
    routeControllers[route] = Object.freeze(unique);
  }
  let closePromise: Promise<void> | undefined;
  const application: LazphoApplication = {
    factory,
    controllers: Object.freeze(controllers),
    adaptiveControllers: Object.freeze(adaptiveControllers),
    routeControllers: Object.freeze(routeControllers),
    controller(name: string): ConcurrencyController {
      const controller = controllers[name];
      if (!controller) throw new RangeError(`Unknown Lazpho controller: ${name}.`);
      return controller;
    },
    run<T>(name: string, operation: (context: RunContext) => Promise<T> | T, runOptions?: RunOptions): Promise<T> {
      return application.controller(name).run(operation, runOptions);
    },
    evaluateAdaptive(timestamp = Date.now()): Readonly<Record<string, AdaptiveDecision>> {
      const decisions: Record<string, AdaptiveDecision> = {};
      for (const [name, controller] of Object.entries(adaptiveControllers)) decisions[name] = controller.evaluateFromMetrics(timestamp);
      return Object.freeze(decisions);
    },
    startRequest(route: string, method: string): RequestTimer {
      validateRoute(route);
      if (typeof method !== 'string' || method.length === 0 || method.length > 32) throw new TypeError('method must contain 1 to 32 characters.');
      return factory.startRequest(route, method);
    },
    getMetrics(): MetricsSnapshot { return factory.getMetrics(); },
    resetRequestMetrics(): void { factory.reset(); },
    close(): Promise<void> {
      closePromise ??= Promise.all([
        ...Object.values(adaptiveControllers).map((controller) => controller.close()),
        ...Object.values(controllers).map((controller) => controller.close())
      ]).then(() => {
        if (ownsFactory) factory.close();
      });
      return closePromise;
    }
  };
  return Object.freeze(application);
}

export async function startLazphoDashboard(options: LazphoDashboardOptions): Promise<LazphoDashboard> {
  if (!options?.application) throw new TypeError('application is required.');
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new RangeError('Lazpho dashboard may bind only to a loopback host.');
  const requestedPort = options.port ?? 1912;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new RangeError('port must be an integer from 0 to 65535.');
  const historySize = options.historySize ?? 50;
  if (!Number.isInteger(historySize) || historySize < 1 || historySize > 1_000) throw new RangeError('historySize must be an integer from 1 to 1000.');
  const apiToken = options.apiToken ?? randomBytes(32).toString('base64url');
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(apiToken)) throw new RangeError('apiToken must contain 16 to 256 base64url-safe characters.');
  const scenarios = normalizeScenarios(options.scenarios ?? []);
  const history: LazphoScenarioRun[] = [];
  let active: { name: string; cancellation: AbortController } | undefined;
  let closed = false;
  let origin = '';

  const state = (): LazphoDashboardState => Object.freeze({
    runningScenario: active?.name ?? null,
    scenarios: Object.freeze(scenarios.map(({ name, description, timeoutMs }) => Object.freeze({ name, description, timeoutMs }))),
    history: Object.freeze(history.map((entry) => Object.freeze({ ...entry, result: entry.result && freezeResult(entry.result) }))),
    metrics: options.application.getMetrics(),
    diagnoses: Object.freeze(diagnose(options.application))
  });

  const runOne = async (scenario: NormalizedScenario): Promise<void> => {
    const began = Date.now();
    const cancellation = active?.cancellation;
    if (!cancellation) return;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancellation.abort(new Error('Scenario timed out.')); }, scenario.timeoutMs);
    timer.unref();
    try {
      const result = normalizeResult(await raceCancellation(
        () => scenario.run({ application: options.application, signal: cancellation.signal }),
        cancellation.signal
      ));
      remember({ scenario: scenario.name, startedAt: began, finishedAt: Date.now(), durationMs: Date.now() - began, status: cancellation.signal.aborted ? (timedOut ? 'timed_out' : 'cancelled') : 'completed', result });
    } catch (error) {
      const status = cancellation.signal.aborted ? (timedOut ? 'timed_out' : 'cancelled') : 'failed';
      remember({ scenario: scenario.name, startedAt: began, finishedAt: Date.now(), durationMs: Date.now() - began, status });
      try { options.onScenarioError?.(error, scenario.name); } catch { }
    } finally {
      clearTimeout(timer);
    }
  };

  const remember = (entry: LazphoScenarioRun): void => {
    history.push(Object.freeze(entry));
    while (history.length > historySize) history.shift();
  };

  const begin = (name: string): 'started' | 'busy' | 'unknown' => {
    if (active) return 'busy';
    const selected = name === 'all' ? scenarios : scenarios.filter((scenario) => scenario.name === name);
    if (selected.length === 0) return 'unknown';
    const cancellation = new AbortController();
    active = { name, cancellation };
    void (async () => {
      try {
        for (const scenario of selected) {
          if (cancellation.signal.aborted) break;
          await runOne(scenario);
        }
      } finally {
        active = undefined;
      }
    })();
    return 'started';
  };

  const server = createServer((request, response) => {
    void Promise.resolve().then(() => {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (origin && request.headers.host !== new URL(origin).host) return json(response, 421, { status: 'invalid_host' });
      if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { status: 'invalid_origin' });
      if (request.method === 'GET' && url.pathname === '/') return html(response, dashboardHtml(apiToken));
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, state());
      if (request.method === 'GET' && url.pathname === '/api/scenarios') return json(response, 200, state().scenarios);
      if (request.method === 'POST' && !safeToken(request.headers['x-lazpho-dashboard-token'], apiToken)) return json(response, 403, { status: 'forbidden' });
      if (request.method === 'POST' && url.pathname === '/api/run') {
        const result = begin(url.searchParams.get('scenario') ?? 'all');
        return json(response, result === 'started' ? 202 : result === 'busy' ? 409 : 404, { status: result });
      }
      if (request.method === 'POST' && url.pathname === '/api/cancel') {
        if (!active) return json(response, 409, { status: 'idle' });
        active.cancellation.abort(new Error('Scenario cancelled.'));
        return json(response, 202, { status: 'cancelling' });
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        if (active) return json(response, 409, { status: 'busy' });
        history.length = 0;
        options.application.resetRequestMetrics();
        return json(response, 200, { status: 'reset' });
      }
      return json(response, 404, { status: 'not_found' });
    }).catch(() => json(response, 500, { status: 'internal_error' }));
  });
  await listen(server, requestedPort, host);
  const address = server.address() as AddressInfo;
  const displayHost = host === '::1' ? '[::1]' : host;
  origin = `http://${displayHost}:${address.port}`;
  const dashboard: LazphoDashboard = Object.freeze({
    host,
    port: address.port,
    url: origin,
    state,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      active?.cancellation.abort(new Error('Dashboard closed.'));
      await closeServer(server);
    }
  });
  return dashboard;
}

interface NormalizedScenario extends LazphoScenario { readonly timeoutMs: number }

function normalizeScenarios(input: readonly LazphoScenario[]): readonly NormalizedScenario[] {
  if (!Array.isArray(input) || input.length > 100) throw new RangeError('scenarios must contain at most 100 entries.');
  const names = new Set<string>();
  return Object.freeze(input.map((scenario) => {
    validateName(scenario.name, 'scenario');
    if (scenario.name === 'all') throw new RangeError('Scenario name all is reserved.');
    if (names.has(scenario.name)) throw new RangeError(`Duplicate scenario name: ${scenario.name}.`);
    names.add(scenario.name);
    if (typeof scenario.description !== 'string' || scenario.description.length === 0 || scenario.description.length > 256) throw new TypeError(`Scenario ${scenario.name} description must contain 1 to 256 characters.`);
    if (typeof scenario.run !== 'function') throw new TypeError(`Scenario ${scenario.name} run must be a function.`);
    const timeoutMs = scenario.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new RangeError(`Scenario ${scenario.name} timeoutMs must be between 1 and 3600000.`);
    return Object.freeze({ ...scenario, timeoutMs });
  }));
}

function normalizeResult(result: LazphoScenarioResult): LazphoScenarioResult {
  if (!result || typeof result !== 'object' || !result.outcomes || typeof result.outcomes !== 'object') throw new TypeError('Scenario result must contain an outcomes record.');
  const entries = Object.entries(result.outcomes);
  if (entries.length > 32) throw new RangeError('Scenario outcomes must contain at most 32 counters.');
  const outcomes: Record<string, number> = {};
  for (const [name, count] of entries) {
    validateName(name, 'outcome');
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`Scenario outcome ${name} must be a non-negative safe integer.`);
    outcomes[name] = count;
  }
  return freezeResult({ outcomes });
}

async function raceCancellation<T>(operation: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function freezeResult(result: LazphoScenarioResult): LazphoScenarioResult {
  return Object.freeze({ outcomes: Object.freeze({ ...result.outcomes }) });
}

function diagnose(application: LazphoApplication): Record<string, string> {
  const metrics = application.getMetrics();
  const output: Record<string, string> = {};
  for (const [route, routeMetrics] of Object.entries(metrics.routes)) {
    const controllers = (application.routeControllers[route] ?? []).map((name) => metrics.controllers[name]).filter(Boolean);
    if (metrics.resources.eventLoopLagMs > 50 && routeMetrics.p95Ms > 50) output[route] = 'event_loop_pressure';
    else if (controllers.some((controller) => controller.queueWait.p95Ms > Math.max(25, controller.execution.p95Ms))) output[route] = 'admission_queue';
    else if (controllers.some((controller) => controller.execution.p95Ms > 100)) output[route] = 'protected_execution';
    else if (routeMetrics.errors > 0) output[route] = 'request_failures';
    else if (controllers.length === 0) output[route] = 'unmapped_route';
    else output[route] = 'no_dominant_bottleneck';
  }
  return output;
}

function validateName(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError(`${label} name must contain 1 to 128 safe characters.`);
}

function validateRoute(route: string): void {
  if (typeof route !== 'string' || route.length === 0 || route.length > 512 || !route.startsWith('/')) throw new TypeError('route must be a stable template beginning with / and contain at most 512 characters.');
}

function safeToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
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
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(value);
}

function dashboardHtml(apiToken: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lazpho application dashboard</title><style>
  :root{color-scheme:dark;--bg:#07111f;--panel:#102138;--line:#29425f;--text:#eaf2ff;--muted:#98abc4;--accent:#38bdf8}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#07111f,#102644);color:var(--text);font:14px system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:24px}h1{margin:0 0 4px}.muted{color:var(--muted)}button{margin:4px;padding:8px 12px;border:1px solid var(--line);border-radius:7px;background:#183652;color:var(--text);cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.card,.panel{background:rgba(16,33,56,.95);border:1px solid var(--line);border-radius:10px;padding:14px}.value{font-size:24px;font-weight:700}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--line)}.scroll{overflow:auto}</style></head><body><main><h1>Lazpho application dashboard</h1><div class="muted">Loopback-only metrics and explicitly registered safe scenarios</div><div id="actions"></div><div class="grid" id="summary"></div><div class="panel"><h2>Routes</h2><div class="scroll"><table><thead><tr><th>Route</th><th>Requests</th><th>Errors</th><th>P50</th><th>P95</th><th>P99</th><th>Diagnosis</th></tr></thead><tbody id="routes"></tbody></table></div></div><div class="panel" style="margin-top:12px"><h2>Controllers</h2><div class="scroll"><table><thead><tr><th>Name</th><th>Limit</th><th>Active</th><th>Queued</th><th>Queue P95</th><th>Execution P95</th><th>Rejected</th><th>Timed out</th></tr></thead><tbody id="controllers"></tbody></table></div></div><div class="panel" style="margin-top:12px"><h2>Scenario history</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Status</th><th>Duration</th><th>Outcomes</th></tr></thead><tbody id="history"></tbody></table></div></div><script>
  const token=${JSON.stringify(apiToken)},q=s=>document.querySelector(s),td=(row)=>{const tr=document.createElement('tr');for(const value of row){const cell=document.createElement('td');cell.textContent=String(value);tr.append(cell)}return tr},ms=v=>Math.round(v||0)+' ms';async function post(path){await fetch(path,{method:'POST',headers:{'x-lazpho-dashboard-token':token}});await refresh()}async function refresh(){const s=await fetch('/api/state').then(r=>r.json());const a=q('#actions');a.replaceChildren();const all=document.createElement('button');all.textContent='run all';all.onclick=()=>post('/api/run?scenario=all');a.append(all);for(const item of s.scenarios){const b=document.createElement('button');b.textContent=item.name;b.title=item.description;b.onclick=()=>post('/api/run?scenario='+encodeURIComponent(item.name));a.append(b)}const cancel=document.createElement('button');cancel.textContent='cancel';cancel.onclick=()=>post('/api/cancel');a.append(cancel);const reset=document.createElement('button');reset.textContent='reset views';reset.onclick=()=>post('/api/reset');a.append(reset);q('#summary').innerHTML='';for(const pair of [['Running',s.runningScenario||'idle'],['Requests',s.metrics.totalRequests],['Route P95',ms(s.metrics.p95Ms)],['Event-loop lag',ms(s.metrics.resources.eventLoopLagMs)]]){const card=document.createElement('div');card.className='card';const label=document.createElement('div');label.className='muted';label.textContent=pair[0];const value=document.createElement('div');value.className='value';value.textContent=String(pair[1]);card.append(label,value);q('#summary').append(card)}const routes=q('#routes');routes.replaceChildren();for(const [name,m] of Object.entries(s.metrics.routes))routes.append(td([name,m.totalRequests,m.errors,ms(m.p50Ms),ms(m.p95Ms),ms(m.p99Ms),s.diagnoses[name]||'-']));const controllers=q('#controllers');controllers.replaceChildren();for(const [name,m] of Object.entries(s.metrics.controllers))controllers.append(td([name,m.limit,m.active,m.queued,ms(m.queueWait.p95Ms),ms(m.execution.p95Ms),m.rejected,m.timedOut]));const history=q('#history');history.replaceChildren();for(const run of s.history)history.append(td([run.scenario,run.status,ms(run.durationMs),JSON.stringify(run.result?.outcomes||{})]))}refresh();setInterval(refresh,1000);
  </script></main></body></html>`;
}
