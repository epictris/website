// Designed sound effects, rendered offline: `bun scripts/sfx.ts <outdir>`
// writes one 48 kHz mono WAV per sound event (docs/sound.md#events-and-slots),
// peak-normalised to -1 dBFS, ready to drop on the editor's Sounds menu.
//
// These are DESIGNED, not simulated: layered noise bursts, pitch-swept thumps,
// inharmonic rings and granular textures with hand-chosen envelopes, the way a
// sound designer builds an effect in a DAW. The earlier physics-derived
// synthesis (Hertz contact times, modal masses) was rejected on first listen,
// and docs/sound.md records why. Every random choice is seeded, so a sound
// renders bit-identically and its manifest hash stays meaningful.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SR = 48000;
const TAU = Math.PI * 2;

// --- noise and random -------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const uni = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();

function white(n: number, r: Rng): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

// Paul Kellet's economical pink filter.
function pink(n: number, r: Rng): Float64Array {
  const out = new Float64Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

function brown(n: number, r: Rng): Float64Array {
  const out = new Float64Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = (v + 0.02 * (r() * 2 - 1)) / 1.02;
    out[i] = v * 3.5;
  }
  return out;
}

// --- filters (RBJ cookbook biquads) ----------------------------------------

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function coeffs(kind: "lp" | "hp" | "bp", f: number, q: number): Biquad {
  const w = (TAU * Math.min(f, SR * 0.45)) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (kind === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function filter(x: Float64Array, kind: "lp" | "hp" | "bp", f: number, q = Math.SQRT1_2): Float64Array {
  return filterSweep(x, kind, () => f, q);
}

// A biquad whose centre frequency is a function of time (recomputed every 32 samples).
function filterSweep(x: Float64Array, kind: "lp" | "hp" | "bp", f: (t: number) => number, q: number): Float64Array {
  const out = new Float64Array(x.length);
  let c = coeffs(kind, f(0), q);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    if ((i & 31) === 0) c = coeffs(kind, f(i / SR), q);
    const y = c.b0 * x[i]! + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

// --- envelopes and generators ----------------------------------------------

const secs = (s: number) => Math.round(s * SR);

// Attack then exponential decay (to -60 dB at `decay` seconds after the attack).
function env(n: number, attack: number, decay: number): Float64Array {
  const out = new Float64Array(n);
  const a = Math.max(1, secs(attack));
  const k = Math.log(1000) / Math.max(1, secs(decay));
  for (let i = 0; i < n; i++) out[i] = i < a ? i / a : Math.exp(-k * (i - a));
  return out;
}

// A sine whose frequency glides exponentially from f0 to f1 over `glide` seconds.
function sweep(n: number, f0: number, f1: number, glide: number): Float64Array {
  const out = new Float64Array(n);
  let ph = 0;
  const g = Math.max(1, secs(glide));
  for (let i = 0; i < n; i++) {
    const f = f1 * Math.pow(f0 / f1, Math.max(0, 1 - i / g));
    ph += (TAU * f) / SR;
    out[i] = Math.sin(ph);
  }
  return out;
}

// Inharmonic partials, each with its own decay: the ring of struck metal.
function ring(n: number, partials: [number, number, number][], r: Rng, detune = 0.01): Float64Array {
  const out = new Float64Array(n);
  for (const [f, amp, decay] of partials) {
    const fr = f * (1 + uni(r, -detune, detune));
    const k = Math.log(1000) / secs(decay);
    const ph0 = uni(r, 0, TAU);
    for (let i = 0; i < n; i++) out[i] += amp * Math.exp(-k * i) * Math.sin(ph0 + (TAU * fr * i) / SR);
  }
  return out;
}

// A slow random walk in [-1, 1], smoothed: the hand on a fader.
function wander(n: number, rateHz: number, r: Rng): Float64Array {
  const out = new Float64Array(n);
  const step = secs(1 / rateHz);
  let from = uni(r, -1, 1), to = uni(r, -1, 1), i0 = 0;
  for (let i = 0; i < n; i++) {
    if (i - i0 >= step) { from = to; to = uni(r, -1, 1); i0 = i; }
    const t = (i - i0) / step;
    out[i] = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * t));
  }
  return out;
}

// --- mixing --------------------------------------------------------------------

function mul(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! * (b[i] ?? 0);
  return out;
}

function gain(a: Float64Array, g: number): Float64Array {
  return a.map((v) => v * g);
}

function mix(n: number, ...layers: [Float64Array, number, number?][]): Float64Array {
  const out = new Float64Array(n);
  for (const [x, g, at = 0] of layers) {
    const o = secs(at);
    for (let i = 0; i < x.length && o + i < n; i++) out[o + i]! += x[i]! * g;
  }
  return out;
}

function softClip(x: Float64Array, drive: number): Float64Array {
  return x.map((v) => Math.tanh(v * drive) / Math.tanh(drive));
}

// Make a texture loop seamlessly: fold the last `fade` seconds over the first.
function loopable(x: Float64Array, fade: number): Float64Array {
  const f = secs(fade);
  const n = x.length - f;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = x[i]!;
    if (i < f) {
      const t = i / f;
      out[i] = x[n + i]! * (1 - t) + x[i]! * t;
    }
  }
  return out;
}

