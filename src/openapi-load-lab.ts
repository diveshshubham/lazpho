import type { LazphoLoadEndpoint, LazphoLoadLab, LazphoLoadLabOptions } from './load-lab.js';
import { startLazphoLoadLab } from './load-lab.js';

const OPENAPI_METHODS = Object.freeze(['get', 'head', 'post', 'put', 'patch', 'delete'] as const);
const AUTOMATICALLY_SAFE_METHODS = new Set<string>(['get', 'head']);
const MAX_OPENAPI_BYTES = 5 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface LazphoOpenApiDiscoveryOptions {
  /** Headers applied to generated requests. Values never appear in the dashboard catalog or reports. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LazphoOpenApiLoadLabOptions
  extends Omit<LazphoLoadLabOptions, 'endpoints'>,
    LazphoOpenApiDiscoveryOptions {
  /** OpenAPI JSON path on targetBaseUrl. Defaults to /openapi.json. */
  readonly openApiPath?: string;
  /** Optional already-parsed OpenAPI document, primarily for offline or framework integrations. */
  readonly document?: unknown;
  /** OpenAPI discovery timeout. Defaults to 5 seconds. */
  readonly discoveryTimeoutMs?: number;
}

/**
 * Conservatively converts an OpenAPI document into a Load Lab endpoint catalog.
 * Only GET/HEAD operations without unresolved required parameters are enabled automatically.
 */
export function discoverLazphoOpenApiEndpoints(
  document: unknown,
  options: LazphoOpenApiDiscoveryOptions = {},
): readonly LazphoLoadEndpoint[] {
  if (!isObject(document) || !isObject(document.paths)) {
    throw new TypeError('OpenAPI document must contain a paths object.');
  }
  const headers = normalizeHeaders(options.headers);
  const endpoints: LazphoLoadEndpoint[] = [];
  const identifiers = new Set<string>();

  for (const [requestPath, pathValue] of Object.entries(document.paths)) {
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || !isObject(pathValue)) continue;
    const pathParameters = arrayValue(pathValue.parameters);
    for (const method of OPENAPI_METHODS) {
      const operation = pathValue[method];
      if (!isObject(operation)) continue;
      const unresolved = unresolvedRequiredParameters(
        [...pathParameters, ...arrayValue(operation.parameters)],
        headers,
      );
      const hasPathTemplate = /\{[^}]+\}/.test(requestPath);
      const automaticallySafe =
        AUTOMATICALLY_SAFE_METHODS.has(method) && !hasPathTemplate && unresolved.length === 0;
      const requestedId =
        typeof operation.operationId === 'string' && operation.operationId.trim()
          ? operation.operationId
          : `${method}-${requestPath}`;
      const id = uniqueIdentifier(requestedId, identifiers);
      const summary =
        typeof operation.summary === 'string'
          ? operation.summary
          : typeof operation.description === 'string'
            ? operation.description
            : `${method.toUpperCase()} ${requestPath}`;
      const reason = !AUTOMATICALLY_SAFE_METHODS.has(method)
        ? 'Mutating operations require explicit application-owned fixture registration.'
        : hasPathTemplate
          ? 'Path parameters require explicit application-owned values.'
          : unresolved.length
            ? `Required parameters need values: ${unresolved.join(', ')}.`
            : undefined;

      endpoints.push(
        Object.freeze({
          id,
          method: method.toUpperCase() as LazphoLoadEndpoint['method'],
          path: requestPath,
          description: (reason ? `${summary} Disabled: ${reason}` : summary).slice(0, 256),
          safe: automaticallySafe,
          headers,
        }),
      );
    }
  }

  if (endpoints.length === 0) throw new RangeError('OpenAPI document contains no supported operations.');
  return Object.freeze(endpoints);
}

