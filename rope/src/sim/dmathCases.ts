// Deterministic-libm cases, run by `cli dmath`.
//
// `engine/dmath.ts` is the sim's only source of transcendental functions, and
// what it promises is that every engine computes the same bits (see the header
// there). Nothing else in the suite can see that promise break: a port that
// drifts by an ulp replays every bundle to within its tolerance and diverges
// nothing until, frames later, a knife-edge branch goes the other way - which
// is exactly the class of finding the module exists to end. So it is asserted
// directly, three ways:
//
// - Every function is held to a committed table of bit-exact answers
//   (`dmathVectors.json`, inputs and outputs as hex bit patterns so no decimal
//   parsing is involved) and to a digest over twenty thousand more inputs.
//   The table is the spec: it was written by this code on V8 - where every
//   function but `pow` was also checked to agree with `Math` bit for bit over
//   200k random inputs - and it reproduces on JavaScriptCore (bun) and in
//   Chromium. `cli dmath --write` regenerates it, which is a deliberate act in
//   the way `cli restamp --write` is: the day it changes, every recording made
//   before it is evidence about a different libm.
// - The sim's sources are scanned for the `Math` members ECMAScript leaves
//   implementation-defined (and for `**`, which is `Math.pow`). A stray
//   `Math.sin` in a solver is the whole problem back, silently, so it is red.
// - A handful of closed-form facts, so a table that was regenerated from a
//   broken port cannot pass itself.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dmath, type DmathName } from "../engine/dmath";
import { TRIG_COS, TRIG_SIN, trigSlot } from "../engine/trig";
import committed from "./dmathVectors.json";

export interface DmathResult {
  name: string;
  passed: boolean;
  details: string[];
}

// The tree this file lives in - or, for a build of the CLI run from the tree
// (`bun build --target=node`, where import.meta.url is the bundle), the cwd.
const ROOT = [join(dirname(fileURLToPath(import.meta.url)), "..", ".."), process.cwd()].find((r) =>
  existsSync(join(r, "src", "engine", "dmath.ts")),
) ?? process.cwd();
const VECTORS_PATH = join(ROOT, "src", "sim", "dmathVectors.json");

// Directories whose every file is simulation, and the sim-side files of the
// tooling directory (the replay path and the rig authoring that feeds it).
const SIM_DIRS = ["src/engine", "src/classes", "src/lib", "src/level", "src/input", "src/playtest"];
const SIM_FILES = ["src/sim/rig.ts", "src/sim/replay.ts", "src/sim/record.ts", "src/sim/selfReplay.ts", "src/sim/playtest.ts"];

// The `Math` members whose results the spec does not pin down.
const BANNED_MATH = /\bMath\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt)\b/g;

// ---------------------------------------------------------------------------
// Bits.
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LE ? 1 : 0;
const LO = LE ? 0 : 1;

function toHex(x: number): string {
  if (x !== x) return "nan"; // a NaN's payload is not something the spec pins down either
  f64[0] = x;
  return u32[HI]!.toString(16).padStart(8, "0") + u32[LO]!.toString(16).padStart(8, "0");
}

function fromHex(h: string): number {
  if (h === "nan") return NaN;
  u32[HI] = parseInt(h.slice(0, 8), 16);
  u32[LO] = parseInt(h.slice(8, 16), 16);
  return f64[0]!;
}

function sameBits(a: number, b: number): boolean {
  return toHex(a) === toHex(b);
}

// ---------------------------------------------------------------------------
// Inputs. A small LCG and a sampler built from arithmetic and bit patterns
// alone, so generating the inputs cannot itself depend on a platform libm.
// ---------------------------------------------------------------------------

