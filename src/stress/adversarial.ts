import { runStressScenario } from './harness.js';

const tasks = Number.parseInt(process.env.STRESS_TASKS ?? '5000', 10);
const seed = Number.parseInt(process.env.STRESS_SEED ?? '184732', 10);
const result = await runStressScenario({ seed, tasks });
const { partitions, ...global } = result;
console.table([global]);
console.table(Object.entries(partitions).map(([partition, metrics]) => ({ partition, ...metrics })));
