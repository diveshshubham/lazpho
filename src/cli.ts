#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startLazphoOpenApiLoadLab,
  type LazphoOpenApiLoadLabOptions,
} from './openapi-load-lab.js';

export interface LazphoCliOptions {
  readonly targetBaseUrl: string;
  readonly openApiPath: string;
  readonly host: '127.0.0.1' | '::1' | 'localhost';
  readonly port: number;
  readonly allowRemoteTarget: boolean;
  readonly maxInFlight: number;
  readonly historySize: number;
  readonly discoveryTimeoutMs: number;
  readonly reportDirectory?: string;
  readonly apiToken?: string;
  readonly headers: Readonly<Record<string, string>>;
}

const HELP = `Lazpho Load Lab\n\nUsage:\n  lazpho load-lab --target <origin> [options]\n\nOptions:\n  --target <origin>          Application origin, for example http://127.0.0.1:4000\n  --openapi <path>          OpenAPI JSON path (default: /openapi.json)\n  --port <number>           Loopback dashboard port (default: 1913)\n  --host <loopback>         127.0.0.1, localhost, or ::1\n  --header <name:value>     Header applied to generated requests; repeatable\n  --header-env <name:ENV>  Read a header value from an environment variable; repeatable\n  --reports <directory>    Write standalone HTML and JSON reports\n  --max-in-flight <number> Bound local generator concurrency (default: 256)\n  --history-size <number>  Runs retained in memory (default: 50)\n  --discovery-timeout <ms> OpenAPI request timeout (default: 5000)\n  --api-token <token>      Fixed 16-256 character base64url dashboard token\n  --allow-remote           Permit an explicitly authorized non-loopback target\n  --help                   Show this help\n\nSafety:\n  OpenAPI discovery automatically enables only GET/HEAD operations without unresolved\n  required parameters. Mutations remain visible but disabled; register managed fixtures\n  through lazpho/load-lab when mutation testing is required.\n`;

export function parseLazphoCliArguments(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
):
  | Readonly<{ command: 'help' }>
  | Readonly<{ command: 'load-lab'; options: LazphoCliOptions }> {
  if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h')) {
    return Object.freeze({ command: 'help' });
  }
  const [command, ...tokens] = arguments_;
  if (command !== 'load-lab') throw new RangeError(`Unknown Lazpho command: ${command}.`);
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const booleanFlags = new Set(['allow-remote']);
  const valueFlags = new Set([
    'target',
    'openapi',
    'port',
    'host',
    'header',
    'header-env',
    'reports',
    'max-in-flight',
    'history-size',
    'discovery-timeout',
    'api-token',
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new RangeError(`Unexpected argument: ${token}.`);
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (booleanFlags.has(name)) {
      if (equals !== -1) throw new RangeError(`--${name} does not accept a value.`);
      booleans.add(name);
      continue;
    }
    if (!valueFlags.has(name)) throw new RangeError(`Unknown option: --${name}.`);
    const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new RangeError(`--${name} requires a value.`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }

  const targetBaseUrl = last(values, 'target') ?? environment.LAZPHO_LOAD_LAB_TARGET;
  if (!targetBaseUrl) throw new RangeError('--target is required.');
  const host = last(values, 'host') ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new RangeError('--host must be 127.0.0.1, localhost, or ::1.');
  }
  const headers: Record<string, string> = {};
  const headerNames = new Set<string>();
  for (const header of values.get('header') ?? []) {
    const [name, value] = headerPair(header, '--header');
    addHeader(headers, headerNames, name, value);
  }
  for (const header of values.get('header-env') ?? []) {
    const [name, environmentName] = headerPair(header, '--header-env');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName)) {
      throw new RangeError('--header-env must reference a valid environment variable name.');
    }
    const value = environment[environmentName];
    if (!value) throw new RangeError(`Environment variable ${environmentName} is not set.`);
    addHeader(headers, headerNames, name, value);
  }

  return Object.freeze({
    command: 'load-lab',
    options: Object.freeze({
      targetBaseUrl,
      openApiPath: last(values, 'openapi') ?? '/openapi.json',
      host: host as LazphoCliOptions['host'],
      port: integer(values, 'port', 1913, 0, 65_535),
      allowRemoteTarget: booleans.has('allow-remote'),
      maxInFlight: integer(values, 'max-in-flight', 256, 1, 10_000),
      historySize: integer(values, 'history-size', 50, 1, 1_000),
      discoveryTimeoutMs: integer(values, 'discovery-timeout', 5_000, 100, 120_000),
      reportDirectory: last(values, 'reports'),
      apiToken: last(values, 'api-token'),
      headers: Object.freeze(headers),
    }),
  });
}

export async function runLazphoCli(arguments_: readonly string[]): Promise<void> {
  const parsed = parseLazphoCliArguments(arguments_);
  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const options: LazphoOpenApiLoadLabOptions = {
    ...parsed.options,
    reportDirectory: parsed.options.reportDirectory
      ? resolve(parsed.options.reportDirectory)
      : undefined,
  };
  const lab = await startLazphoOpenApiLoadLab(options);
  process.stdout.write(`Lazpho Load Lab: ${lab.url}\n`);
  process.stdout.write(`Target API: ${parsed.options.targetBaseUrl}\n`);
  process.stdout.write(`Discovered operations: ${lab.state().endpoints.length}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await lab.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

function last(values: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  return values.get(name)?.at(-1);
}

function headerPair(value: string, option: '--header' | '--header-env'): readonly [string, string] {
  const separator = value.indexOf(':');
  const name = value.slice(0, separator).trim();
  const content = value.slice(separator + 1).trim();
  if (separator < 1 || !name || !content) {
    throw new RangeError(`${option} must use name:value syntax.`);
  }
  return [name, content];
}

function addHeader(
  output: Record<string, string>,
  names: Set<string>,
  name: string,
  value: string,
): void {
  const normalizedName = name.toLowerCase();
  if (names.has(normalizedName)) throw new RangeError(`Duplicate request header: ${name}.`);
  names.add(normalizedName);
  output[name] = value;
}

function integer(
  values: ReadonlyMap<string, readonly string[]>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = last(values, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  runLazphoCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`lazpho: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
