import type { ConcurrencyController, RunContext, RunOptions } from './types.js';

export interface ProtectedFunctionOptions<This> extends RunOptions {
  /** Explicit receiver for object methods. Omit for ordinary functions. */
  thisArg?: This;
}

export interface ProtectedFunction<Args extends unknown[], Result> {
  (...args: Args): Promise<Awaited<Result>>;
  /** Invoke with shallow per-call overrides; `retry` replaces the static retry object. */
  run(options: RunOptions, ...args: Args): Promise<Awaited<Result>>;
}

export function createProtectedFunction<This, Args extends unknown[], Result>(
  controller: ConcurrencyController,
  operation: (this: This, context: RunContext, ...args: Args) => Result,
  options: ProtectedFunctionOptions<This> = {}
): ProtectedFunction<Args, Result> {
  const { thisArg, ...defaults } = options;
  const invoke = (overrides: RunOptions | undefined, args: Args): Promise<Awaited<Result>> => controller.run(
    (context) => operation.apply(thisArg as This, [context, ...args]),
    overrides ? { ...defaults, ...overrides } : defaults
  ) as Promise<Awaited<Result>>;
  const protectedFunction = ((...args: Args) => invoke(undefined, args)) as ProtectedFunction<Args, Result>;
  protectedFunction.run = (overrides: RunOptions, ...args: Args) => invoke(overrides, args);
  return protectedFunction;
}
