import { classifyLazphoError, isLazphoError } from '../error-classification.js';
import type { ConcurrencyController, RunContext, RunOptions } from '../types.js';

export type LazphoFrameworkName = 'express' | 'fastify' | 'nestjs';

export interface LazphoRequestContext {
  readonly controller: ConcurrencyController;
  readonly framework: LazphoFrameworkName;
  readonly bulkhead?: string;
  run<T>(operation: (context: RunContext) => Promise<T> | T, options?: RunOptions): Promise<T>;
}

export interface LazphoHttpError {
  readonly statusCode: 503 | 504;
  readonly code: string;
}

/** Maps bounded Lazpho error categories without exposing messages or controller configuration. */
export function mapLazphoErrorToHttp(error: unknown): LazphoHttpError | undefined {
  if (!isLazphoError(error)) return undefined;
  const kind = classifyLazphoError(error);
  if (kind === 'aborted' || kind === 'queue_aborted') return undefined;
  if (kind === 'timeout' || kind === 'queue_wait_timeout') return Object.freeze({ statusCode: 504, code: error.code });
  if (kind === 'queue_full' || kind === 'bulkhead_queue_full' || kind === 'breaker_open' || kind === 'lifecycle') {
    return Object.freeze({ statusCode: 503, code: error.code });
  }
  return undefined;
}

export function createLazphoRequestContext(
  controller: ConcurrencyController,
  requestSignal: AbortSignal,
  framework: LazphoFrameworkName,
  bulkhead?: string
): LazphoRequestContext {
  return Object.freeze({
    controller,
    framework,
    bulkhead,
    async run<T>(operation: (context: RunContext) => Promise<T> | T, options: RunOptions = {}): Promise<T> {
      const combined = combineSignals(requestSignal, options.signal);
      try {
        return await controller.run(operation, {
          ...options,
          signal: combined.signal,
          bulkhead: options.bulkhead ?? bulkhead
        });
      } finally {
        combined.dispose();
      }
    }
  });
}

interface CombinedSignal { signal: AbortSignal; dispose(): void }

function combineSignals(requestSignal: AbortSignal, callerSignal?: AbortSignal): CombinedSignal {
  if (!callerSignal || callerSignal === requestSignal) return { signal: requestSignal, dispose: () => undefined };
  const controller = new AbortController();
  let disposed = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    requestSignal.removeEventListener('abort', abortFromRequest);
    callerSignal.removeEventListener('abort', abortFromCaller);
  };
  if (requestSignal.aborted) controller.abort(requestSignal.reason);
  else if (callerSignal.aborted) controller.abort(callerSignal.reason);
  else {
    requestSignal.addEventListener('abort', abortFromRequest, { once: true });
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  controller.signal.addEventListener('abort', dispose, { once: true });
  return { signal: controller.signal, dispose };
}
