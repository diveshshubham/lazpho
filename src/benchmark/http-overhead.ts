import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { request } from 'node:http';
import { createFactory } from '../index.js';
import { instrumentNodeHttp, type NodeHttpHandler } from '../adapters/node-http.js';

const DURATION_MS = 3_000;
const CONCURRENCY = 50;

async function run(label: string, handler: NodeHttpHandler): Promise<number> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve benchmark address');
  const endAt = performance.now() + DURATION_MS;
  let completed = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < endAt) {
      await send(address.port);
      completed += 1;
    }
  }));
  await close(server);
  const rps = completed / (DURATION_MS / 1_000);
  console.log(`${label}: ${rps.toFixed(0)} req/s`);
  return rps;
}

function send(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    client.once('error', reject);
    client.end();
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const baseHandler: NodeHttpHandler = (_request, response) => { response.end('ok'); };
const baseline = await run('Without Factory', baseHandler);
const factory = createFactory();
const instrumented = await run('With Factory', instrumentNodeHttp(factory, baseHandler));
factory.close();
const overhead = ((baseline - instrumented) / baseline) * 100;
console.log(`Throughput difference: ${(instrumented - baseline).toFixed(0)} req/s`);
console.log(`Instrumentation overhead: ${overhead.toFixed(2)}%`);
