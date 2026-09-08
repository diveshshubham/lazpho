import { runSoak } from './harness.js';

const long = process.argv.includes('--long');
const cycles = integerFromEnvironment('SOAK_CYCLES', long ? 250 : 30);
const tasksPerCycle = integerFromEnvironment('SOAK_TASKS_PER_CYCLE', long ? 200 : 80);
const seed = integerFromEnvironment('SOAK_SEED', 519_2026);
const result = await runSoak({ seed, cycles, tasksPerCycle });
const { initialMemory, peakMemory, finalMemory, postGcMemory, ...summary } = result;
console.table([summary]);
console.table([
  { sample: 'initial', ...megabytes(initialMemory) },
  { sample: 'peak', ...megabytes(peakMemory) },
  { sample: 'final', ...megabytes(finalMemory) },
  ...(postGcMemory ? [{ sample: 'post-gc', ...megabytes(postGcMemory) }] : [])
]);

function integerFromEnvironment(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function megabytes(memory: { heapUsed: number; heapTotal: number; rss: number; external: number }) {
  return {
    heapUsedMb: round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: round(memory.heapTotal / 1024 / 1024),
    rssMb: round(memory.rss / 1024 / 1024),
    externalMb: round(memory.external / 1024 / 1024)
  };
}

function round(value: number): number { return Math.round(value * 100) / 100; }
