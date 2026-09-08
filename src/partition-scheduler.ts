import type { BulkheadMetrics, BulkheadOptions } from './types.js';

export interface ScheduledEntry {
  partition: PartitionState;
  previous?: ScheduledEntry;
  next?: ScheduledEntry;
}

export interface PartitionState {
  readonly name: string | undefined;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  active: number;
  queued: number;
  rejected: number;
  head?: ScheduledEntry;
  tail?: ScheduledEntry;
}

export interface SchedulerDebugState {
  active: number;
  queued: number;
  linkedNodes: number;
  partitions: ReadonlyArray<{
    name: string | undefined;
    active: number;
    queued: number;
    hasHead: boolean;
    hasTail: boolean;
  }>;
}

/** Internal intrusive per-partition FIFO registry with rotating runnable selection. */
export class PartitionScheduler {
  private readonly defaultPartition: PartitionState;
  private readonly named = new Map<string, PartitionState>();
  private readonly partitions: PartitionState[];
  private cursor = 0;
  private activeCount = 0;
  private queuedCount = 0;

  public constructor(maxQueueSize: number, bulkheads: Readonly<Record<string, BulkheadOptions>> | undefined) {
    this.defaultPartition = state(undefined, Number.MAX_SAFE_INTEGER, maxQueueSize);
    this.partitions = [this.defaultPartition];
    for (const [name, options] of Object.entries(bulkheads ?? {})) {
      const partition = state(name, options.maxConcurrent, options.maxQueue);
      this.named.set(name, partition);
      this.partitions.push(partition);
    }
  }

  public resolve(name: string | undefined): PartitionState | undefined {
    return name === undefined ? this.defaultPartition : this.named.get(name);
  }

  public active(): number { return this.activeCount; }
  public queued(): number { return this.queuedCount; }

  public mustQueue(partition: PartitionState, globalLimit: number): boolean {
    return this.activeCount >= globalLimit
      || partition.active >= partition.maxConcurrent
      || partition.queued > 0;
  }

  public enqueue(entry: ScheduledEntry): void {
    const partition = entry.partition;
    entry.previous = partition.tail;
    if (partition.tail) partition.tail.next = entry;
    else partition.head = entry;
    partition.tail = entry;
    partition.queued += 1;
    this.queuedCount += 1;
  }

  public remove(entry: ScheduledEntry): boolean {
    const partition = entry.partition;
    if (entry.previous) entry.previous.next = entry.next;
    else if (partition.head === entry) partition.head = entry.next;
    else return false;
    if (entry.next) entry.next.previous = entry.previous;
    else partition.tail = entry.previous;
    entry.previous = undefined;
    entry.next = undefined;
    partition.queued -= 1;
    this.queuedCount -= 1;
    return true;
  }

  public nextRunnable(globalLimit: number): ScheduledEntry | undefined {
    if (this.activeCount >= globalLimit) return undefined;
    for (let offset = 0; offset < this.partitions.length; offset += 1) {
      const index = (this.cursor + offset) % this.partitions.length;
      const partition = this.partitions[index];
      if (!partition.head || partition.active >= partition.maxConcurrent) continue;
      const entry = partition.head;
      this.remove(entry);
      this.cursor = (index + 1) % this.partitions.length;
      return entry;
    }
    return undefined;
  }

  public started(partition: PartitionState): void {
    partition.active += 1;
    this.activeCount += 1;
  }

  public finished(partition: PartitionState): void {
    partition.active -= 1;
    this.activeCount -= 1;
  }

  public reject(partition: PartitionState): void {
    partition.rejected += 1;
  }

  public snapshot(): Readonly<Record<string, Readonly<BulkheadMetrics>>> {
    const snapshot = Object.create(null) as Record<string, Readonly<BulkheadMetrics>>;
    for (const [name, partition] of this.named) {
      snapshot[name] = Object.freeze({
        active: partition.active,
        queued: partition.queued,
        maxConcurrent: partition.maxConcurrent,
        maxQueue: partition.maxQueue,
        rejected: partition.rejected
      });
    }
    return Object.freeze(snapshot);
  }

  /** Package-internal diagnostic used by tests and soak tooling. */
  public debugState(): SchedulerDebugState {
    let active = 0;
    let queued = 0;
    let linkedNodes = 0;
    const partitions = this.partitions.map((partition) => {
      active += partition.active;
      queued += partition.queued;
      let node = partition.head;
      let previous: ScheduledEntry | undefined;
      let count = 0;
      while (node) {
        if (node.partition !== partition || node.previous !== previous) throw new Error('Partition queue linkage is inconsistent.');
        previous = node;
        node = node.next;
        count += 1;
        if (count > partition.queued) throw new Error('Partition queue contains a cycle or an uncounted node.');
      }
      if (count !== partition.queued || previous !== partition.tail) throw new Error('Partition queue endpoints do not match its queued count.');
      if ((partition.queued === 0) !== (partition.head === undefined && partition.tail === undefined)) {
        throw new Error('Empty partition retains a queue endpoint.');
      }
      linkedNodes += count;
      return {
        name: partition.name,
        active: partition.active,
        queued: partition.queued,
        hasHead: partition.head !== undefined,
        hasTail: partition.tail !== undefined
      };
    });
    if (active !== this.activeCount || queued !== this.queuedCount || linkedNodes !== this.queuedCount) {
      throw new Error('Partition and global scheduler accounting diverged.');
    }
    return { active, queued, linkedNodes, partitions };
  }
}

function state(name: string | undefined, maxConcurrent: number, maxQueue: number): PartitionState {
  return { name, maxConcurrent, maxQueue, active: 0, queued: 0, rejected: 0 };
}
