import type { ResourceMetrics } from './types.js';
import { EventLoopMonitor } from './event-loop-monitor.js';

export class ResourceMonitor {
  private readonly eventLoop: EventLoopMonitor;

  public constructor(eventLoopResolutionMs: number) {
    this.eventLoop = new EventLoopMonitor(eventLoopResolutionMs);
  }

  public snapshot(): ResourceMetrics {
    const memory = process.memoryUsage();
    let cpu: ResourceMetrics['cpu'] = null;
    try {
      const usage = process.cpuUsage();
      cpu = { userMicros: usage.user, systemMicros: usage.system };
    } catch {
      cpu = null;
    }
    return {
      eventLoopLagMs: this.eventLoop.getLagMs(),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external
      },
      cpu
    };
  }

  public close(): void {
    this.eventLoop.close();
  }
}
