// How loud each sound event actually PLAYS, family against family, in real
// play: `bun scripts/audit-sound-levels.ts [bundle ...]` (default: the
// regression corpus).
//
// Every bundle is replayed through the game's own sound observer (with the
// released chain's reel, as main.ts drives it), and every event it emits is
// levelled exactly as `AudioOut.playStep` levels it: the slot it resolves to,
// the slot's volume, each file's clip edit, and the speed curve
// (`strikeLevel`, `loopLevel`, `windLevel` in playbackLevel.ts). The level
// reported is the file's loudest 50 ms (the transient reference
// tools/audio/balance.py calibrates to) plus all of that gain, in dBFS before
// the master bus: what one event sounds at, comparable across families.
// One-shots are counted per event, loops per step they sound.
//
// Not covered: rolling's runtime grain processing and filters (balance.py
// excludes it too, measured in the browser), the browser's spatial panning,
// and masking - two events at the same level are not equally audible.

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { levelFromRecording } from "../src/sim/replay";
import { recordingDeserializer } from "../src/sim/trace";
import { ChainRetract } from "../src/render/chainRetract";
import { SoundObserver, type SoundStep } from "../src/audio/soundObserver";
import { SOUND_BANK, clipPlay, landingMix, resolveSlot, type SoundFamily } from "../src/audio/slots";
import { SOUND_ASSETS } from "../src/audio/library";
import { loopLevel, strikeLevel, windLevel } from "../src/audio/playbackLevel";
import { SURFACE_KINDS, type SurfaceKind } from "../src/audio/surfaces";

const SR = 48000;
const dB = (g: number): number => 20 * Math.log10(Math.max(g, 1e-9));

// Per file: its loudest 50 ms inside its clip window (dBFS) and the window's
// played length (s), decoded once.
const files = new Map<string, { burst: number; seconds: number }>();
function measure(key: string): { burst: number; seconds: number } {
  const known = files.get(key);
  if (known) return known;
  const asset = SOUND_ASSETS[key];
  if (!asset) throw new Error(`no asset ${key}`);
  const out = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", `public${asset.file}`, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
  const x = new Float32Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + out.stdout.byteLength));
  const clip = clipPlay(SOUND_BANK, key, x.length / SR);
  const a = Math.round(clip.start * SR);
  const b = Math.round(clip.end * SR);
  const w = Math.min(b - a, Math.round(0.05 * SR));
  let sum = 0;
  for (let i = a; i < a + w; i++) sum += x[i]! * x[i]!;
  let best = sum;
  for (let i = a + w; i < b; i++) {
    sum += x[i]! * x[i]! - x[i - w]! * x[i - w]!;
    if (sum > best) best = sum;
  }
  const m = { burst: dB(Math.sqrt(best / w)) + dB(clip.gain), seconds: (clip.end - clip.start) / clip.rate };
  files.set(key, m);
  return m;
}

// A slot's files averaged in power: one event of it, whichever file plays.
function slotLevel(keys: readonly string[]): { burst: number; seconds: number } {
  const ms = keys.map(measure);
  const power = ms.reduce((s, m) => s + 10 ** (m.burst / 10), 0) / ms.length;
  return { burst: 10 * Math.log10(power), seconds: ms.reduce((s, m) => s + m.seconds, 0) / ms.length };
}

const samples = new Map<string, number[]>();
function note(name: string, level: number): void {
  if (!Number.isFinite(level)) return;
  let list = samples.get(name);
  if (!list) samples.set(name, (list = []));
  list.push(level);
}

function strike(family: SoundFamily, surface: SurfaceKind | null, speed: number): void {
  const layers = family === "land" ? landingMix(SOUND_BANK, surface, speed) : [resolveSlot(SOUND_BANK, family, surface)].filter((r) => r !== null).map((r) => ({ ...r!, weight: 1 }));
  let power = 0;
  for (const l of layers) {
    const s = slotLevel(l.params.sounds);
    const g = l.weight * 10 ** (l.params.volume / 20) * strikeLevel(family, speed, l.params.refSpeed, s.seconds);
    power += (10 ** (s.burst / 20) * g) ** 2;
  }
  if (power > 0) note(family === "land" ? "land (mix)" : family, 10 * Math.log10(power));
}

