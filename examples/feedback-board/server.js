import express from 'express';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient, ObjectId } from 'mongodb';
import { createFactory } from 'lazpho';
import { startLazphoLoadLab } from 'lazpho/load-lab';
import {
  createLazphoExpress,
  getLazphoExpress,
  mapLazphoErrorToHttp,
  shutdownLazphoExpress
} from 'lazpho/express';

const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018';
const databaseName = process.env.MONGODB_DATABASE || 'lazpho_feedback';
const useLazpho = process.env.USE_LAZPHO?.toLowerCase() !== 'false';
const simulatedDatabaseLatencyMs = Math.max(0, Number(process.env.SIMULATED_DB_LATENCY_MS) || 0);
let directDatabaseActive = 0;
let directDatabasePeakActive = 0;

const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
await mongo.connect();

const ideas = mongo.db(databaseName).collection('ideas');
await ideas.createIndex({ createdAt: -1 });

const factory = useLazpho ? createFactory() : undefined;
const database = factory?.concurrency({
  name: 'mongodb',
  limit: 8,
  maxQueueSize: 40,
  maxQueueWaitMs: 750,
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 500,
    halfOpenMaxAttempts: 1
  },
  bulkheads: {
    reads: { maxConcurrent: 6, maxQueue: 30 },
    writes: { maxConcurrent: 3, maxQueue: 12 }
  }
});

const app = express();
app.use(express.json({ limit: '16kb' }));
if (useLazpho) {
  app.use('/api', createLazphoExpress({
    controller: database,
    factory,
    bulkheadForRequest: (request) => request.method === 'GET' ? 'reads' : 'writes'
  }));
}

app.get('/api/ideas', async (request, response, next) => {
  try {
    const rows = await runDatabaseOperation(request,
      ({ signal }) => ideas.find({}, { signal }).sort({ votes: -1, createdAt: -1 }).limit(100).toArray());
    response.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/ideas', async (request, response, next) => {
  const title = cleanText(request.body?.title, 80);
  const description = cleanText(request.body?.description, 240);
  if (!title) return response.status(400).json({ error: 'A title is required.' });

  try {
    const idea = { title, description, status: 'planned', votes: 0, createdAt: new Date() };
    const result = await runDatabaseOperation(request, ({ signal }) => ideas.insertOne(idea, { signal }));
    response.status(201).json({ ...idea, _id: result.insertedId });
  } catch (error) { next(error); }
});

app.post('/api/ideas/:id/vote', async (request, response, next) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: 'Invalid idea id.' });
  try {
    const idea = await runDatabaseOperation(request,
      ({ signal }) => ideas.findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $inc: { votes: 1 } },
        { returnDocument: 'after', signal }
      ));
    if (!idea) return response.status(404).json({ error: 'Idea not found.' });
    response.json(idea);
  } catch (error) { next(error); }
});

app.patch('/api/ideas/:id/status', async (request, response, next) => {
  const allowed = new Set(['planned', 'building', 'shipped']);
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: 'Invalid idea id.' });
  if (!allowed.has(request.body?.status)) return response.status(400).json({ error: 'Invalid status.' });
  try {
    const idea = await runDatabaseOperation(request,
      ({ signal }) => ideas.findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $set: { status: request.body.status } },
        { returnDocument: 'after', signal }
      ));
    if (!idea) return response.status(404).json({ error: 'Idea not found.' });
    response.json(idea);
  } catch (error) { next(error); }
});

app.get('/api/metrics', (_request, response) => response.json(useLazpho
  ? { mode: 'lazpho', lazphoEnabled: true, process: processMetrics(), ...factory.getMetrics() }
  : { mode: 'direct', lazphoEnabled: false, process: processMetrics(), directDatabaseActive, directDatabasePeakActive }));
app.use('/api', (_request, response) => response.status(404).json({ error: 'Not found.' }));
if (useLazpho) {
  app.use((error, request, response, next) => {
    const mapped = mapLazphoErrorToHttp(error);
    if (request.aborted || response.destroyed) return;
    if (!mapped || response.headersSent) return next(error);
    response.status(mapped.statusCode).json({ code: mapped.code });
  });
}
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Unexpected server error.' });
});
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

