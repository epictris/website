// Recording-led rolling texture: random native-pitch grains, never a scan
// through the recording's multi-second performance/envelope. Render-side only.
export class RollingTexture {
  private start = 0;
  private end = 0;
  private candidates: { at: number; rms: number }[] = [];
  private target = 0;
  private state: number;
  private cursor = 0;
  private lastAt = -Infinity;
  private grains: { at: number; age: number; gain: number }[] = [];
  private readonly length: number;
  private readonly hop: number;
  private readonly window: Float32Array;

  constructor(private readonly channels: Float32Array[], rate: number, seed = 1) {
    this.length = 2 * Math.max(1, Math.round(rate * .08));
    this.hop = this.length / 2;
    this.window = Float32Array.from({ length: this.length }, (_, i) => Math.sin(Math.PI * i / this.length));
    this.state = seed || 1;
    this.setWindow(0, channels[0]?.length ?? 0);
  }

  setWindow(start: number, end: number): void {
    const size = this.channels[0]?.length ?? 0;
    const s = Math.max(0, Math.min(size, Math.floor(start)));
    const e = Math.max(s, Math.min(size, Math.floor(end)));
    if (s === this.start && e === this.end) return;
    this.start = s; this.end = e;
    this.grains = []; this.cursor = 0; this.lastAt = -Infinity;
    const windows: { at: number; rms: number }[] = [];
    const span = Math.min(this.length, e - s);
    for (let at = s; span > 0 && at + span <= e; at += Math.max(1, this.hop / 2)) {
      let power = 0;
      for (const x of this.channels) for (let i = 0; i < span; i++) power += x[at + i]! ** 2;
      windows.push({ at, rms: Math.sqrt(power / (span * this.channels.length)) });
    }
    const levels = windows.map(w => w.rms).filter(v => v > 1e-7).sort((a, b) => a - b);
    this.target = Math.min(.1, levels[Math.floor(levels.length / 2)] ?? 0);
    // Exclude fades/silence and unusually loud handling transients. Normalize
    // the remaining grains by RMS, with bounded gain so noise is not inflated.
    this.candidates = windows.filter(w => w.rms >= this.target * .4 && w.rms <= this.target * 2 && w.rms > 1e-7);
  }

  private random(): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x;
    return (x >>> 0) / 4294967296;
  }

  process(out: Float32Array[], frames: number, _pace: number, pitch: number, offset = 0): void {
    const len = this.end - this.start;
    for (let i = 0; i < frames; i++) {
      if (this.cursor % this.hop === 0 && this.candidates.length) {
        this.grains = this.grains.filter(g => g.age < this.length);
        let chosen = this.candidates[Math.floor(this.random() * this.candidates.length)]!;
        for (let attempt = 0; attempt < 8 && Math.abs(chosen.at - this.lastAt) < this.length; attempt++) {
          chosen = this.candidates[Math.floor(this.random() * this.candidates.length)]!;
        }
        this.lastAt = chosen.at;
        this.grains.push({ at: chosen.at, age: 0, gain: Math.min(2.5, this.target / chosen.rms) });
      }
      for (let c = 0; c < out.length; c++) {
        const x = this.channels[Math.min(c, this.channels.length - 1)];
        let sum = 0;
        if (x && len > 0) for (const g of this.grains) {
          const pos = ((g.at - this.start + g.age * pitch) % len + len) % len;
          const a = Math.floor(pos), b = (a + 1) % len, f = pos - a;
          const sample = x[this.start + a]! * (1 - f) + x[this.start + b]! * f;
          // Equal-power half overlap for unrelated source phases.
          sum += sample * this.window[g.age]! * g.gain;
        }
        out[c]![offset + i] = sum;
      }
      for (const g of this.grains) g.age++;
      this.cursor++;
    }
  }
}
