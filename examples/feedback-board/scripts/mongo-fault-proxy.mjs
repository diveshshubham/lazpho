import { createServer, connect } from 'node:net';

export async function startMongoFaultProxy({
  upstreamHost = '127.0.0.1',
  upstreamPort = 27018,
  host = '127.0.0.1',
  port = 0
} = {}) {
  let available = true;
  let latencyMs = 0;
  let acceptedConnections = 0;
  let cutConnections = 0;
  let bytesClientToMongo = 0;
  let bytesMongoToClient = 0;
  let peakConnections = 0;
  const pairs = new Set();

  const server = createServer((client) => {
    if (!available) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: upstreamHost, port: upstreamPort });
    const pair = { client, upstream, timers: new Set(), closed: false };
    pairs.add(pair);
    acceptedConnections += 1;
    peakConnections = Math.max(peakConnections, pairs.size);

    forward(pair, client, upstream, (length) => { bytesClientToMongo += length; });
    forward(pair, upstream, client, (length) => { bytesMongoToClient += length; });
    const closePair = () => destroyPair(pair);
    client.on('error', closePair);
    upstream.on('error', closePair);
    client.on('close', closePair);
    upstream.on('close', closePair);
  });

  function forward(pair, source, destination, countBytes) {
    source.on('data', (chunk) => {
      countBytes(chunk.length);
      if (!available) return destroyPair(pair);
      if (!latencyMs) {
        if (!destination.destroyed) destination.write(chunk);
        return;
      }
      const timer = setTimeout(() => {
        pair.timers.delete(timer);
        if (available && !destination.destroyed) destination.write(chunk);
      }, latencyMs);
      pair.timers.add(timer);
    });
  }

  function destroyPair(pair) {
    if (pair.closed) return;
    pair.closed = true;
    for (const timer of pair.timers) clearTimeout(timer);
    pair.timers.clear();
    pair.client.destroy();
    pair.upstream.destroy();
    pairs.delete(pair);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mongo fault proxy did not receive a TCP address.');

  return Object.freeze({
    host,
    port: address.port,
    setLatency(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5_000) throw new RangeError('Proxy latency must be between 0 and 5000 ms.');
      latencyMs = milliseconds;
    },
    cut() {
      cutConnections += pairs.size;
      for (const pair of [...pairs]) destroyPair(pair);
    },
    disconnect() {
      available = false;
      this.cut();
    },
    recover() {
      latencyMs = 0;
      available = true;
    },
    snapshot() {
      return Object.freeze({ available, latencyMs, activeConnections: pairs.size, peakConnections, acceptedConnections, cutConnections, bytesClientToMongo, bytesMongoToClient });
    },
    async close() {
      available = false;
      for (const pair of [...pairs]) destroyPair(pair);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
