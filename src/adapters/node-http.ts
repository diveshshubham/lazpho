import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Factory } from '../types.js';

export type NodeHttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export interface NodeHttpAdapterOptions {
  route?: (request: IncomingMessage) => string;
}

export interface RequestAbortHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Bridges Node request/response disconnect events to an AbortSignal. */
export function createRequestAbortSignal(request: IncomingMessage, response?: ServerResponse): RequestAbortHandle {
  const controller = new AbortController();
  let disposed = false;
  const abort = (reason: string): void => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
    dispose();
  };
  const onAborted = () => abort('Incoming HTTP request was aborted.');
  const onRequestClose = () => {
    if (request.aborted || !request.complete) abort('Incoming HTTP request closed before completion.');
    else if (!response) dispose();
  };
  const onSocketClose = () => abort('Incoming HTTP connection closed.');
  const onResponseFinish = () => dispose();
  const onResponseClose = () => {
    if (!response?.writableFinished) abort('Outgoing HTTP response closed before completion.');
    else dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    request.removeListener('aborted', onAborted);
    request.removeListener('close', onRequestClose);
    request.socket.removeListener('close', onSocketClose);
    response?.removeListener('finish', onResponseFinish);
    response?.removeListener('close', onResponseClose);
  };
  request.once('aborted', onAborted);
  request.once('close', onRequestClose);
  request.socket.once('close', onSocketClose);
  response?.once('finish', onResponseFinish);
  response?.once('close', onResponseClose);
  if (request.aborted || (request.destroyed && !request.complete)) {
    abort('Incoming HTTP request was already aborted.');
  }
  return { signal: controller.signal, dispose };
}

export function instrumentNodeHttp(
  factory: Factory,
  handler: NodeHttpHandler,
  options: NodeHttpAdapterOptions = {}
): NodeHttpHandler {
  return async (request, response): Promise<void> => {
    const route = safeRoute(request, options.route);
    const timer = factory.startRequest(route, request.method ?? 'UNKNOWN');
    let finished = false;
    const finish = (statusCode: number): void => {
      if (finished) return;
      finished = true;
      timer.finish(statusCode);
    };

    const onFinish = () => { cleanup(); finish(response.statusCode); };
    const onClose = () => { cleanup(); finish(response.statusCode || 499); };
    const cleanup = () => {
      response.removeListener('finish', onFinish);
      response.removeListener('close', onClose);
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
    try {
      await handler(request, response);
    } catch (error) {
      cleanup();
      finish(500);
      throw error;
    }
  };
}

function safeRoute(request: IncomingMessage, resolver?: (request: IncomingMessage) => string): string {
  try {
    return resolver?.(request) ?? request.url?.split('?')[0] ?? '__unknown__';
  } catch {
    return '__unknown__';
  }
}