function loop(family: SoundFamily, surface: SurfaceKind | null, speed: number, acceleration = 0): void {
  if (!(speed > 0)) return;
  const r = resolveSlot(SOUND_BANK, family, surface);
  if (!r) return;
  const ratio = speed / Math.max(r.params.refSpeed, 1e-3);
  const level = family === "whoosh" ? windLevel(speed, acceleration, r.params.refSpeed) : loopLevel(family, ratio);
  if (level <= 1e-4) return;
  note(`${family} (loop)`, slotLevel(r.params.sounds).burst + r.params.volume + dB(level));
}

// `AudioOut.playStep`, event by event.
function play(step: SoundStep): void {
  for (const surface of SURFACE_KINDS) {
    if (surface === "vine") continue;
    const roll = step.roll.get(surface);
    if (roll) loop("roll", surface, roll.speed);
  }
  loop("whoosh", null, step.air.speed, step.air.acceleration ?? 0);
  loop("deploy", null, step.deploy?.speed ?? 0);
  if (step.retractZip) strike("retract", null, step.retractZip.speed);
  for (const c of step.jingles ?? []) strike("slack", null, c.speed);
  if (step.hookDrag) loop("hook-drag", step.hookDrag.surface, step.hookDrag.speed);
  if (step.drag) loop("chain-drag", step.drag.surface, step.drag.speed);
  for (const c of step.chainImpacts ?? []) strike("chain-hit", c.surface, c.speed);
  loop("wade", null, step.wade.speed * step.wade.interface);
  if (step.splash) strike("splash", null, step.splash.speed);
  for (const s of step.strikes) strike(s.family, s.surface, s.speed);
  for (const c of step.clinks) strike("wind", null, c.speed);
  if (step.taut) strike("taut", null, step.taut.speed);
  for (const c of step.creaks ?? []) strike("creak", null, c.speed);
  for (const c of step.wraps ?? []) strike("wrap", c.surface, c.speed);
}

const args = process.argv.slice(2);
const bundles = args.length > 0 ? args : readdirSync("playtests/regressions").filter((f) => /\.json(\.gz)?$/.test(f)).map((f) => `playtests/regressions/${f}`);
let frames = 0;
for (const path of bundles) {
  const raw = readFileSync(path);
  const rec = JSON.parse(path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
  let level;
  try {
    level = levelFromRecording(rec);
  } catch {
    continue; // a bundle naming a level that no longer exists
  }
  const de = recordingDeserializer(rec);
  const retract = new ChainRetract();
  const observer = new SoundObserver();
  for (const f of rec.frames) {
    level.physicsProcess(de(f), 1 / 60);
    retract.observe(level, 1 / 60);
    play(observer.observe(level, 1 / 60, retract));
    frames++;
  }
}

const pct = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
console.log(`${bundles.length} bundles, ${frames} steps (${(frames / 60).toFixed(0)} s of play). Level of one event: loudest 50 ms, dBFS before the master bus.`);
console.log("family".padEnd(20) + "count".padStart(8) + "median".padStart(9) + "p90".padStart(8) + "max".padStart(8));
for (const [name, xs] of [...samples].sort((a, b) => pct(b[1].sort((p, q) => p - q), 0.5) - pct(a[1].sort((p, q) => p - q), 0.5))) {
  xs.sort((a, b) => a - b);
  console.log(name.padEnd(20) + String(xs.length).padStart(8) + pct(xs, 0.5).toFixed(1).padStart(9) + pct(xs, 0.9).toFixed(1).padStart(8) + xs[xs.length - 1]!.toFixed(1).padStart(8));
}