class Lcg {
  constructor(private seed: number) {}
  next(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}

const PI = 3.141592653589793;

function sample(rnd: Lcg): number {
  const r = rnd.next();
  const sign = rnd.next() < 0.5 ? -1 : 1;
  if (r < 0.3) return sign * rnd.next() * 10;
  if (r < 0.45) return sign * rnd.next() * 2 * PI;
  if (r < 0.55) return sign * (PI / 2) * Math.round(rnd.next() * 64) + (rnd.next() - 0.5) * 1e-6;
  if (r < 0.75) {
    // Any finite double at all, subnormals included.
    u32[HI] = (rnd.next() * 0x7ff00000) >>> 0;
    u32[LO] = (rnd.next() * 4294967296) >>> 0;
    return sign * f64[0]!;
  }
  if (r < 0.85) return sign * rnd.next();
  if (r < 0.92) return sign * Math.round(rnd.next() * 1000);
  return sign * rnd.next() * 1e6;
}

// Per-function domain shaping, and whether it takes two arguments.
const ARITY: Record<DmathName, 1 | 2> = {
  sin: 1,
  cos: 1,
  tan: 1,
  atan: 1,
  atan2: 2,
  asin: 1,
  acos: 1,
  exp: 1,
  expm1: 1,
  log: 1,
  log1p: 1,
  pow: 2,
  sinh: 1,
  cosh: 1,
  asinh: 1,
  atanh: 1,
  hypot: 2,
  scalbn: 2,
};

function shape(name: DmathName, i: number, x: number, y: number): [number, number] {
  switch (name) {
    case "asin":
    case "acos":
    case "atanh":
      return [x % 1, y];
    case "log":
      return [Math.abs(x), y];
    case "log1p":
      return [i % 2 ? x % 1 : Math.abs(x), y];
    case "pow": {
      const base = i % 3 === 0 ? x : Math.abs(x);
      const ex = i % 3 === 0 ? Math.trunc(y) % 64 : i % 2 ? y / 50 : y;
      return [base, ex];
    }
    case "scalbn":
      return [x, Math.trunc(y) % 2200];
    default:
      return [x, y];
  }
}

function call(name: DmathName, x: number, y: number): number {
  return ARITY[name] === 2 ? (dmath[name] as (a: number, b: number) => number)(x, y) : (dmath[name] as (a: number) => number)(x);
}

const NAMES = Object.keys(ARITY) as DmathName[];

// Inputs every function is asked about, on top of the random ones.
const SPECIALS: number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  10,
  22,
  23,
  1e-8,
  -1e-8,
  fromHex("3e40000000000000"), // 2^-27
  fromHex("3e30000000000000"), // 2^-28
  fromHex("3c90000000000000"), // 2^-54
  709,
  -745,
  710,
  1e300,
  -1e300,
  1e-300,
  fromHex("0000000000000001"), // smallest subnormal
  fromHex("7fefffffffffffff"), // largest double
  PI,
  PI / 2,
  PI / 4,
  (3 * PI) / 4,
  1e22, // rem_pio2's large-argument path
  fromHex("7e70000000000000"), // 2^1000
  Infinity,
  -Infinity,
  NaN,
];

const PAIR_SPECIALS: number[] = [0, -0, 1, -1, 0.5, 2, 3, -2, 1 / 3, 10, Infinity, -Infinity, NaN, 1e-300, 1e300];

const VECTOR_SAMPLES = 40;
const DIGEST_SAMPLES = 20000;

type Vector = string[]; // [inHex, (inHex2,) outHex]

interface VectorFile {
  vectors: Record<string, Vector[]>;
  digests: Record<string, string>;
}

function vectorInputs(name: DmathName): [number, number][] {
  const rnd = new Lcg(0x9e3779b9 ^ name.length);
  const out: [number, number][] = [];
  if (ARITY[name] === 1) {
    for (const s of SPECIALS) out.push([s, 0]);
  } else {
    for (const a of PAIR_SPECIALS) for (const b of PAIR_SPECIALS) out.push([a, b]);
  }
  for (let i = 0; i < VECTOR_SAMPLES; i++) out.push(shape(name, i, sample(rnd), sample(rnd)));
  return out;
}

