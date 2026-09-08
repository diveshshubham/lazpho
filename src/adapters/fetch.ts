import type { ConcurrencyController, RetryOptions } from '../types.js';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProtectedFetchInit extends RequestInit {
  bulkhead?: string;
  timeoutMs?: number;
  retry?: RetryOptions;
}

export interface ProtectedFetchOptions {
  controller: ConcurrencyController;
  fetch?: FetchLike;
  defaults?: ProtectedFetchInit;
}

export type ProtectedFetch = (input: RequestInfo | URL, init?: ProtectedFetchInit) => Promise<Response>;

export function createProtectedFetch(options: ProtectedFetchOptions): ProtectedFetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new TypeError('A fetch implementation is required.');
  return (input, init = {}) => {
    const merged = { ...options.defaults, ...init };
    const { bulkhead, timeoutMs, retry, ...requestInit } = merged;
    const callerSignal = requestInit.signal ?? requestSignal(input);
    return options.controller.run(
      ({ signal }) => fetchImplementation(input, { ...requestInit, signal }),
      { bulkhead, timeoutMs, retry, signal: callerSignal ?? undefined }
    );
  };
}

function requestSignal(input: RequestInfo | URL): AbortSignal | null | undefined {
  if (typeof input !== 'object' || input === null || !('signal' in input)) return undefined;
  const signal = (input as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
