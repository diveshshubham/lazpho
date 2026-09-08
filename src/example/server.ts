import { createServer } from 'node:http';
import { createFactory } from '../index.js';
import { instrumentNodeHttp } from '../adapters/node-http.js';

const factory = createFactory({ enabled: true });
const server = createServer(instrumentNodeHttp(factory, (_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ ok: true }));
}));

server.listen(3000, () => {
  console.log('Lazpho example listening at http://localhost:3000');
});

const reporter = setInterval(() => {
  const metrics = factory.getMetrics();
  console.log(JSON.stringify({
    totalRequests: metrics.totalRequests,
    requestsPerSecond: metrics.requestsPerSecond,
    activeRequests: metrics.activeRequests,
    errors: metrics.errors,
    p50Ms: metrics.p50Ms,
    p95Ms: metrics.p95Ms,
    p99Ms: metrics.p99Ms,
    eventLoopLagMs: metrics.resources.eventLoopLagMs,
    memory: metrics.resources.memory,
    cpu: metrics.resources.cpu,
    routes: metrics.routes
  }, null, 2));
}, 5_000);

function shutdown(): void {
  clearInterval(reporter);
  factory.close();
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