function digestOf(name: DmathName): string {
  const rnd = new Lcg(424242 + name.length * 7919);
  let hash = 2166136261;
  for (let i = 0; i < DIGEST_SAMPLES; i++) {
    const [x, y] = shape(name, i, sample(rnd), sample(rnd));
    const r = call(name, x, y);
    f64[0] = r !== r ? fromHex("7ff8000000000000") : r;
    hash = Math.imul(hash ^ u32[0]!, 16777619) >>> 0;
    hash = Math.imul(hash ^ u32[1]!, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function currentVectors(): VectorFile {
  const vectors: Record<string, Vector[]> = {};
  const digests: Record<string, string> = {};
  for (const name of NAMES) {
    vectors[name] = vectorInputs(name).map(([x, y]) =>
      ARITY[name] === 2 ? [toHex(x), toHex(y), toHex(call(name, x, y))] : [toHex(x), toHex(call(name, x, 0))],
    );
    digests[name] = digestOf(name);
  }
  return { vectors, digests };
}

// Regenerate `dmathVectors.json` from this tree's dmath. Returns the vector count.
export function writeDmathVectors(): number {
  const file = currentVectors();
  const body = {
    note:
      "Bit-exact answers of engine/dmath.ts, as hex bit patterns (nan for NaN). " +
      "Written by `cli dmath --write` on V8; the same bits must come out of every engine. " +
      "Regenerating it is a determinism change: every recording made before it may replay differently.",
    ...file,
  };
  writeFileSync(VECTORS_PATH, JSON.stringify(body, null, 1) + "\n");
  return Object.values(file.vectors).reduce((n, v) => n + v.length, 0);
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

function vectorCase(name: DmathName): DmathResult {
  const details: string[] = [];
  const table = (committed as VectorFile).vectors[name];
  if (!table) return { name: `vectors: ${name}`, passed: false, details: ["no committed vectors - run `cli dmath --write`"] };
  let bad = 0;
  for (const v of table) {
    const x = fromHex(v[0]!);
    const y = ARITY[name] === 2 ? fromHex(v[1]!) : 0;
    const want = fromHex(v[ARITY[name]]!);
    const got = call(name, x, y);
    if (!sameBits(got, want)) {
      bad++;
      if (details.length < 4) {
        details.push(`${name}(${x}${ARITY[name] === 2 ? `, ${y}` : ""}) = ${got} [${toHex(got)}], committed ${want} [${toHex(want)}]`);
      }
    }
  }
  const digest = digestOf(name);
  const wantDigest = (committed as VectorFile).digests[name];
  const digestOk = digest === wantDigest;
  if (!digestOk) details.push(`digest over ${DIGEST_SAMPLES} inputs ${digest}, committed ${wantDigest}`);
  if (bad > 0) details.unshift(`${bad}/${table.length} committed vectors differ`);
  return { name: `vectors: ${name} (${table.length} vectors + digest)`, passed: bad === 0 && digestOk, details };
}

// Facts with a closed form, independent of the table.
function factsCase(): DmathResult {
  const details: string[] = [];
  const check = (label: string, ok: boolean) => {
    if (!ok) details.push(label);
  };
  const bits = (x: number, hex: string, label: string) => check(`${label}: ${toHex(x)} want ${hex}`, toHex(x) === hex);
  bits(dmath.sin(0), "0000000000000000", "sin(0) = 0");
  bits(dmath.sin(-0), "8000000000000000", "sin(-0) = -0");
  bits(dmath.cos(0), "3ff0000000000000", "cos(0) = 1");
  bits(dmath.sin(PI / 2), "3ff0000000000000", "sin(pi/2) = 1");
  bits(dmath.cos(PI), "bff0000000000000", "cos(pi) = -1");
  bits(dmath.tan(PI / 4), "3fefffffffffffff", "tan(pi/4), fdlibm's answer, 1 ulp under 1");
  bits(dmath.atan2(0, -1), "400921fb54442d18", "atan2(0, -1) = pi");
  bits(dmath.atan2(-0, -1), "c00921fb54442d18", "atan2(-0, -1) = -pi");
  bits(dmath.atan2(1, 0), "3ff921fb54442d18", "atan2(1, 0) = pi/2");
  bits(dmath.atan2(1, 1), "3fe921fb54442d18", "atan2(1, 1) = pi/4");
  bits(dmath.atan(1), "3fe921fb54442d18", "atan(1) = pi/4");
  bits(dmath.asin(1), "3ff921fb54442d18", "asin(1) = pi/2");
  bits(dmath.acos(-1), "400921fb54442d18", "acos(-1) = pi");
  bits(dmath.acos(1), "0000000000000000", "acos(1) = 0");
  bits(dmath.exp(0), "3ff0000000000000", "exp(0) = 1");
  bits(dmath.exp(1), "4005bf0a8b145769", "exp(1) = e");
  bits(dmath.exp(-Infinity), "0000000000000000", "exp(-inf) = 0");
  bits(dmath.log(1), "0000000000000000", "log(1) = 0");
  bits(dmath.log(Math.E), "3ff0000000000000", "log(e) = 1");
  bits(dmath.log(0), "fff0000000000000", "log(0) = -inf");
  bits(dmath.log1p(0), "0000000000000000", "log1p(0) = 0");
  bits(dmath.expm1(0), "0000000000000000", "expm1(0) = 0");
  bits(dmath.pow(2, 10), "4090000000000000", "pow(2, 10) = 1024");
  bits(dmath.pow(2, 0.5), "3ff6a09e667f3bcd", "pow(2, 0.5) = sqrt(2)");
  bits(dmath.pow(-2, 3), "c020000000000000", "pow(-2, 3) = -8");
  bits(dmath.pow(0, 0), "3ff0000000000000", "pow(0, 0) = 1");
  bits(dmath.pow(10, -2), "3f847ae147ae147b", "pow(10, -2) = 0.01");
  bits(dmath.hypot(3, 4), "4014000000000000", "hypot(3, 4) = 5");
  bits(dmath.hypot(0, 0), "0000000000000000", "hypot(0, 0) = 0");
  bits(dmath.sinh(0), "0000000000000000", "sinh(0) = 0");
  bits(dmath.cosh(0), "3ff0000000000000", "cosh(0) = 1");
  bits(dmath.asinh(0), "0000000000000000", "asinh(0) = 0");
  bits(dmath.atanh(0), "0000000000000000", "atanh(0) = 0");
  bits(dmath.atanh(1), "7ff0000000000000", "atanh(1) = inf");
  bits(dmath.scalbn(1, 10), "4090000000000000", "scalbn(1, 10) = 1024");
  bits(dmath.scalbn(1, -1074), "0000000000000001", "scalbn(1, -1074) = min subnormal");
  check("pow(-8, 1/3) is NaN", Number.isNaN(dmath.pow(-8, 1 / 3)));
  check("log(-1) is NaN", Number.isNaN(dmath.log(-1)));
  check("asin(2) is NaN", Number.isNaN(dmath.asin(2)));
  check("sin(inf) is NaN", Number.isNaN(dmath.sin(Infinity)));
  check("NaN propagates", NAMES.every((n) => Number.isNaN(call(n, NaN, 1)) || n === "pow" || n === "hypot" || n === "scalbn"));
  check("pow(NaN, 0) = 1", dmath.pow(NaN, 0) === 1);
  check("hypot(NaN, inf) = inf", dmath.hypot(NaN, Infinity) === Infinity);
  // Odd and even symmetries, to the bit, on a spread of arguments.
  const rnd = new Lcg(7);
  for (let i = 0; i < 200; i++) {
    const x = sample(rnd);
    check(`sin is odd at ${x}`, sameBits(dmath.sin(-x), -dmath.sin(x)));
    check(`cos is even at ${x}`, sameBits(dmath.cos(-x), dmath.cos(x)));
    check(`atan is odd at ${x}`, sameBits(dmath.atan(-x), -dmath.atan(x)));
    check(`sinh is odd at ${x}`, sameBits(dmath.sinh(-x), -dmath.sinh(x)));
    check(`asinh is odd at ${x}`, sameBits(dmath.asinh(-x), -dmath.asinh(x)));
    check(`tan is odd at ${x}`, sameBits(dmath.tan(-x), -dmath.tan(x)));
  }
  // Accuracy, loosely: each function is within an ulp of the true value, so
  // exp(log(x)) for x within a decade or two of 1 (where log's own half-ulp is
  // small in absolute terms) lands within a few ulps of x, and the Pythagorean
  // identity holds to double precision.
  for (let i = 0; i < 200; i++) {
    const x = 0.5 + (Math.abs(sample(rnd)) % 100);
    const back = dmath.exp(dmath.log(x));
    check(`exp(log(${x})) within 8 ulp`, Math.abs(back - x) <= 8 * ulp(x));
    const s = dmath.sin(x);
    const c = dmath.cos(x);
    check(`sin^2+cos^2 at ${x}`, Math.abs(s * s + c * c - 1) <= 4e-16);
  }
  check("dmath is frozen", Object.isFrozen(dmath));
  return { name: "facts", passed: details.length === 0, details: details.slice(0, 8) };
}

function ulp(x: number): number {
  const ax = Math.abs(x);
  f64[0] = ax;
  u32[LO] = u32[LO]! + 1;
  if (u32[LO] === 0) u32[HI] = u32[HI]! + 1;
  return f64[0]! - ax;
}

// The platform's basic arithmetic is what the port stands on.
function ieeeCase(): DmathResult {
  const details: string[] = [];
  const bits = (x: number, hex: string, label: string) => {
    if (toHex(x) !== hex) details.push(`${label}: ${toHex(x)} want ${hex}`);
  };
  bits(0.1 + 0.2, "3fd3333333333334", "0.1 + 0.2");
  bits(Math.sqrt(2), "3ff6a09e667f3bcd", "sqrt(2)");
  bits(1 / 3, "3fd5555555555555", "1/3");
  bits(1e-300 * 1e-300, "0000000000000000", "underflow to zero");
  bits(4.16666666666666019037e-2, "3fa555555555554c", "a 21-digit fdlibm literal (informational: dmath does not rely on it)");
  bits(fromHex("3fa555555555554c"), "3fa555555555554c", "word insertion round trip");
  // No fused multiply-add: a*b+c must round twice.
  const a = 1 + 2 ** -52;
  const fma = a * a - 1;
  bits(fma, "3cc0000000000000", "a*b-c rounds the product first (no FMA contraction)");
  return { name: "ieee baseline", passed: details.length === 0, details };
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}

// The sim may not call the platform libm.
function scanCase(): DmathResult {
  const files: string[] = [];
  for (const d of SIM_DIRS) walk(join(ROOT, d), files);
  for (const f of SIM_FILES) files.push(join(ROOT, f));
  const details: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = relative(ROOT, file);
    if (rel === join("src", "engine", "dmath.ts")) continue;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const banned = line.match(BANNED_MATH);
      if (banned) details.push(`${rel}:${i + 1}: ${banned.join(", ")} - use dmath`);
      if (/\*\*/.test(line)) details.push(`${rel}:${i + 1}: \`**\` is Math.pow - use dmath.pow`);
    });
  }
  return { name: `no platform libm in the sim (${files.length} files)`, passed: details.length === 0, details: details.slice(0, 12) };
}

// The rotation memo in front of dmath (engine/trig.ts) is exact: a hit is the
// bits a fresh computation gives, +0 and -0 included, however the slots are
// being reused.
function trigCacheCase(): DmathResult {
  const details: string[] = [];
  const rnd = new Lcg(31337);
  const angles: number[] = [0, -0, PI, -PI, PI / 2, 1e-300, -1e-300, 1e22, NaN, Infinity];
  for (let i = 0; i < 5000; i++) angles.push(sample(rnd));
  // Ask twice in a shuffled order, so every answer is checked both as a miss
  // and (usually) as a hit, with other angles evicting in between.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < angles.length; i++) {
      const a = angles[(i * 7919 + pass * 13) % angles.length]!;
      const slot = trigSlot(a);
      const c = TRIG_COS[slot]!;
      const s = TRIG_SIN[slot]!;
      if (!sameBits(c, dmath.cos(a)) || !sameBits(s, dmath.sin(a))) {
        if (details.length < 4) details.push(`trig cache at ${a}: cos ${toHex(c)} sin ${toHex(s)}, dmath ${toHex(dmath.cos(a))} ${toHex(dmath.sin(a))}`);
      }
    }
  }
  return { name: "rotation cache is bit-exact", passed: details.length === 0, details };
}

export function runDmathCases(): DmathResult[] {
  return [ieeeCase(), factsCase(), ...NAMES.map(vectorCase), trigCacheCase(), scanCase()];
}
