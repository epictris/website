// A looping recording played at a PACE and a PITCH that are set apart
// (docs/sound.md#pace-and-pitch): WSOLA, waveform-similarity overlap-add
// (Verhelst & Roelands, ICASSP 1993), the textbook time-scale modification and
// what browsers use for a media element's `preservesPitch`.
//
// Why. A rolling ball's sound is two things (docs/sound.md#pace-and-pitch): the
// roughness under it struck at a rate in proportion to its speed, and the ball
// and the surface ringing at their own frequencies, which no speed changes.
// Playing a recording faster, as a tape, raises both. Pace is the first - how
// fast the file's own time runs - and pitch the second, so a roll can run its
// texture at twice the rate and keep its ring where it was.
//
// How. The output is a train of grains, Hann-windowed and half-overlapped, so
// grains read from one continuous stretch of the file add back to it exactly.
// Grain k is read at `pitch` file-samples per output sample (resampled,
// linearly), from near where the pace puts it: `hop * pace` further into the
// file than the last. "Near" is the trick: within `TOLERANCE_SECONDS` either
// way, it starts where the file looks most like what the last grain would have
// played next (the best normalised cross-correlation over the overlap), so the
// two halves that add up in the overlap are in step rather than cancelling.
// At pace = pitch the best place is exactly the last grain's continuation, and
// the output is the file resampled, sample for sample, which is how this
// replaces the old tape-speed loop without changing a loop that does not ask
// for the difference.
//
// Pure arithmetic and typed arrays, no Web Audio, so the worklet runs it on the
// audio thread and bun tests it (scripts/test-grain.ts).

// The grain, s: long enough to hold several periods of the lowest sound a roll
// makes (its rumble, well under 100 Hz, has a period near 10-20 ms) and short
// enough that a change of pace is followed within a grain.
export const GRAIN_SECONDS = 0.04;
// How far a grain may slide from where the pace puts it to find the place that
// continues the last one, s: half a hop, the usual WSOLA choice, and a period
// of anything down to 50 Hz.
export const TOLERANCE_SECONDS = 0.01;
// The similarity search reads every this-many samples first, then every sample
// around the best of those: 1/16 of the work, and aligned to within a quarter
// of a millisecond at 48 kHz before the fine pass takes it the rest of the way.
const COARSE = 4;

export class WsolaLoop {
  // Grain and hop, output samples; tolerance, file samples.
  readonly grain: number;
  readonly hop: number;
  readonly tolerance: number;
  private readonly win: Float32Array;
  private readonly channels: Float32Array[];
  // The window played, file samples: [start, start + len).
  private start = 0;
  private len = 0;
  // Where the pace has got to, and where the last grain started, both file
  // samples from `start`; `prev` NaN before the first grain (no last grain to
  // continue).
  private nominal = 0;
  private prev = Number.NaN;
  // The overlap-add accumulator, a grain long, per channel; `ready` samples of
  // its front are finished and not yet handed out, from `readAt`.
  private readonly acc: Float32Array[];
  private ready = 0;
  private readAt = 0;
  // The last grain's continuation, read once per hop for the search.
  private readonly want: Float32Array;

