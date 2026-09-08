import { createServer } from 'node:http';
import { createFactory } from '../index.js';
import { instrumentNodeHttp } from '../adapters/node-http.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const factory = createFactory();
const work = factory.concurrency({ name: 'demo-work', limit: 10, maxQueueSize: 2_000 });
const adaptive = factory.adaptiveConcurrency({
  name: 'demo-control',
  controller: work,
  minLimit: 10,
  maxLimit: 100,
  targetP95Ms: 80,
  maxErrorRate: 0.01,
  mode: 'auto',
  evaluationIntervalMs: 2_000,
  increaseStep: 10,
  decreaseFactor: 0.8,
  errorDecreaseFactor: 0.5,
  ewmaAlpha: 1,
  healthyEvaluations: 1,
  unhealthyEvaluations: 1
});

let simulatedActive = 0;
let operationNumber = 0;

const server = createServer(instrumentNodeHttp(factory, async (request, response) => {
  const pathname = request.url?.split('?')[0];
  if (pathname === '/factory') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(factorySnapshot(), null, 2));
    return;
  }
  if (pathname !== '/work') {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  try {
    await work.run(async () => {
      simulatedActive += 1;
      const activeAtStart = simulatedActive;
      const requestNumber = ++operationNumber;
      const delayMs = simulatedDelay(activeAtStart);
      const fails = activeAtStart > 55 && requestNumber % 5 === 0;
      await delay(delayMs);
      simulatedActive -= 1;
      if (fails) throw new Error('simulated downstream saturation');
    });
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  } catch {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'simulated downstream saturation' }));
  }
}));

const evaluator = setInterval(() => {
  const decision = adaptive.evaluateFromMetrics();
  const metrics = adaptive.stats();
  const controllerMetrics = work.stats();
  const p95 = decision.signals.smoothedP95Ms ?? 0;
  const throughput = decision.signals.smoothedThroughput ?? 0;
  const errorRate = decision.signals.smoothedErrorRate ?? 0;
  console.log(
    `[Lazpho] limit=${metrics.currentLimit} proposed=${metrics.proposedLimit} action=${decision.action} ` +
    `state=${metrics.controllerState} p95=${p95.toFixed(1)}ms throughput=${throughput.toFixed(1)}rps ` +
    `errors=${(errorRate * 100).toFixed(2)}% queued=${controllerMetrics.queued}`
  );
}, 2_000);

server.listen(port, () => {
  console.log(`Adaptive demo listening at http://localhost:${port}`);
  console.log('Run `npm run load:adaptive` in another terminal, then inspect http://localhost:3000/factory');
});

function factorySnapshot() {
  const decision = adaptive.state().lastDecision;
  const metrics = adaptive.stats();
  const controllerMetrics = work.stats();
  return {
    currentLimit: metrics.currentLimit,
    proposedLimit: metrics.proposedLimit,
    adaptiveState: metrics.controllerState,
    lastAction: decision?.action ?? 'hold',
    lastReason: decision?.reason ?? 'insufficient_data',
    p95Ms: decision?.signals.smoothedP95Ms ?? 0,
    throughput: decision?.signals.smoothedThroughput ?? 0,
    errorRate: decision?.signals.smoothedErrorRate ?? 0,
    active: controllerMetrics.active,
    queued: controllerMetrics.queued,
    increases: metrics.increases,
    decreases: metrics.decreases,
    holds: metrics.holds,
    totalLimitChanges: metrics.limitChanges
  };
}

function simulatedDelay(active: number): number {
  if (active <= 40) return 25;
  if (active <= 55) return 25 + Math.floor((active - 40) / 5);
  return Math.min(150, 100 + (active - 55) * 2);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shutdown(): void {
  clearInterval(evaluator);
  factory.close();
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
