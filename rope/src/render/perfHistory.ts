// The last five seconds of the instrument readings, kept as time buckets rather
// than as a sample per frame.
//
// A HUD wants two things from the same data and they pull in opposite
// directions: aggregates over the window (what the machine has been doing) and a
// point per slice of time (when it did it). A per-frame ring gives both only by
// rescanning hundreds of samples every frame to re-bucket them, and the numbers a
// person reads off a screen do not deserve that.
//
// So the bucket IS the storage. A push is O(1) into the bucket the wall clock
// lands in, a fold over the window is 50 buckets, and the graph is those same 50
// buckets drawn left to right. Nothing is rescanned and nothing is allocated
// after construction.
//
// Buckets carry the epoch they were opened for, so a window that stalls (an
// alt-tab, a breakpoint) reads as empty columns rather than as five-second-old
// bars pretending to be current.

// How far back the HUD looks, and at what resolution. 100 ms a column is about
// six frames at 60 Hz: fine enough that a single hitch is still a visible spike,
// coarse enough that 50 columns fit legibly across a panel.
export const HISTORY_MS = 5000;
export const BUCKET_MS = 100;
export const BUCKETS = HISTORY_MS / BUCKET_MS;

// The four readings the HUD plots. Frame time and GPU time are milliseconds,
// CPU is a percentage of wall time, RAM is megabytes.
export type MetricKey = "frameMs" | "cpuPct" | "gpuMs" | "heapMb";
const METRICS: readonly MetricKey[] = ["frameMs", "cpuPct", "gpuMs", "heapMb"];

export interface MetricStats {
  // Over the window, across every frame in it - not across the columns, which
  // would weight a busy 100 ms the same as an idle one.
  avg: number;
  min: number;
  max: number;
  // Frames that contributed. Zero means the metric is unavailable (no timer
  // extension, no heap reading) rather than pinned at zero.
  samples: number;
}

// One metric's buckets. Sums and counts fold to the average; the extremes are
// kept per bucket so a column can be drawn at its worst frame, which is the one
// worth seeing.
class MetricRing {
  readonly sum = new Float64Array(BUCKETS);
  readonly count = new Float64Array(BUCKETS);
  readonly min = new Float64Array(BUCKETS);
  readonly max = new Float64Array(BUCKETS);
}

export class PerfHistory {
  private readonly rings: Record<MetricKey, MetricRing> = {
    frameMs: new MetricRing(),
    cpuPct: new MetricRing(),
    gpuMs: new MetricRing(),
    heapMb: new MetricRing(),
  };
  // Which 100 ms of wall time each slot currently holds. A slot whose epoch is
  // not one of the last BUCKETS epochs is stale, and reads as empty.
  private readonly epoch = new Float64Array(BUCKETS).fill(-1);
  private newestEpoch = -1;
  // Scratch for the fold, so `stats` allocates nothing per frame.
  private readonly scratch: MetricStats = { avg: 0, min: 0, max: 0, samples: 0 };

  // One rendered frame's readings. A metric with nothing to report passes null
  // (an absent GPU timer, a browser with no heap reading) and is simply not
  // counted, which is what keeps its row honest instead of flat at zero.
  push(
    nowMs: number,
    frameMs: number,
    cpuPct: number,
    gpuMs: number | null,
    heapMb: number | null,
  ): void {
    const epoch = Math.floor(nowMs / BUCKET_MS);
    if (epoch > this.newestEpoch) this.newestEpoch = epoch;
    const slot = ((epoch % BUCKETS) + BUCKETS) % BUCKETS;
    if (this.epoch[slot] !== epoch) {
      this.epoch[slot] = epoch;
      for (const key of METRICS) {
        const ring = this.rings[key];
        ring.sum[slot] = 0;
        ring.count[slot] = 0;
        ring.min[slot] = 0;
        ring.max[slot] = 0;
      }
    }
    this.add("frameMs", slot, frameMs);
    this.add("cpuPct", slot, cpuPct);
    if (gpuMs !== null) this.add("gpuMs", slot, gpuMs);
    if (heapMb !== null) this.add("heapMb", slot, heapMb);
  }

  private add(key: MetricKey, slot: number, value: number): void {
    const ring = this.rings[key];
    if (ring.count[slot] === 0) {
      ring.min[slot] = value;
      ring.max[slot] = value;
    } else {
      if (value < ring.min[slot]!) ring.min[slot] = value;
      if (value > ring.max[slot]!) ring.max[slot] = value;
    }
    ring.sum[slot]! += value;
    ring.count[slot]! += 1;
  }

  // The window folded. The returned object is REUSED - read it, do not keep it.
  stats(key: MetricKey): MetricStats {
    const ring = this.rings[key];
    const out = this.scratch;
    out.avg = 0;
    out.min = 0;
    out.max = 0;
    out.samples = 0;
    let sum = 0;
    let seen = false;
    for (let i = 0; i < BUCKETS; i++) {
      if (!this.live(i) || ring.count[i] === 0) continue;
      sum += ring.sum[i]!;
      out.samples += ring.count[i]!;
      if (!seen) {
        seen = true;
        out.min = ring.min[i]!;
        out.max = ring.max[i]!;
      } else {
        if (ring.min[i]! < out.min) out.min = ring.min[i]!;
        if (ring.max[i]! > out.max) out.max = ring.max[i]!;
      }
    }
    if (out.samples > 0) out.avg = sum / out.samples;
    return out;
  }

  // The graph: the window as a series, oldest point first, written into
  // caller-owned arrays of BUCKETS. `mean` is the line; `lo`/`hi` are the best
  // and worst frame inside each 100 ms, drawn as a band around it so a single
  // hitch is not averaged away into a smooth line.
  //
  // A point with no frames behind it is NaN rather than 0 - an idle 100 ms and a
  // 0 ms frame are not the same claim, and the graph breaks the line there
  // instead of diving to the floor.
  series(key: MetricKey, mean: Float64Array, lo: Float64Array, hi: Float64Array): void {
    const ring = this.rings[key];
    // Oldest first: the newest epoch's slot is the rightmost point.
    const oldest = this.newestEpoch - (BUCKETS - 1);
    for (let i = 0; i < BUCKETS; i++) {
      const epoch = oldest + i;
      const slot = ((epoch % BUCKETS) + BUCKETS) % BUCKETS;
      if (this.epoch[slot] !== epoch || ring.count[slot]! === 0) {
        mean[i] = Number.NaN;
        lo[i] = Number.NaN;
        hi[i] = Number.NaN;
        continue;
      }
      mean[i] = ring.sum[slot]! / ring.count[slot]!;
      lo[i] = ring.min[slot]!;
      hi[i] = ring.max[slot]!;
    }
  }

  // The most recent 100 ms, averaged - the "now" a HUD row shows. A raw
  // per-frame reading at 144 Hz is unreadable and a one-second mean is not
  // "now"; a tenth of a second is both. Null where the newest bucket has nothing
  // in it, which is a metric this machine does not report.
  latest(key: MetricKey): number | null {
    const slot = ((this.newestEpoch % BUCKETS) + BUCKETS) % BUCKETS;
    const ring = this.rings[key];
    if (this.newestEpoch < 0 || this.epoch[slot] !== this.newestEpoch) return null;
    return ring.count[slot]! > 0 ? ring.sum[slot]! / ring.count[slot]! : null;
  }

  private live(slot: number): boolean {
    const epoch = this.epoch[slot]!;
    return epoch >= 0 && this.newestEpoch - epoch < BUCKETS;
  }
}