function normalise(x: Float64Array, peakDb = -1): Float64Array {
  let peak = 1e-9;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return gain(x, Math.pow(10, peakDb / 20) / peak);
}

// Short decaying bandpassed-noise grains at random times: ticks, grit, droplets.
function grains(
  n: number,
  r: Rng,
  perSecond: number,
  make: (r: Rng) => Float64Array,
  ampRange: [number, number],
): Float64Array {
  const out = new Float64Array(n);
  let t = 0;
  while (t < n) {
    t += secs(-Math.log(1 - r()) / perSecond);
    const g = make(r);
    const a = uni(r, ampRange[0], ampRange[1]);
    for (let i = 0; i < g.length && t + i < n; i++) out[t + i]! += a * g[i]!;
  }
  return out;
}

// --- the sounds --------------------------------------------------------------

type Sound = { name: string; render: () => Float64Array };

const SOUNDS: Sound[] = [
  {
    // An iron ball rolling on stone: a wobbling low rumble, a bed of grit, and
    // the odd grain of stone under it. Loops.
    name: "roll",
    render: () => {
      const r = mulberry32(1);
      const n = secs(4.4);
      const rumble = mul(filter(brown(n, r), "lp", 220), wander(n, 4, r).map((v) => 0.75 + 0.25 * v));
      const grit = mul(filter(white(n, r), "bp", 900, 0.7), wander(n, 9, r).map((v) => 0.6 + 0.4 * v));
      const ticks = grains(n, r, 14, (rr) => mul(filter(white(secs(0.02), rr), "bp", uni(rr, 1500, 3200), 2), env(secs(0.02), 0.0005, 0.008)), [0.3, 1]);
      return normalise(loopable(mix(n, [rumble, 1], [grit, 0.22], [ticks, 0.12]), 0.4));
    },
  },
  {
    // The ball landing: a deep pitch-dropping thump, a short slap of noise and
    // a dull iron body behind it.
    name: "land",
    render: () => {
      const r = mulberry32(2);
      const n = secs(0.6);
      const thump = mul(sweep(n, 95, 42, 0.11), env(n, 0.002, 0.26));
      const slap = mul(filter(white(n, r), "lp", 1800), env(n, 0.001, 0.04));
      const body = ring(n, [[310, 1, 0.22], [520, 0.6, 0.16], [840, 0.4, 0.11], [1230, 0.25, 0.07]], r);
      return normalise(softClip(mix(n, [thump, 1], [slap, 0.7], [body, 0.22]), 1.4));
    },
  },
  {
    // The cuff catching hold: a bright click and clank, the body of the ring,
    // then the latch closing a moment later.
    name: "attach",
    render: () => {
      const r = mulberry32(3);
      const n = secs(0.5);
      const click = () => mul(filter(white(secs(0.03), r), "hp", 2500), env(secs(0.03), 0.0005, 0.004));
      const clank = ring(n, [[1150, 1, 0.2], [1720, 0.7, 0.15], [2460, 0.5, 0.11], [3380, 0.35, 0.08], [4710, 0.2, 0.05]], r);
      const latch = ring(secs(0.25), [[1900, 1, 0.08], [2900, 0.6, 0.06], [4300, 0.4, 0.04]], r);
      const thud = mul(sweep(n, 160, 90, 0.05), env(n, 0.001, 0.06));
      return normalise(softClip(mix(n, [click(), 0.8], [clank, 0.6], [thud, 0.5], [click(), 0.5, 0.055], [latch, 0.35, 0.055]), 1.2));
    },
  },
  {
    // The cuff glancing off stone it cannot bite: a short high clink, little body.
    name: "bounce",
    render: () => {
      const r = mulberry32(4);
      const n = secs(0.3);
      const click = mul(filter(white(n, r), "hp", 3000), env(n, 0.0005, 0.003));
      const clink = ring(n, [[2050, 1, 0.12], [3100, 0.7, 0.09], [4400, 0.45, 0.06], [6100, 0.25, 0.04]], r);
      const thud = mul(sweep(n, 220, 140, 0.03), env(n, 0.001, 0.03));
      return normalise(mix(n, [click, 0.7], [clink, 0.6], [thud, 0.25]));
    },
  },
  {
    // One link of chain landing on the coil: a small, quick clink.
    name: "wind",
    render: () => {
      const r = mulberry32(5);
      const n = secs(0.12);
      const click = mul(filter(white(n, r), "hp", 4000), env(n, 0.0003, 0.002));
      const clink = ring(n, [[3600, 1, 0.05], [5200, 0.6, 0.04], [7400, 0.35, 0.03]], r);
      return normalise(mix(n, [click, 0.5], [clink, 0.6]));
    },
  },
  {
    // Air rushing past the ball: a band of noise whose centre wanders, with a
    // breath of high air over it. Loops; the game raises it with speed.
    name: "whoosh",
    render: () => {
      const r = mulberry32(6);
      const n = secs(4.4);
      const centre = wander(n, 1.3, r);
      const body = filterSweep(white(n, r), "bp", (t) => 650 * Math.pow(1.7, centre[Math.min(n - 1, secs(t))]!), 0.9);
      const air = filter(white(n, r), "hp", 3000);
      const swell = wander(n, 2, r).map((v) => 0.8 + 0.2 * v);
      return normalise(loopable(mul(mix(n, [body, 1], [air, 0.12]), swell), 0.4));
    },
  },
  {
    // The ball dropping into water: the plop as it goes under, a spray of
    // broadband splash, bubbles popping behind it, and the water closing over.
    name: "splash",
    render: () => {
      const r = mulberry32(7);
      const n = secs(0.95);
      const plop = mul(sweep(n, 240, 720, 0.06), env(n, 0.002, 0.08));
      const body = mul(filter(white(n, r), "lp", 400), env(n, 0.003, 0.12));
      const spray = mul(filter(white(n, r), "bp", 2600, 0.6), env(n, 0.015, 0.33));
      const drops = grains(secs(0.7), r, 36, (rr) => mul(sweep(secs(0.03), uni(rr, 700, 1800), uni(rr, 1800, 3400), 0.015), env(secs(0.03), 0.001, 0.02)), [0.1, 0.4]);
      const close = mul(mul(filter(pink(n, r), "bp", 1000, 0.8), wander(n, 7, r).map((v) => 0.6 + 0.4 * v)), env(n, 0.2, 0.5));
      return normalise(softClip(mix(n, [plop, 0.6], [body, 0.7], [spray, 0.8], [drops, 1, 0.08], [close, 0.35]), 1.15));
    },
  },
  {
    // The ball pushing through water at its surface: burbling lapping water,
    // bubbles, and a low slosh. Loops.
    name: "wade",
    render: () => {
      const r = mulberry32(8);
      const n = secs(3.4);
      const burble = wander(n, 1.5, r).map((v, i) => 0.55 + 0.3 * v);
      const ripple = wander(n, 5, r).map((v) => 0.7 + 0.3 * v);
      const lap = mul(mul(filter(pink(n, r), "bp", 1400, 0.5), burble), ripple);
      const bubbles = grains(n, r, 8, (rr) => mul(sweep(secs(0.035), uni(rr, 400, 800), uni(rr, 900, 1600), 0.02), env(secs(0.035), 0.002, 0.025)), [0.08, 0.3]);
      const slosh = mul(filter(brown(n, r), "lp", 300), wander(n, 0.8, r).map((v) => 0.6 + 0.4 * v));
      return normalise(loopable(mix(n, [lap, 0.7], [bubbles, 1], [slosh, 0.4]), 0.4));
    },
  },
];

// --- output ------------------------------------------------------------------

function wav(x: Float64Array): Buffer {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]!));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun scripts/sfx.ts <outdir> [name ...]");
  process.exit(2);
}
const only = new Set(process.argv.slice(3));
mkdirSync(outDir, { recursive: true });
for (const s of SOUNDS) {
  if (only.size && !only.has(s.name)) continue;
  const x = s.render();
  writeFileSync(join(outDir, `${s.name}.wav`), wav(x));
  console.log(`${s.name}\t${(x.length / SR).toFixed(2)} s`);
}