const server = await listenApp(app, port);
console.log(`Feedback Board: http://localhost:${port}`);
console.log(useLazpho
  ? `MongoDB protected by Lazpho (limit ${database.getLimit()})`
  : 'MongoDB direct mode (Lazpho disabled)');

let loadLab;
if (process.env.LOAD_LAB?.toLowerCase() === 'true') {
  try {
    loadLab = await startLazphoLoadLab({
      targetBaseUrl: `http://127.0.0.1:${port}`,
      port: Number(process.env.LOAD_LAB_PORT || 1913),
      metrics: useLazpho ? () => factory.getMetrics() : undefined,
      reportDirectory: fileURLToPath(new URL('./load-reports', import.meta.url)),
      endpoints: [
        { id: 'list-ideas', method: 'GET', path: '/api/ideas', description: 'List the public feedback board', safe: true },
        { id: 'lazpho-metrics', method: 'GET', path: '/api/metrics', description: 'Read the current application protection mode and Lazpho metrics', safe: true },
        {
          id: 'create-idea', method: 'POST', path: '/api/ideas', description: 'Create temporary ideas and remove only this run\'s records', safe: true,
          request: ({ runId, sequence }) => ({ body: { title: `Load Lab ${runId} #${sequence}`, description: 'Temporary managed fixture' } }),
          cleanup: ({ runId }) => ideas.deleteMany({ title: { $regex: `^Load Lab ${runId} #` } }).then(() => undefined)
        },
        {
          id: 'vote-idea', method: 'POST', path: '/api/ideas/:id/vote', description: 'Vote against one temporary managed idea', safe: true,
          setup: async ({ runId }) => String((await ideas.insertOne({ title: `Load Lab vote ${runId}`, description: 'Temporary managed fixture', status: 'planned', votes: 0, createdAt: new Date() })).insertedId),
          request: ({ fixture }) => ({ path: `/api/ideas/${fixture}/vote` }),
          cleanup: ({ fixture }) => ideas.deleteOne({ _id: new ObjectId(String(fixture)) }).then(() => undefined)
        },
        {
          id: 'update-status', method: 'PATCH', path: '/api/ideas/:id/status', description: 'Update one temporary managed idea', safe: true,
          setup: async ({ runId }) => String((await ideas.insertOne({ title: `Load Lab status ${runId}`, description: 'Temporary managed fixture', status: 'planned', votes: 0, createdAt: new Date() })).insertedId),
          request: ({ fixture, sequence }) => ({ path: `/api/ideas/${fixture}/status`, body: { status: sequence % 2 ? 'planned' : 'building' } }),
          cleanup: ({ fixture }) => ideas.deleteOne({ _id: new ObjectId(String(fixture)) }).then(() => undefined)
        }
      ]
    });
    console.log(`Lazpho Load Lab: ${loadLab.url}`);
  } catch (error) {
    console.error('Load Lab could not start; Signalboard will continue without it.', error);
  }
}

let shuttingDown = false;

function processMetrics() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuUserMicroseconds: cpu.user,
    cpuSystemMicroseconds: cpu.system
  };
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await loadLab?.close();
  if (useLazpho) await shutdownLazphoExpress(server, database);
  else await closeServer(server);
  await mongo.close();
  factory?.close();
}

process.once('SIGINT', () => shutdown().catch(console.error));
process.once('SIGTERM', () => shutdown().catch(console.error));

async function runDatabaseOperation(request, operation) {
  if (!useLazpho) {
    directDatabaseActive += 1;
    directDatabasePeakActive = Math.max(directDatabasePeakActive, directDatabaseActive);
    try {
      if (simulatedDatabaseLatencyMs) await delay(simulatedDatabaseLatencyMs);
      return await operation({ signal: undefined });
    } finally {
      directDatabaseActive -= 1;
    }
  }

  return getLazphoExpress(request).run(async ({ signal }) => {
    if (simulatedDatabaseLatencyMs) await delay(simulatedDatabaseLatencyMs, undefined, { signal });
    return operation({ signal });
  }, { timeoutMs: 1_500 });
}

function closeServer(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
}

function listenApp(expressApp, selectedPort) {
  return new Promise((resolve, reject) => {
    const httpServer = expressApp.listen(selectedPort);
    const onError = (error) => reject(error);
    httpServer.once('error', onError);
    httpServer.once('listening', () => {
      httpServer.removeListener('error', onError);
      resolve(httpServer);
    });
  });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