  constructor(channels: Float32Array[], sampleRate: number) {
    this.channels = channels;
    this.grain = 2 * Math.round((GRAIN_SECONDS * sampleRate) / 2);
    this.hop = this.grain / 2;
    this.tolerance = COARSE * Math.round((TOLERANCE_SECONDS * sampleRate) / COARSE);
    // Periodic Hann: w[n] + w[n + hop] = 1, so half-overlapped grains of one
    // continuous signal add back to it with no ripple.
    this.win = new Float32Array(this.grain);
    for (let n = 0; n < this.grain; n++) this.win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.grain);
    this.acc = channels.map(() => new Float32Array(this.grain));
    this.want = new Float32Array(this.hop);
    this.setWindow(0, channels[0]?.length ?? 0);
  }

  get channelCount(): number {
    return this.channels.length;
  }

  // The part of the file looped, file samples. A playing position inside the
  // new window is kept; one outside it starts again at the window's start.
  setWindow(start: number, end: number): void {
    const length = this.channels[0]?.length ?? 0;
    const s = Math.max(0, Math.min(length - 1, Math.floor(start)));
    const e = Math.max(s + 1, Math.min(length, Math.floor(end)));
    if (s === this.start && e - s === this.len) return;
    const at = this.start + this.nominal;
    this.start = s;
    this.len = e - s;
    this.nominal = at >= s && at < e ? at - s : 0;
    // The last grain may have been read from outside the new window: no
    // continuation to match, so the next grain starts where the pace says.
    this.prev = Number.NaN;
  }

  // Where playing starts, file samples (wrapped into the window).
  seek(at: number): void {
    this.nominal = this.wrap(at - this.start);
    this.prev = Number.NaN;
  }

  // `frames` samples into `out` (one array per channel, at least `frames`
  // long, from `offset`), with the file's time running at `pace` file-seconds
  // per second and its pitch at `pitch` (both >= 0; 1 is the file as it is).
  process(out: Float32Array[], frames: number, pace: number, pitch: number, offset = 0): void {
    if (this.len === 0) {
      for (const o of out) o.fill(0, offset, offset + frames);
      return;
    }
    let done = 0;
    while (done < frames) {
      if (this.ready === 0) this.synthesise(pace, pitch);
      const take = Math.min(this.ready, frames - done);
      for (let c = 0; c < out.length; c++) {
        const acc = this.acc[Math.min(c, this.acc.length - 1)]!;
        out[c]!.set(acc.subarray(this.readAt, this.readAt + take), offset + done);
      }
      this.readAt += take;
      this.ready -= take;
      done += take;
    }
  }

  // One hop: shift the accumulator on, add the next grain, and hand out its
  // finished front.
  private synthesise(pace: number, pitch: number): void {
    const { grain, hop } = this;
    for (const acc of this.acc) {
      acc.copyWithin(0, hop);
      acc.fill(0, grain - hop);
    }
    let at: number;
    if (Number.isNaN(this.prev)) {
      at = this.nominal;
    } else {
      this.nominal = this.wrap(this.nominal + hop * pace);
      at = this.bestStart(this.wrap(this.prev + hop * pitch), pitch);
    }
    this.prev = at;
    const win = this.win;
    for (let c = 0; c < this.channels.length; c++) {
      const x = this.channels[c]!;
      const acc = this.acc[c]!;
      for (let n = 0; n < grain; n++) acc[n]! += win[n]! * this.sample(x, at + n * pitch);
    }
    this.ready = hop;
    this.readAt = 0;
  }

  // The grain start within `tolerance` of the pace's position whose opening
  // hop looks most like `next`, the last grain's continuation.
  private bestStart(next: number, pitch: number): number {
    const x = this.channels[0]!;
    const want = this.want;
    const hop = this.hop;
    for (let i = 0; i < hop; i++) want[i] = x[this.start + this.index(next + i * pitch)]!;
    const tol = this.tolerance;
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -tol; d <= tol; d += COARSE) {
      const s = this.similarity(this.nominal + d, pitch, COARSE);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let d = Math.max(-tol, coarse - COARSE + 1); d <= Math.min(tol, coarse + COARSE - 1); d++) {
      const s = this.similarity(this.nominal + d, pitch, 1);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }
    return this.wrap(this.nominal + best);
  }

  // How alike a grain started at `from` and the wanted continuation are over
  // the overlap, read every `stride` samples: the cross-correlation over the
  // candidate's own energy (the continuation's is the same for every
  // candidate), so a loud stretch does not win for being loud.
  private similarity(from: number, pitch: number, stride: number): number {
    const x = this.channels[0]!;
    const want = this.want;
    let cross = 0;
    let energy = 1e-12;
    for (let i = 0; i < this.hop; i += stride) {
      const v = x[this.start + this.index(from + i * pitch)]!;
      cross += v * want[i]!;
      energy += v * v;
    }
    return cross / Math.sqrt(energy);
  }

  // The window's sample at a fractional position (from `start`), linearly
  // interpolated, wrapping at the window's end as the loop does.
  private sample(x: Float32Array, pos: number): number {
    const p = this.wrap(pos);
    const k = Math.floor(p);
    const f = p - k;
    const k1 = k + 1 >= this.len ? 0 : k + 1;
    return x[this.start + k]! * (1 - f) + x[this.start + k1]! * f;
  }

  private index(pos: number): number {
    return Math.floor(this.wrap(pos));
  }

  private wrap(pos: number): number {
    const len = this.len;
    let p = pos % len;
    if (p < 0) p += len;
    // `%` of a float a hair under `len` can round to `len` itself.
    return p >= len ? 0 : p;
  }
}
