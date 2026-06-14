// Generic rolling-window request-timing accumulator + its snapshot type,
// extracted from server.ts (#645 Phase 2). Pure data structure: a fixed-size
// circular buffer of durations exposing min/max/avg/p50/p95/p99/p999. No
// server, I/O, or runtime dependencies. server.ts keeps the timing instances
// and the per-request recording.

export class RequestTimingWindow {
  private readonly samples: number[] = [];
  private nextIndex = 0;
  private readonly maxSamples: number;

  constructor(maxSamples = 200) {
    this.maxSamples = maxSamples;
  }

  record(durationMs: number): void {
    if (this.samples.length < this.maxSamples) {
      this.samples.push(durationMs);
    } else {
      this.samples[this.nextIndex] = durationMs;
    }
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): {
    count: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    p999Ms: number;
  } | null {
    const count = this.samples.length;
    if (count === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const idx = (p: number) => Math.min(Math.floor(count * p), count - 1);
    return {
      count,
      minMs: Math.round(sorted[0] * 1000) / 1000,
      maxMs: Math.round(sorted[count - 1] * 1000) / 1000,
      avgMs: Math.round((sum / count) * 1000) / 1000,
      p50Ms: Math.round(sorted[idx(0.5)] * 1000) / 1000,
      p95Ms: Math.round(sorted[idx(0.95)] * 1000) / 1000,
      p99Ms: Math.round(sorted[idx(0.99)] * 1000) / 1000,
      p999Ms: Math.round(sorted[idx(0.999)] * 1000) / 1000,
    };
  }
}

export type RequestTimingSnapshot = ReturnType<RequestTimingWindow["snapshot"]>;