/** Discovers an OpenAPI JSON document and starts the standard bounded Load Lab dashboard. */
export async function startLazphoOpenApiLoadLab(
  options: LazphoOpenApiLoadLabOptions,
): Promise<LazphoLoadLab> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('OpenAPI Load Lab options are required.');
  }
  const targetBaseUrl = normalizeTarget(options.targetBaseUrl, options.allowRemoteTarget === true);
  const openApiPath = normalizeOpenApiPath(options.openApiPath ?? '/openapi.json');
  const headers = normalizeHeaders(options.headers);
  const discoveryTimeoutMs = boundedInteger(
    options.discoveryTimeoutMs ?? 5_000,
    100,
    120_000,
    'discoveryTimeoutMs',
  );
  const document =
    options.document ??
    (await fetchOpenApiDocument(targetBaseUrl, openApiPath, discoveryTimeoutMs, headers));
  const endpoints = discoverLazphoOpenApiEndpoints(document, { headers });
  const {
    document: _document,
    openApiPath: _openApiPath,
    discoveryTimeoutMs: _discoveryTimeoutMs,
    headers: _headers,
    ...loadLabOptions
  } = options;
  return startLazphoLoadLab({ ...loadLabOptions, targetBaseUrl, endpoints });
}

async function fetchOpenApiDocument(
  targetBaseUrl: string,
  openApiPath: string,
  timeoutMs: number,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('OpenAPI discovery timed out.')),
    timeoutMs,
  );
  timeout.unref();
  try {
    const response = await fetch(new URL(openApiPath, targetBaseUrl), {
      headers: { accept: 'application/json', ...headers },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAPI discovery returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_OPENAPI_BYTES) throw new RangeError('OpenAPI document exceeds 5 MiB.');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_OPENAPI_BYTES) {
      throw new RangeError('OpenAPI document exceeds 5 MiB.');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SyntaxError('OpenAPI endpoint did not return valid JSON.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTarget(input: string, allowRemote: boolean): string {
  const target = new URL(input);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new RangeError('targetBaseUrl must use HTTP or HTTPS.');
  }
  if (target.username || target.password) {
    throw new RangeError('targetBaseUrl must not contain credentials.');
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!allowRemote && !loopback.has(target.hostname)) {
    throw new RangeError(
      'Remote targets are disabled. Enable allowRemoteTarget only for an authorized environment.',
    );
  }
  return target.origin;
}

function normalizeOpenApiPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new RangeError('openApiPath must begin with exactly one slash.');
  }
  return value;
}

function normalizeHeaders(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!input) return Object.freeze({});
  const blocked = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);
  const entries = Object.entries(input);
  if (entries.length > 30) throw new RangeError('OpenAPI Load Lab accepts at most 30 headers.');
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || blocked.has(name.toLowerCase())) {
      throw new RangeError(`Invalid or blocked request header: ${name}.`);
    }
    if (typeof value !== 'string' || value.length > 4_096 || /[\r\n]/.test(value)) {
      throw new RangeError(`Invalid request header value: ${name}.`);
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

function unresolvedRequiredParameters(
  parameters: readonly unknown[],
  headers: Readonly<Record<string, string>>,
): string[] {
  const headerNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const unresolved: string[] = [];
  for (const parameter of parameters) {
    if (!isObject(parameter)) {
      unresolved.push('referenced parameter');
      continue;
    }
    if ('$ref' in parameter) {
      unresolved.push('referenced parameter');
      continue;
    }
    if (parameter.required !== true) continue;
    const name = typeof parameter.name === 'string' ? parameter.name : 'unnamed parameter';
    if (parameter.in === 'header' && headerNames.has(name.toLowerCase())) continue;
    unresolved.push(name);
  }
  return unresolved;
}

function uniqueIdentifier(value: string, identifiers: Set<string>): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'operation';
  let candidate = base;
  let suffix = 2;
  while (identifiers.has(candidate)) candidate = `${base}-${suffix++}`;
  identifiers.add(candidate);
  return candidate;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
