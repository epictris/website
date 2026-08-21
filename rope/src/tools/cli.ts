// Headless CLI for replay/playtest tooling. Run with bun:
//   bun run src/tools/cli.ts play      playtests/retract.json
//   bun run src/tools/cli.ts replay    bundle.json
//   bun run src/tools/cli.ts dump      bundle.json [--from A] [--to B] [--every N]
//   bun run src/tools/cli.ts query     bundle.json [--frame N | --from A --to B]
//                                      [--every K] [--body ID] [--json]
//   bun run src/tools/cli.ts continue  bundle.json [--from N] [--hold left,jump|deploy]
//                                      [--aim X,Y] [--frames M] [--every K]
//                                      [--trace out.jsonl]
//   bun run src/tools/cli.ts record    [<level>] script.json [--out session.json]
//   bun run src/tools/cli.ts compare   bundle.json --frame N --ref <rev> [--frames M]
//                                      [--json]
//   bun run src/tools/cli.ts settle    bundle.json [--from N] [--frames M] [--every K]
//   bun run src/tools/cli.ts scan      bundle.json | --all   [--top K] [--json]
//   bun run src/tools/cli.ts trace     bundle.json [--from A] [--to B] [--body ID]
//                                      [--out t.jsonl]
//   bun run src/tools/cli.ts render    bundle.json [--frame N] [--out file.svg]
//   bun run src/tools/cli.ts shot      bundle.json [--frame N] [--zoom Z] [--3d]
//                                      [--out f.png] [--allow-errors]
//   bun run src/tools/cli.ts shot      bundle.json --frames A..B [--every K] [--3d]
//   bun run src/tools/cli.ts shot      --diff a.png b.png [--out diff.png]
//   bun run src/tools/cli.ts chainpath bundle.json [--from A] [--to B] [--every N]
//   bun run src/tools/cli.ts fork      bundle.json --frame N [--frames M] [--out prefix]
//   bun run src/tools/cli.ts bundles   [dir]        (default playtests/bundles)
//   bun run src/tools/cli.ts selftest
//   bun run src/tools/cli.ts corners
//   bun run src/tools/cli.ts decompose
//   bun run src/tools/cli.ts contacts
//   bun run src/tools/cli.ts render3d
//
// Exit codes: 0 = pass/healthy, 1 = failure/violation, 2 = usage error.
// (replay: 2 = diverged-but-healthy, 3 = invariant violated.)

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Level } from "../level/level";
import { PhysTrace } from "../engine/physTrace";
import { runScript, type PlaytestScript } from "../sim/playtest";
import { recordScript } from "../sim/record";
import { replayRecording, levelFromRecording } from "../sim/replay";
import { frameView, type BodyView, type FrameView } from "../sim/query";
import { notable, scanRecording } from "../sim/scan";
import { compareFrame, diffCompareFrames, type CompareFrame } from "../sim/compare";
import { renderFrameSVG } from "../sim/svgFrame";
import { BallLevel } from "../level/ballLevel";
import { RigidBody2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER } from "../engine/units";
import { findChromium, grab, PageNotReady, type PageLogEntry } from "./shotRunner";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import {
  ACTIONS,
  checkBallInvariants,
  checkInvariants,
  digest,
  digestBall,
  EnergyMonitor,
  RollMonitor,
  inputDeserializer,
  kineticEnergy,
  StuckDetector,
  type Digest,
  type Recording,
  type Violation,
} from "../sim/trace";

const [, , cmd, arg, ...rest] = process.argv;

// Where bundles live: the committed regression corpus first, then the local
// scratch dir (gitignored, and absent in a fresh clone).
export const BUNDLE_DIRS = ["playtests/regressions", "playtests/bundles"];

function fail(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

// --flag value parsing for the commands that take options.
function opts(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) out[a.slice(2)] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
  }
  return out;
}

// The bare arguments, with every `--flag value` pair removed — a flag's VALUE is
// not a positional, and reading it as one turned `--out foo.json` into a file
// the command then tried to read.
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    if (args[i + 1] && !args[i + 1]!.startsWith("--")) i++;
  }
  return out;
}

// Bundles replay from frame 0 by design, so a committed one is committed whole;
// `.json.gz` is accepted transparently so the regression corpus can be stored
// compressed rather than trimmed (a trimmed bundle is a different bug).
function loadRecording(file: string): Recording {
  const raw = readFileSync(file);
  const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as Recording;
}

function isBundleFile(f: string): boolean {
  return f.endsWith(".json") || f.endsWith(".json.gz");
}

function heldActions(h: number): string {
  const held = ACTIONS.filter((_, i) => h & (1 << i));
  return held.length ? held.join("+") : "-";
}

function digestRow(d: Digest, held: string): string {
  return (
    `f${String(d.frame).padStart(4)} ` +
    `px=${d.px.toFixed(1).padStart(8)} py=${d.py.toFixed(1).padStart(8)} ` +
    `vx=${d.vx.toFixed(1).padStart(7)} vy=${d.vy.toFixed(1).padStart(7)} ` +
    `${d.state.padEnd(15)} ${held}`
  );
}

function printViolations(violations: Violation[], max = 20): void {
  for (const v of violations.slice(0, max)) console.log(`  VIOLATION f${v.frame} ${v.kind}: ${v.detail}`);
  if (violations.length > max) console.log(`  … ${violations.length - max} more violations`);
}

// Human-readable divergence summary. Behavioural drift is the real signal;
// bit-exact mismatch on a settled body is float noise and is reported as such,
// not as "diverged", so it stops reading like a regression.
function divergenceLine(r: {
  divergedAtFrame: number | null;
  divergedByStateFork: boolean | null;
  bitDivergedAtFrame: number | null;
  maxDrift: number;
}): string {
  const drift = `maxDrift=${(r.maxDrift * 100).toFixed(2)}px`;
  if (r.divergedAtFrame !== null) {
    return r.divergedByStateFork
      ? `behaviour forked @f${r.divergedAtFrame} (different state branch; ${drift} where states agree)`
      : `drifted @f${r.divergedAtFrame} (${drift})`;
  }
  if (r.bitDivergedAtFrame !== null) return `bit-identical behaviour (${drift} float noise @f${r.bitDivergedAtFrame}+)`;
  return `bit-exact match with recording`;
}

// The same summary for the rest of the scene, and it names the body: a
// regression in scenery has to read as loudly as one in the avatar, which is
// exactly what an avatar-only digest could not do (session-298f).
// Null when the bundle predates `worldDigests` — there is nothing to compare.
function worldDivergenceLine(r: {
  worldDivergedAtFrame: number | null;
  worldDivergedName: string | null;
  worldBitDivergedAtFrame: number | null;
  worldMaxDrift: number;
  worldMaxDriftName: string | null;
  worldComparedFrames: number;
}): string | null {
  if (r.worldComparedFrames === 0) return null;
  const drift = `maxDrift=${(r.worldMaxDrift * 100).toFixed(2)}px${
    r.worldMaxDriftName ? ` on ${r.worldMaxDriftName}` : ""
  }`;
  if (r.worldDivergedAtFrame !== null) {
    return `world: ${r.worldDivergedName} drifted @f${r.worldDivergedAtFrame} (${drift})`;
  }
  if (r.worldBitDivergedAtFrame !== null) {
    return `world: bit-identical behaviour (${drift} float noise @f${r.worldBitDivergedAtFrame}+)`;
  }
  return `world: bit-exact match with recording`;
}

// How many frames of the run actually had a recorded full-world digest to be
// compared against — 0 means the bundle predates them and the world lines are
// silent rather than falsely green.
function worldComparedFrames(rec: Recording, framesRun: number): number {
  return Math.min(rec.worldDigests?.length ?? 0, framesRun);
}

function cmdPlay(file: string): void {
  const script = JSON.parse(readFileSync(file, "utf8")) as PlaytestScript;
  const r = runScript(script);
  console.log(`[play] ${file} — level=${r.level} frames=${r.framesRun}`);
  for (const a of r.assertResults) console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.description}`);
  printViolations(r.violations);
  console.log(r.passed ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(r.passed ? 0 : 1);
}

function cmdReplay(file: string): void {
  const rec = loadRecording(file);
  const r = replayRecording(rec);
  console.log(`[replay] ${file} — level=${r.level} frames=${r.framesRun}${rec.git ? ` recorded@${rec.git}` : ""}`);
  console.log("  " + divergenceLine(r));
  const world = worldDivergenceLine({ ...r, worldComparedFrames: worldComparedFrames(rec, r.framesRun) });
  if (world) console.log("  " + world);
  printViolations(r.violations);
  // exit 0 healthy, 2 diverged-but-healthy (fix working), 3 invariant violated.
  const code = r.violations.length > 0 ? 3 : r.divergedAtFrame !== null ? 2 : 0;
  console.log(`RESULT: ${code === 0 ? "HEALTHY" : code === 2 ? "DIVERGED (healthy)" : "VIOLATIONS"}`);
  process.exit(code);
}

// Digest + input table for a bundle — replays with current physics so the
// rows reflect what the sim does *now* (recorded digests may be stale).
function cmdDump(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const r = replayRecording(rec);
  const from = Number(o.from ?? 1);
  const to = Number(o.to ?? r.digests.length);
  const every = Number(o.every ?? 4);
  console.log(`[dump] ${file} — level=${r.level} frames=${r.framesRun} (current physics)`);
  console.log("  " + divergenceLine(r));
  const world = worldDivergenceLine({ ...r, worldComparedFrames: worldComparedFrames(rec, r.framesRun) });
  if (world) console.log("  " + world);
  for (let i = from - 1; i < Math.min(to, r.digests.length); i += every) {
    console.log("  " + digestRow(r.digests[i]!, heldActions(rec.frames[i]?.h ?? 0)));
  }
  printViolations(r.violations);
  process.exit(0);
}

// Replay a bundle up to --from, then take over with --hold input fed through
// the same deserializer (correct pressed/released edges relative to the
// recording), checking invariants + the stuck detector throughout.
function cmdContinue(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const from = Math.min(Number(o.from ?? rec.frames.length), rec.frames.length);
  const frames = Number(o.frames ?? 120);
  const every = Number(o.every ?? 3);
  const holdNames = (o.hold ?? "").split(",").filter(Boolean);
  // The ball controller's actions are the same FrameInput fields under its own
  // names (aim→mouse, deploy→fire, restart→jump), so both controllers are driven
  // through one table rather than through two input paths that could disagree.
  const NAME_TO_BIT: Record<string, number> = {
    left: 1 << 0,
    right: 1 << 1,
    jump: 1 << 2,
    restart: 1 << 2,
    retract: 1 << 3,
    extend: 1 << 4,
    fire: 1 << 5,
    deploy: 1 << 5,
  };
  let heldBits = 0;
  for (const n of holdNames) {
    if (!(n in NAME_TO_BIT)) fail(`unknown --hold action: ${n} (${Object.keys(NAME_TO_BIT).join("|")})`);
    heldBits |= NAME_TO_BIT[n]!;
  }
  // Where the ball is told to aim, in metres, or "at itself" (= not aiming),
  // which is what an unspecified aim has to mean rather than a steer toward the
  // origin.
  const aim = o.aim ? o.aim.split(",").map(Number) : null;
  if (aim && (aim.length !== 2 || aim.some(Number.isNaN))) fail("--aim takes x,y in metres");

  const level = levelFromRecording(rec);
  const ball = level instanceof BallLevel ? level : null;
  const de = inputDeserializer();
  const stuck = new StuckDetector();
  const energy = new EnergyMonitor();
  const roll = new RollMonitor();
  const violations: Violation[] = [];

  for (let i = 0; i < from; i++) level.physicsProcess(de(rec.frames[i]!), 1 / 60);

  if (o.trace) {
    PhysTrace.reset();
    PhysTrace.enabled = true;
    if (!ball) {
      (level as Level).player.stateChanged = (s) =>
        PhysTrace.emit({ t: "transition", to: s.constructor.name });
    }
  }

  console.log(`[continue] ${file} — level=${rec.level} from=f${from} hold=${holdNames.join("+") || "-"} frames=${frames}`);
  for (let i = 0; i < frames; i++) {
    const pos = ball ? ball.ball.globalPosition : (level as Level).player.globalPosition;
    const aimAt = aim ? new Vec2(aim[0]!, aim[1]!) : pos;
    const input = de({ h: heldBits, mx: aimAt.x, my: aimAt.y });
    level.physicsProcess(input, 1 / 60);
    const d = ball ? digestBall(ball) : digest(level as Level);
    if (ball) {
      violations.push(...checkBallInvariants(ball));
      const ev = energy.push(ball, input);
      if (ev) violations.push(ev);
      const rv = roll.push(ball);
      if (rv) violations.push(rv);
    } else {
      violations.push(...checkInvariants(level as Level));
      const sv = stuck.push(level as Level, input);
      if (sv) violations.push(sv);
    }
    if (PhysTrace.enabled && !ball) {
      const s = (level as Level).player.state as {
        supportBody?: { name?: string; constructor: { name: string } } | null;
      };
      PhysTrace.emit({
        t: "frame",
        state: d.state,
        px: Number(d.px.toFixed(2)),
        py: Number(d.py.toFixed(2)),
        vx: Number(d.vx.toFixed(2)),
        vy: Number(d.vy.toFixed(2)),
        sup: s.supportBody ? s.supportBody.name || s.supportBody.constructor.name : null,
      });
    }
    if (i % every === 0) console.log("  " + digestRow(d, heldActions(heldBits)));
  }

  if (o.trace) {
    writeFileSync(o.trace, PhysTrace.lines.join("\n") + "\n");
    console.log(`  trace: ${PhysTrace.lines.length} records → ${o.trace}`);
    PhysTrace.enabled = false;
  }
  printViolations(violations);
  console.log(violations.length === 0 ? "RESULT: HEALTHY" : "RESULT: VIOLATIONS");
  process.exit(violations.length === 0 ? 0 : 1);
}

// Re-simulate a bundle up to --frame and write an SVG snapshot of the scene
// (bodies + chain wrap path + avatar). Makes geometric glitches visible without
// a browser. Defaults to the last frame; --out defaults to <bundle>.f<N>.svg.
function cmdRender(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const target = Math.min(Number(o.frame ?? rec.frames.length), rec.frames.length);
  for (let i = 0; i < target; i++) level.physicsProcess(de(rec.frames[i]!), 1 / 60);
  const svg = renderFrameSVG(level);
  const out = o.out ?? `${file.replace(/\.json$/, "")}.f${target}.svg`;
  writeFileSync(out, svg);
  console.log(`[render] ${file} @f${target} → ${out}`);
  process.exit(0);
}

// Compact one-line state of the avatar+chain at the current frame, for the A/B
// fork trace. Ball: deploy phase (HOOK flying / tip dangling / anch anchored) +
// chain end body + path length + ball speed. Grapple: player state + rope length.
function forkStateLine(level: Level | BallLevel): string {
  if (level instanceof BallLevel) {
    const b = level.ball;
    const c = b.chain;
    const phase = b.hookInFlight ? "HOOK" : b.chainTip ? "tip " : c ? "anch" : "----";
    const end = c ? c.end.contact.obj.constructor.name.replace("Body2D", "") : "-";
    const len = c ? (c.getCurrentLength() * PIXELS_PER_METER).toFixed(0) : "-";
    const spd = (b.linearVelocity.length() * PIXELS_PER_METER).toFixed(0);
    return `${phase} end=${end.padEnd(8)} len=${len.padStart(4)} ballSpd=${spd.padStart(5)}px/s`;
  }
  const p = level.player;
  const rope = p.rope ? (p.rope.getCurrentLength() * PIXELS_PER_METER).toFixed(0) : "-";
  const spd = (p.velocity.length() * PIXELS_PER_METER).toFixed(0);
  return `${p.state.constructor.name.padEnd(16)} rope=${rope.padStart(4)} spd=${spd.padStart(5)}px/s`;
}

// A/B fork: re-simulate a bundle to --frame (the frame just before an issue),
// then continue on the recorded inputs and print a compact state trace across
// the window, plus before/after SVGs. Because the sim is deterministic and a fix
// only bites at the issue frame, running this on two git checkouts (old ref vs
// current working tree — see scripts/abtest.sh) reproduces the SAME pre-issue
// state in both, so the diff of the two traces IS the fix's effect. Sidesteps
// the "recorded tail diverges after the fix" problem that makes plain replay
// useless for confirming a change landed.
function cmdFork(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const total = rec.frames.length;
  const forkAt = Math.min(Number(o.frame ?? total), total);
  const window = Number(o.frames ?? 24);
  const pre = Math.max(0, forkAt - 3);
  const post = Math.min(total, forkAt + window);
  const outPrefix = o.out ?? `${file.replace(/\.json$/, "")}.fork`;

  console.log(`[fork] ${file}${rec.git ? ` recorded@${rec.git}` : ""} — forkAt=f${forkAt} window=${window}`);
  for (let i = 0; i < post; i++) {
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
    const n = i + 1;
    if (n === forkAt) {
      writeFileSync(`${outPrefix}.before.svg`, renderFrameSVG(level));
    }
    if (n >= pre) {
      const mark = n === forkAt ? " ◀ fork" : "";
      console.log(`  f${String(n).padStart(4)} ${forkStateLine(level)}${mark}`);
    }
  }
  writeFileSync(`${outPrefix}.after.svg`, renderFrameSVG(level));
  console.log(`  SVGs: ${outPrefix}.before.svg  ${outPrefix}.after.svg`);
  process.exit(0);
}

// Re-simulate a bundle and print the full sim view at a frame (or over a range),
// as a human table or as JSONL.
//
// This is the standing form of the most-rebuilt probe there is: "what is the
// ball's angular velocity at f314", "how deep is it in that polygon at f1474",
// "what is the chain's length made of at f455" were each answered by editing
// `cli.ts` or writing a scratch script, once per session, and thrown away every
// time. `--json` is the contract - stable keys, metres and rad/s - so a question
// that needs arithmetic is a `jq` away rather than a code change.
function cmdQuery(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const total = rec.frames.length;
  const single = o.frame !== undefined;
  const from = single ? Number(o.frame) : Number(o.from ?? 1);
  const to = single ? Number(o.frame) : Number(o.to ?? total);
  const every = Number(o.every ?? 1);
  const bodyFilter = o.body === undefined ? null : Number(o.body);
  const json = o.json !== undefined;
  const last = Math.min(to, total);
  if (!json) console.log(`[query] ${file} — level=${rec.level} frames=${total} (current physics)`);

  for (let i = 0; i < last; i++) {
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
    const n = i + 1;
    if (n < from || (n - from) % every !== 0) continue;
    const view = frameView(level);
    const bodies = bodyFilter === null ? view.bodies : view.bodies.filter((b) => b.id === bodyFilter);
    if (json) {
      console.log(JSON.stringify({ ...view, bodies }));
      continue;
    }
    printFrameView(view, bodies);
  }
  process.exit(0);
}

// The human form of a FrameView. Deliberately a separate rendering from the JSON
// rather than a formatted-string field inside it: a number that has been through
// `toFixed` is a number a script cannot use.
function printFrameView(view: FrameView, bodies: BodyView[]): void {
  const a = view.avatar;
  console.log(
    `  f${String(view.frame).padStart(4)} avatar pos=(${a.px.toFixed(3)},${a.py.toFixed(3)}) ` +
      `vel=(${a.vx.toFixed(3)},${a.vy.toFixed(3)}) |v|=${a.speed.toFixed(3)} ` +
      `rot=${a.rot.toFixed(3)} w=${a.w.toFixed(3)} ${a.state}` +
      (a.supportBody ? ` on=${a.supportBody}` : ""),
  );
  const c = view.chain;
  if (c) {
    console.log(
      `        chain nodes=${c.nodes.length} len=${c.currentLength.toFixed(4)} ` +
        `max=${c.maxRopeLength.toFixed(4)} constraint=${c.constraintLength.toFixed(4)} ` +
        `slack=${c.blockedSlack.toFixed(4)} stalled=${c.stalledLength.toFixed(4)} ` +
        `stallRun=${c.stallRun} ${c.anchored ? "anchored" : "deploying"}`,
    );
    for (const n of c.nodes) {
      console.log(
        `          node ${n.span.padEnd(10)} (${n.px.toFixed(3)},${n.py.toFixed(3)}) ` +
          `on ${n.bodyName}#${n.body}[${n.shapeIndex}]`,
      );
    }
  }
  for (const b of bodies) {
    const kinds = b.shapes.map((s) => s.kind).join("+");
    const embed = b.embed ? ` embed=${(b.embed.depth * 1000).toFixed(2)}mm in ${b.embed.intoName}` : "";
    const stick = b.stickAnchor
      ? ` stick=(${b.stickAnchor.x.toFixed(3)},${b.stickAnchor.y.toFixed(3)})`
      : b.ungrippedFrames > 0
        ? ` ungripped=${b.ungrippedFrames}f`
        : "";
    console.log(
      `        body#${String(b.id).padStart(3)} ${(b.name || b.type).padEnd(14)} ${kinds.padEnd(8)} ` +
        `pos=(${b.px.toFixed(3)},${b.py.toFixed(3)}) rot=${b.rot.toFixed(3)} ` +
        `vel=(${b.vx.toFixed(3)},${b.vy.toFixed(3)}) w=${b.w.toFixed(3)}${embed}${stick}`,
    );
  }
}

// Per-phase velocity attribution across a frame window: which phase of the frame
// gave this body this velocity (see engine/phaseTrace.ts).
//
// The chain phase is the part no other tool shows and the part every rope bug
// has needed: push-out, rope solve, spin rollback, unwind, the derived-velocity
// write and the stall lease are separate columns here, so "the contact solve
// re-earns 1.2 m/s sideways every frame and the chain solve removes it" is a
// thing you read rather than a thing you instrument for.
async function cmdTrace(file: string, o: Record<string, string>): Promise<void> {
  // Imported here rather than at the top of the file on purpose: `cli compare`
  // copies this tooling into a worktree of an OLD revision, whose engine has
  // never heard of `phaseTrace`, and a static import would break every command
  // in the file there - including the one compare actually runs.
  const { PhaseTrace } = await import("../engine/phaseTrace");
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const total = rec.frames.length;
  const from = Number(o.from ?? 1);
  const to = Math.min(Number(o.to ?? total), total);
  const watch = o.body === undefined ? null : new Set(o.body.split(",").map(Number));

  PhaseTrace.reset();
  PhaseTrace.watch = watch;
  console.log(
    `[trace] ${file} — level=${rec.level} f${from}..${to}` +
      (watch ? ` body=${[...watch].join(",")}` : " (all bodies)"),
  );
  for (let i = 0; i < to; i++) {
    // Tracing only over the window keeps the record list to the frames asked
    // for; the frames before it still have to be simulated to get there.
    PhaseTrace.enabled = i + 1 >= from;
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
  }
  PhaseTrace.enabled = false;

  if (o.out) {
    writeFileSync(o.out, PhaseTrace.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`  ${PhaseTrace.records.length} records → ${o.out}`);
  }

  let frame = -1;
  for (const r of PhaseTrace.records) {
    if (r.f !== frame) {
      frame = r.f;
      console.log(`  f${String(frame).padStart(4)}`);
    }
    if (r.t === "phase") {
      // Position in MILLIMETRES, and only when the phase actually moved the
      // body: a positional-only phase (depenetration, the grip pin, the rope's
      // correction) is the one every drift bug turns out to be, and at metre
      // precision its 0.6 mm reads as 0.0006 and disappears into the line.
      const moved = r.dx !== 0 || r.dy !== 0 || r.drot !== 0;
      const pos = moved
        ? `  Δp=(${(r.dx * 1000).toFixed(3).padStart(8)},${(r.dy * 1000).toFixed(3).padStart(8)})mm` +
          ` Δrot=${r.drot.toFixed(5).padStart(8)}`
        : "";
      console.log(
        `    ${r.phase.padEnd(20)} body#${String(r.body).padStart(2)} ${r.name.padEnd(12)} ` +
          `Δv=(${r.dvx.toFixed(4).padStart(9)},${r.dvy.toFixed(4).padStart(9)}) ` +
          `Δw=${r.dw.toFixed(4).padStart(9)}  → v=(${r.vx.toFixed(3)},${r.vy.toFixed(3)}) w=${r.w.toFixed(3)}` +
          pos,
      );
    } else {
      console.log(
        `    ${"contact".padEnd(20)} ${r.aName}#${r.a} vs ${r.bName}#${r.b} ` +
          `Pn=${r.pn.toFixed(5)} Pt=${r.pt.toFixed(5)}${r.slipping ? " (slipping)" : ""} ` +
          `n=(${r.nx.toFixed(2)},${r.ny.toFixed(2)}) at (${r.px.toFixed(3)},${r.py.toFixed(3)})`,
      );
    }
  }
  process.exit(0);
}

// Run a playtest script and write a real bundle: level snapshot, input frames,
// digests, full-world digests and the revision it was recorded at.
//
// Both argument orders work — `cli record script.json` and the longhand
// `cli record <level> script.json`, where the level overrides whatever the
// script names.
function cmdRecord(first: string, o: Record<string, string>, extra: string[]): void {
  const positional = positionals(extra);
  const scriptFile = positional[0] ?? first;
  const levelOverride = positional[0] ? first : o.level;
  const script = JSON.parse(readFileSync(scriptFile, "utf8")) as PlaytestScript;
  if (levelOverride) script.level = levelOverride;
  const { recording, result } = recordScript(script, treeIdentity());
  const out = o.out ?? `${scriptFile.replace(/\.json$/, "")}.bundle.json`;
  writeFileSync(out, JSON.stringify(recording));
  console.log(
    `[record] ${scriptFile} — level=${recording.level} frames=${result.framesRun} → ${out}`,
  );
  for (const a of result.assertResults) console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.description}`);
  printViolations(result.violations);
  console.log(result.passed ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(result.passed ? 0 : 1);
}

// ---- render diff ------------------------------------------------------------
// `cli shot` is the one view that draws what the PLAYER sees: `cli render` draws
// its own SVG picture of the sim state, which is exactly why it cannot see a bug
// in the drawing. The chain wound onto the ball drew as blank space for want of
// one `floor`, and every CLI tool called that run perfectly healthy, because it
// was (session-1467f).
//
// This does not make perceptual quality assertable — nothing here judges whether
// a settle looks convincing. It makes perceptual CLAIMS cheap to evidence: one
// command for a frame grab, one for a before/after pixel diff, one for a
// filmstrip and the motion profile that goes with it.
//
// The grab itself is driven over CDP (see shotRunner.ts), which is what makes it
// wait for the page rather than for a guessed time budget and what brings the
// page's own console back with the picture.
const SHOT_PORT = 3179;

async function cmdShot(first: string, o: Record<string, string>, extra: string[]): Promise<void> {
  if (o.diff !== undefined) {
    // `--diff a.png b.png` puts the first image in the flag's value slot and the
    // second in a positional, so the pair is read off the raw arguments: the two
    // images named anywhere except as `--out`'s value.
    const [a, b] = extra.filter((x, i) => x.endsWith(".png") && extra[i - 1] !== "--out");
    if (!a || !b) fail("usage: cli shot --diff a.png b.png [--out diff.png]");
    const out = o.out ?? "shot-diff.png";
    // ImageMagick's `compare` already answers both halves of the question: the
    // absolute count of differing pixels, and an image with them highlighted.
    // Reimplementing that over a hand-rolled PNG decoder would be a worse
    // version of a tool the debugging loop already assumes is installed.
    const r = spawnSync("magick", ["compare", "-metric", "AE", a, b, out], { encoding: "utf8" });
    // `compare` exits 1 when the images differ, which is not an error here.
    if (r.status !== 0 && r.status !== 1) fail(`magick compare failed: ${r.stderr.trim()}`, 1);
    // ImageMagick 7 reports AE as `5.87698e+09 (89677)`: the first number is
    // scaled by the quantum range and the parenthesised one is the pixel count,
    // which is the only form of it anybody wants. Version 6 prints the count
    // alone, so both are read.
    const raw = (r.stderr || "0").trim();
    const changed = Number(/\(([\d.eE+-]+)\)/.exec(raw)?.[1] ?? raw.split(/\s+/)[0]);
    console.log(`[shot] ${a} vs ${b}: ${changed} pixel(s) differ → ${out}`);
    process.exit(0);
  }

  const bundle = resolve(first);
  // `--frames A..B [--every K]` is the motion form: one page load, one chromium
  // session, a filmstrip of tiles and a changed-pixel count between adjacent
  // ones. A single frame cannot show flashing, flicker or the speed something
  // flows at, and until this existed the user was the only detector for both.
  const range = /^(\d+)\.\.(\d+)$/.exec(o.frames ?? "");
  if (o.frames !== undefined && !range) fail("usage: cli shot <bundle> --frames A..B [--every K]");
  const frame = Number(o.frame ?? 1);
  const label = range ? `f${range[1]}-${range[2]}` : `f${frame}`;
  const out = resolve(o.out ?? `${first.replace(/\.json(\.gz)?$/, "")}.${label}.png`);
  const zoom = o.zoom;
  const port = Number(o.port ?? SHOT_PORT);
  const chromium = findChromium();
  if (!chromium) fail("no headless chromium found (chromium-browser | chromium | google-chrome)", 1);

  // The page fetches its bundle over HTTP, so the bundle has to be inside the
  // served tree — and a `.json.gz` from the committed corpus has to be unpacked
  // first, since the browser would have no reason to gunzip a file it was simply
  // handed. Written next to the corpus and removed afterwards.
  const served = join(ROPE_DIR, "playtests", "_shot.json");
  writeFileSync(served, JSON.stringify(loadRecording(bundle)));
  // Its OWN process group, so the kill below takes the whole tree. `bunx vite`
  // is a wrapper around the real server, and killing the wrapper alone leaves
  // the server holding the port - after which the next `cli shot` fails to bind
  // (`--strictPort`), finds the OLD server answering, and screenshots the code
  // as it was BEFORE the change being checked. Three grabs of an edited water
  // material came back pixel-identical that way, which is the most misleading
  // possible answer to "did that look any different".
  const vite = spawn("bunx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROPE_DIR,
    stdio: "ignore",
    detached: true,
  });
  let failure: string | null = null;
  try {
    waitForServer(port);
    const url =
      `http://127.0.0.1:${port}/shot.html?bundle=/playtests/_shot.json` +
      (range ? `&frames=${range[1]}..${range[2]}&every=${o.every ?? 1}` : `&frame=${frame}`) +
      (zoom ? `&zoom=${zoom}` : "") +
      // `--3d` grabs the frame through the WebGL renderer instead of the 2D one.
      // Headless chromium has no GPU, so it needs SwiftShader spelled out; the
      // grab is otherwise identical and the two can be diffed against each other.
      (o["3d"] ? "&render=3d" : "");
    let log: PageLogEntry[] = [];
    try {
      const result = await grab(chromium, {
        url,
        out,
        gpu: o["3d"] !== undefined,
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        // The 30s discipline: a page that is not ready by then is hung, and a
        // hung page has to kill the run with its partial log rather than stall.
        // It is also the ONLY ceiling: the grab no longer runs the page on
        // virtual time, which on chromium 142 hangs every JPEG and WebP decode
        // (see `grabWith`).
        timeoutMs: Number(o.timeout ?? 30000),
      });
      log = result.log;
      console.log(`[shot] ${first} @${label} → ${out} (${result.elapsedMs}ms)`);
    } catch (e) {
      if (e instanceof PageNotReady) {
        log = e.log;
        failure = e.message;
      } else {
        throw e;
      }
    }
    // The page's console, printed whatever happened. A headless screenshot
    // without it is not evidence: a shader that fails to compile draws nothing
    // and says so only here.
    printPageLog(log);
    // A failure is REPORTED past the `finally` below rather than here, because
    // `fail` exits the process: raised inside the block it skips the teardown,
    // and what is left behind is a detached dev server holding the port - which
    // the next grab then screenshots instead of the code being checked.
    //
    // A screenshot taken over a page error is the most misleading possible
    // answer to "does this look right", so it is a failure by default.
    const errors = log.filter((e) => e.level === "error");
    if (failure === null && errors.length > 0 && o["allow-errors"] === undefined) {
      failure = `${errors.length} page error(s); the PNG carries the banner (pass --allow-errors to ignore)`;
    }
  } finally {
    // Negative pid: the group, not just the wrapper (see the spawn above).
    try {
      process.kill(-vite.pid!, "SIGTERM");
    } catch {
      vite.kill("SIGTERM");
    }
    rmSync(served, { force: true });
  }
  if (failure) fail(failure, 1);
  process.exit(0);
}

// Everything the page said, in the order it said it. The `motion` line a
// filmstrip emits is data rather than a message, so it is printed as the
// per-pair profile it is: a flashing artifact is a spike pattern in that series
// and a steady flow is a flat one. Nothing gates on it - this is `--diff` for
// motion, making the claim cheap to evidence rather than assertable.
function printPageLog(log: PageLogEntry[]): void {
  for (const entry of log) {
    const motion = /^motion (\{.*\})$/.exec(entry.text);
    if (motion) {
      printMotion(motion[1]!);
      continue;
    }
    for (const line of entry.text.split("\n")) console.log(`[page] ${entry.level}: ${line}`);
  }
}

function printMotion(json: string): void {
  const m = JSON.parse(json) as {
    frames: number[];
    tile: { width: number; height: number };
    changed: number[];
  };
  console.log(`[shot] motion profile (${m.tile.width}x${m.tile.height} tiles):`);
  m.changed.forEach((n, i) => {
    console.log(`  f${m.frames[i]}->f${m.frames[i + 1]}: ${n} px changed`);
  });
  if (m.changed.length === 0) return;
  const sorted = [...m.changed].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(`  min ${sorted[0]} · median ${median} · max ${sorted[sorted.length - 1]}`);
}

// Block until the dev server answers, or give up loudly: a screenshot taken
// against a server that was not up yet is a blank page, and a blank page is the
// most misleading possible answer to "what does this frame look like".
function waitForServer(port: number, timeoutMs = 30000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync("curl", ["-sf", "-o", "/dev/null", `http://127.0.0.1:${port}/shot.html`]);
    if (r.status === 0) return;
    spawnSync("sleep", ["0.25"]);
  }
  fail(`dev server did not come up on port ${port} within ${timeoutMs}ms`, 1);
}

// ---- A/B against another revision ------------------------------------------
// `cli compare bundle.json --frame N --ref <rev>` replaces scripts/abtest.sh.
//
// The idea is unchanged and is what makes an A/B meaningful at all: the sim is
// deterministic and a fix only bites at the issue frame, so replaying a bundle
// to a fork frame under two revisions reproduces the SAME pre-issue state, and
// the diff past that frame is exactly the change's effect. What is new is that
// it cannot quietly compare a tree against itself. The shell version did that
// twice in one day - an empty `git stash` compared HEAD with HEAD, and a wrong
// cwd ran the same variant twice - and both times reported "no difference",
// which reads as "the change is safe".
//
// So: both sides' tree identity is always printed, identical trees are named as
// such rather than reported as an empty diff, every path is resolved from the
// repo root, and a worktree that fails to run is an error rather than a silent
// fall-through.

// Where this file lives, resolved to the rope directory and the repo root, so no
// command here depends on the cwd it was launched from.
const ROPE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function git(args: string[], cwd = ROPE_DIR): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// A tree's identity: the commit, plus a hash of the uncommitted diff when there
// is one. Two runs that print the same identity ran the same code, which is the
// claim a "no difference" result depends on and never used to make.
function treeIdentity(): string {
  const head = git(["rev-parse", "--short", "HEAD"]);
  const diff = spawnSync("git", ["diff", "HEAD"], { cwd: ROPE_DIR, encoding: "utf8" }).stdout ?? "";
  if (diff.trim() === "") return `${head} (clean)`;
  return `${head}+${createHash("sha1").update(diff).digest("hex").slice(0, 8)} (dirty)`;
}

function cmdCompare(file: string, o: Record<string, string>): void {
  if (!o.ref) fail("cli compare requires --ref <rev>");
  const bundle = resolve(file);
  const forkFrame = Number(o.frame ?? 0);
  if (!forkFrame) fail("cli compare requires --frame N (the frame just before the issue)");
  const window = Number(o.frames ?? 24);
  const repo = git(["rev-parse", "--show-toplevel"]);
  const ropeRel = relative(repo, ROPE_DIR);
  const refCommit = git(["rev-parse", "--short", o.ref]);
  const here = treeIdentity();
  const outDir = mkdtempSync(join(tmpdir(), "rope-compare-"));
  const worktree = mkdtempSync(join(tmpdir(), "rope-worktree-"));

  console.log(`[compare] ${file} @f${forkFrame} +${window} frames`);
  console.log(`  new: working tree ${here}`);
  console.log(`  old: ${o.ref} → ${refCommit}`);
  if (here === `${refCommit} (clean)`) {
    // The failure mode this command exists to make impossible: two runs of the
    // same code reporting no difference and being read as a verified fix.
    console.log("  IDENTICAL TREES — nothing to compare (this is not a result about your change)");
    process.exit(2);
  }

  const emit = (dir: string, prefix: string): void => {
    const r = spawnSync(
      "bun",
      [
        "run",
        join("src", "tools", "cli.ts"),
        "compare-emit",
        bundle,
        "--frame",
        String(forkFrame),
        "--frames",
        String(window),
        "--out",
        prefix,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    // An old worktree that cannot run is an error, not an empty diff. The usual
    // cause is a tooling change that reaches past the stable physics interfaces
    // (physicsProcess, body/rope fields) into something the old revision spells
    // differently, and the honest answer then is to say so.
    if (r.status !== 0) {
      console.error(r.stdout);
      console.error(r.stderr);
      fail(`compare-emit failed in ${dir} (exit ${r.status})`, 1);
    }
  };

  try {
    emit(ROPE_DIR, join(outDir, "new"));
    git(["worktree", "add", "--quiet", "--detach", worktree, refCommit], repo);
    const wtRope = join(worktree, ropeRel);
    // Old physics, new tooling — the same trick the shell version used, and the
    // same caveat: it holds only while the tooling touches stable physics
    // interfaces. `compare-emit` is written to that rule (see sim/compare.ts,
    // which derives its own body ids rather than reading a field the old engine
    // has never heard of).
    rmSync(join(wtRope, "src", "tools"), { recursive: true, force: true });
    rmSync(join(wtRope, "src", "sim"), { recursive: true, force: true });
    cpSync(join(ROPE_DIR, "src", "tools"), join(wtRope, "src", "tools"), { recursive: true });
    cpSync(join(ROPE_DIR, "src", "sim"), join(wtRope, "src", "sim"), { recursive: true });
    if (!existsSync(join(wtRope, "node_modules"))) {
      symlinkSync(join(ROPE_DIR, "node_modules"), join(wtRope, "node_modules"));
    }
    emit(wtRope, join(outDir, "old"));

    const oldSide = readCompareFrames(join(outDir, "old.jsonl"));
    const newSide = readCompareFrames(join(outDir, "new.jsonl"));
    const diff = diffCompareFrames(oldSide, newSide);
    if (o.json !== undefined) {
      console.log(JSON.stringify({ new: here, old: refCommit, forkFrame, window, diff }));
    } else {
      // The method rests on both sides reproducing the SAME pre-issue state, so
      // a fork frame the two already disagree at makes the diff a comparison of
      // two different histories rather than of the change. Say so: an unmarked
      // table here reads as the change's effect and is not.
      if (diff.firstDivergentFrame === forkFrame) {
        console.log(
          `  WARNING: the two runs already differ AT the fork frame — the divergence started ` +
            `earlier, so this diff is not the change's effect. Walk --frame back until the ` +
            `first compared frame matches.`,
        );
      }
      console.log(
        `  compared ${diff.frames} frames; ` +
          (diff.firstDivergentFrame === null
            ? `no divergence past ${(diff.maxDrift * 1000).toFixed(2)}mm`
            : `first divergence @f${diff.firstDivergentFrame} on ${diff.firstDivergentBody} ` +
              `(maxDrift=${(diff.maxDrift * 100).toFixed(2)}px)`),
      );
      console.log(`    body                   drift(mm)    Δ|v|(m/s)      Δw(rad/s)`);
      for (const b of diff.bodies) {
        console.log(
          `    body#${String(b.id).padStart(2)} ${b.type.padEnd(14)} ` +
            `${(b.drift * 1000).toFixed(2).padStart(10)} ${b.dv.toFixed(4).padStart(12)} ` +
            `${b.dw.toFixed(4).padStart(14)}`,
        );
      }
      if (diff.chainLengthDelta !== null) {
        console.log(`    chain length: ${(diff.chainLengthDelta * 100).toFixed(2)}cm (new − old)`);
      }
      console.log(`  SVGs: ${outDir}/old.{before,after}.svg  ${outDir}/new.{before,after}.svg`);
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
  }
  process.exit(0);
}

function readCompareFrames(file: string): CompareFrame[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CompareFrame);
}

// The half of `cli compare` that runs inside each side's tree: replay to the
// fork frame, continue on the recorded inputs, and write one JSON object per
// frame plus the two SVGs. Never called by hand.
function cmdCompareEmit(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const forkAt = Math.min(Number(o.frame), rec.frames.length);
  const window = Number(o.frames ?? 24);
  const prefix = o.out ?? "compare";
  const lines: string[] = [];
  const end = Math.min(rec.frames.length, forkAt + window);
  for (let i = 0; i < end; i++) {
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
    const n = i + 1;
    if (n === forkAt) writeFileSync(`${prefix}.before.svg`, renderFrameSVG(level));
    if (n >= forkAt) lines.push(JSON.stringify(compareFrame(level)));
  }
  writeFileSync(`${prefix}.after.svg`, renderFrameSVG(level));
  writeFileSync(`${prefix}.jsonl`, lines.join("\n") + "\n");
  process.exit(0);
}

// Continue a bundle from a frame with ZERO input and watch the scene come to
// rest — the standing form of the `_bcont.ts`/`_rest.ts` throwaway.
//
// A scene left alone must settle and then stay settled, and the two failures
// this catches are opposite: energy appearing (the 68 m/s runaway that started
// this line of work) and a body that reports itself at rest while creeping
// across the level (the friction motor, the ratchet). Both are invisible to a
// plain replay, which stops the moment the recorded inputs run out.
function cmdSettle(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const total = rec.frames.length;
  const from = Math.min(Number(o.from ?? total), total);
  const frames = Number(o.frames ?? 600);
  const every = Number(o.every ?? 60);
  for (let i = 0; i < from; i++) level.physicsProcess(de(rec.frames[i]!), 1 / 60);

  const world = level.world;
  const start = new Map<number, Vec2>();
  for (const b of world.bodies) if (!b.removed) start.set(b.buildIndex, b.globalPosition);

  // Zero input, fed through the deserializer so pressed/released edges are
  // correct relative to the recording: releasing a held deploy is a real event
  // and must happen exactly once, on the first continued frame.
  console.log(`[settle] ${file} — from f${from}, ${frames} frames of zero input`);
  console.log(`    frame   KE(J)      max|v|    max|w|`);
  let peakAfterSettled = 0;
  const violations: Violation[] = [];
  for (let i = 0; i < frames; i++) {
    // Aim at the avatar itself, which is what "not aiming" is encoded as; aiming
    // at the world origin would steer the ball for the whole window.
    const at =
      level instanceof BallLevel ? level.ball.globalPosition : (level as Level).player.globalPosition;
    const input = de({ h: 0, mx: at.x, my: at.y });
    level.physicsProcess(input, 1 / 60);
    if (level instanceof BallLevel) violations.push(...checkBallInvariants(level));
    else violations.push(...checkInvariants(level));
    const ke = kineticEnergy(world);
    let maxV = 0;
    let maxW = 0;
    for (const b of world.bodies) {
      if (b.removed || !(b instanceof RigidBody2D)) continue;
      maxV = Math.max(maxV, b.linearVelocity.length());
      maxW = Math.max(maxW, Math.abs(b.angularVelocity));
    }
    // Once past the settling half of the window, nothing may pick up energy
    // again: that is the "and stays there" half of the assertion. Judged on
    // kinetic energy rather than on the fastest body, because the fastest body
    // is often the chain tip - a quarter-kilo hook, whose 2 cm/s is 5e-5 J and is
    // the documented at-rest floor rather than motion.
    if (i > frames / 2) peakAfterSettled = Math.max(peakAfterSettled, ke);
    if (i % every === 0 || i === frames - 1) {
      console.log(
        `  f${String(level.frame).padStart(6)}  ${ke.toExponential(2)}  ` +
          `${maxV.toFixed(5)}  ${maxW.toFixed(5)}`,
      );
    }
  }

  let worstDrift = 0;
  let worstName = "";
  for (const b of world.bodies) {
    if (b.removed) continue;
    const was = start.get(b.buildIndex);
    if (!was) continue;
    const drift = b.globalPosition.distanceTo(was);
    if (drift > worstDrift) {
      worstDrift = drift;
      worstName = `body#${b.buildIndex} ${b.name || b.constructor.name}`;
    }
  }
  console.log(`  net drift: ${(worstDrift * 1000).toFixed(1)}mm (${worstName || "nothing moved"})`);
  console.log(`  peak KE over the second half: ${peakAfterSettled.toExponential(2)} J`);
  printViolations(violations);
  const settled = peakAfterSettled < SETTLE_KE_TOLERANCE && violations.length === 0;
  console.log(settled ? "RESULT: SETTLED" : "RESULT: NOT SETTLED");
  process.exit(settled ? 0 : 1);
}

// What "at rest" means for `cli settle`, in joules of the whole scene.
//
// A settled scene reads 1e-5 J and less across the corpus (`255f` reads 1e-14,
// which is float noise and nothing else) now that a resting contact no longer
// bounces - it read 1.2e-2 J while the ball was throwing itself 21 mm/s off the
// floor every frame with nothing moving. The bar is 1 J because `120f` carries a
// one-frame 0.97 J blip as a contact set changes under a 300 kg slab, and that is
// a scene rearranging rather than a scene moving. It stays far under anything
// that IS moving: the 2.4 mm/frame friction motor (session-611f) ran the ball at
// 0.14 m/s, which is ~70 J at this mass.
//
// It is a number of joules, so it tracks the scene's mass and had to be rescaled
// when masses became physical (it was 1e-5 when the ball weighed a third of a
// gram). Anything written in units that carry a mass has that property - see
// **Mass and materials** in CLAUDE.md.
const SETTLE_KE_TOLERANCE = 1;

// Anomaly sweep — step 2.5 of the debugging loop: run this before choosing what
// to inspect. `--all` sweeps the whole corpus and prints only what is notable,
// which is how a regression in a bundle nobody is currently looking at gets
// found (see sim/scan.ts for what it measures and why those five things).
function cmdScan(fileOrAll: string, o: Record<string, string>): void {
  const topK = Number(o.top ?? 5);
  if (fileOrAll === "--all") {
    let flagged = 0;
    for (const dir of BUNDLE_DIRS) {
      let files: string[];
      try {
        files = readdirSync(dir).filter(isBundleFile).sort();
      } catch {
        continue;
      }
      for (const f of files) {
        const scan = scanRecording(loadRecording(join(dir, f)), topK);
        const notes = notable(scan);
        if (notes.length === 0) {
          console.log(`  ok    ${f}`);
          continue;
        }
        flagged++;
        console.log(`  FLAG  ${f}`);
        for (const n of notes) console.log(`          ${n}`);
      }
    }
    console.log(`[scan] ${flagged} bundle(s) with something worth looking at`);
    process.exit(0);
  }

  const rec = loadRecording(fileOrAll);
  const scan = scanRecording(rec, topK);
  if (o.json !== undefined) {
    console.log(JSON.stringify(scan));
    process.exit(0);
  }
  console.log(`[scan] ${fileOrAll} — level=${scan.level} frames=${scan.frames} (current physics)`);
  for (const b of scan.bodies) {
    console.log(`  body#${b.id} ${b.name} (${b.type})`);
    console.log(
      `    Δv spikes: ` +
        (b.dvSpikes.map((s) => `${s.magnitude.toFixed(3)}@f${s.frame}`).join("  ") || "none"),
    );
    console.log(
      `    Δw spikes: ` +
        (b.dwSpikes.map((s) => `${s.magnitude.toFixed(3)}@f${s.frame}`).join("  ") || "none"),
    );
    console.log(
      `    embed: ${(b.maxEmbed * 1000).toFixed(1)}mm` +
        (b.maxEmbed > 0 ? ` in ${b.maxEmbedInto} @f${b.maxEmbedFrame}` : ""),
    );
    console.log(
      `    settled drift: ${(b.settledDrift * 1000).toFixed(2)}mm` +
        (b.settledFrames > 0 ? ` over ${b.settledFrames}f from f${b.settledDriftFrame}` : "") +
        `   contact flicker: ${(b.contactFlicker * 100).toFixed(0)}% of ${b.restingFrames} resting frames`,
    );
  }
  if (scan.chain) {
    console.log(
      `  chain: longest stall run ${scan.chain.longestStallRun}f @f${scan.chain.longestStallRunFrame}, ` +
        `lease high-water ${(scan.chain.maxBlockedSlack * 100).toFixed(1)}cm @f${scan.chain.maxBlockedSlackFrame}, ` +
        `max length ${(scan.chain.maxLength * 100).toFixed(1)}cm` +
        (scan.chain.anchorLength !== null
          ? ` (anchored at ${(scan.chain.anchorLength * 100).toFixed(1)}cm)`
          : ""),
    );
    console.log(
      `    solve gain spikes: ` +
        (scan.chain.solveGainSpikes
          .map((s) => `${s.magnitude.toFixed(2)}@f${s.frame}`)
          .join("  ") || "none"),
    );
  }
  const notes = notable(scan);
  console.log(notes.length === 0 ? "  nothing notable" : "  notable:");
  for (const n of notes) console.log(`    ${n}`);
  process.exit(0);
}

// Print the chain/rope wrap path (node polyline) per frame — the geometry the
// digest table omits. Node count > 2 means the chain has caught corners.
function cmdChainpath(file: string, o: Record<string, string>): void {
  const rec = loadRecording(file);
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const from = Number(o.from ?? 1);
  const to = Number(o.to ?? rec.frames.length);
  const every = Number(o.every ?? 1);
  console.log(`[chainpath] ${file} — ${rec.frames.length} frames (current physics, px)`);
  for (let i = 0; i < rec.frames.length; i++) {
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
    const n = i + 1;
    if (n < from || n > to || (n - from) % every !== 0) continue;
    const rope = level instanceof BallLevel ? level.ball.chain : (level as Level).player.rope;
    if (!rope) continue;
    const pts = rope
      .path()
      .map((nd) => {
        const p = nd.contact.globalPosition;
        return `(${(p.x * 100).toFixed(0)},${(p.y * 100).toFixed(0)})`;
      })
      .join(" ");
    console.log(`  f${String(n).padStart(4)} nodes=${rope.path().length} ${pts}`);
  }
  process.exit(0);
}

// Replay every bundle in a directory with current physics; invariants (incl.
// the stuck detector) must hold. Digest divergence is informational — bundles
// recorded before a physics fix legitimately diverge.
function cmdBundles(dirs: string[]): void {
  const found: { dir: string; file: string }[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(isBundleFile).sort();
    } catch {
      // A missing directory is only fatal if it was the only one asked for: the
      // committed corpus is always there, while `playtests/bundles/` is local
      // scratch a fresh clone does not have.
      if (dirs.length === 1) fail(`cannot read bundle dir: ${dir}`);
      continue;
    }
    for (const f of files) found.push({ dir, file: f });
  }
  if (found.length === 0) fail(`no bundles in ${dirs.join(", ")}`);
  let failed = 0;
  let diverged = 0;
  let worstDrift = 0;
  let worstDriftFile = "";
  for (const { dir, file } of found) {
    const rec = loadRecording(join(dir, file));
    const r = replayRecording(rec);
    const div = r.divergedAtFrame !== null ? ` (diverges @f${r.divergedAtFrame}, maxDrift=${(r.maxDrift * 100).toFixed(1)}px)` : "";
    const g = rec.git ? ` @${rec.git}` : "";
    if (r.divergedAtFrame !== null) diverged++;
    if (r.maxDrift > worstDrift) {
      worstDrift = r.maxDrift;
      worstDriftFile = file;
    }
    if (r.violations.length > 0) {
      failed++;
      console.log(`FAIL ${file}${g} — ${r.violations.length} violation(s)${div}`);
      printViolations(r.violations, 5);
    } else {
      console.log(`PASS ${file}${g} — ${r.framesRun} frames${div}`);
    }
  }
  // Divergence stays informational — a bundle recorded before a physics fix
  // legitimately diverges — but it is stated rather than left silent, so a run
  // where everything drifted cannot read the same as one where nothing did.
  console.log(
    `[bundles] ${found.length} bundles, ${diverged} diverged` +
      (worstDrift > 0 ? `, worst drift ${(worstDrift * 100).toFixed(1)}px (${worstDriftFile})` : ""),
  );
  console.log(failed === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failed}/${found.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

// Determinism + replay round-trip self-test: run a scripted session, replay its
// captured inputs+digests, and confirm bit-for-bit reproduction.
function cmdSelftest(): void {
  const script: PlaytestScript = {
    // The grapple arena, pinned rather than DEFAULT_LEVEL: this script holds
    // fire/retract/move/jump, which is the grapple controller's vocabulary. The
    // ball controller gets its own round trip below.
    level: "LEVEL_2",
    frames: 300,
    holds: [
      // Two loose circles, so the determinism check has rigid bodies in it at
      // all: without them the whole scene is the avatar and its hook, which is
      // precisely the blind spot full-world digests exist to close. They are
      // spawned at the mouse aim point, land on the arena and settle.
      { action: "spawn_large", from: 4, to: 5 },
      { action: "spawn_small", from: 12, to: 13 },
      { action: "fire", from: 40, to: 300 },
      { action: "retract", from: 80, to: 200 },
      { action: "move_right", from: 120, to: 220 },
      { action: "jump", from: 210, to: 214 },
    ],
    mouse: [{ from: 1, to: 300, x: 220, y: -220, relative: true }],
  };

  const a = runScript(script);
  const rec: Recording = {
    level: script.level,
    frames: a.serializedFrames,
    digests: a.digests,
    // The whole scene, not the avatar alone: determinism is a claim about the
    // simulation, and it was only ever checked on one body.
    worldDigests: a.worldDigests,
  };
  const b = replayRecording(rec);

  // Same-engine round-trip: demand bit-exact reproduction, not just low drift,
  // and demand it of every body and of the rope path, not only of the avatar.
  const ok =
    b.bitDivergedAtFrame === null && b.worldBitDivergedAtFrame === null && b.violations.length === 0;
  console.log(`[selftest] ran ${a.framesRun} frames, replayed ${b.framesRun}`);
  console.log(`  avatar diverged: ${b.bitDivergedAtFrame ?? "no"}  violations: ${b.violations.length}`);
  console.log(
    `  world  diverged: ${b.worldBitDivergedAtFrame ?? "no"}` +
      (b.worldBitDivergedAtFrame !== null && b.worldMaxDriftName
        ? ` (worst: ${b.worldMaxDriftName})`
        : "") +
      `  bodies: ${a.worldDigests[a.worldDigests.length - 1]?.bodies.length ?? 0}`,
  );
  if (b.violations[0]) console.log(`  first: f${b.violations[0].frame} ${b.violations[0].kind}`);

  // The ball controller, through the RECORDING path rather than through
  // `runScript` directly: a bundle written headlessly has to replay bit-for-bit,
  // or every scenario recorded that way is evidence about a run nobody can
  // reproduce. It also puts the chain, the coil and the ball's spin inside the
  // determinism check, none of which the grapple script above touches.
  const ballRun = recordScript(BALL_SELFTEST_SCRIPT);
  const c = replayRecording(ballRun.recording);
  const ballOk =
    c.bitDivergedAtFrame === null &&
    c.worldBitDivergedAtFrame === null &&
    c.violations.length === 0 &&
    ballRun.result.passed;
  console.log(`[selftest] ball: recorded ${ballRun.result.framesRun} frames, replayed ${c.framesRun}`);
  console.log(
    `  avatar diverged: ${c.bitDivergedAtFrame ?? "no"}  world diverged: ${c.worldBitDivergedAtFrame ?? "no"}` +
      `  violations: ${c.violations.length}`,
  );
  if (c.violations[0]) console.log(`  first: f${c.violations[0].frame} ${c.violations[0].kind}`);

  console.log(ok && ballOk ? "RESULT: DETERMINISTIC" : "RESULT: NON-DETERMINISTIC / UNHEALTHY");
  process.exit(ok && ballOk ? 0 : 1);
}

// A ball & chain session with everything the controller does in it: a deploy, an
// anchor, a wind-up on the aim steering, and the coil that comes with it. Held
// here rather than in `playtests/` because the selftest must not depend on a
// file that can be edited out from under it.
const BALL_SELFTEST_SCRIPT: PlaytestScript = {
  level: "SELFTEST_BALL",
  controller: "ball",
  frames: 240,
  spawn: { x: 0, y: 0 },
  data: {
    player: { x: 0, y: 0, radius: 8 },
    // A block 1.8 m above the ball (bottom face at -1.8 m, just inside the
    // chain's reach) and a floor to settle on.
    bodies: [
      { kind: "static", x: 0, y: -200, rot: 0, shape: { kind: "rect", w: 200, h: 40 } },
      { kind: "static", x: 0, y: 150, rot: 0, shape: { kind: "rect", w: 4000, h: 100 } },
    ],
  },
  holds: [{ action: "deploy", from: 5, to: 240 }],
  aim: [
    { from: 1, to: 10, x: 0, y: -1, relative: true },
    // A quarter turn every six frames, which is what winds the chain on.
    ...Array.from({ length: 20 }, (_, i) => ({
      from: 120 + i * 6,
      to: 125 + i * 6,
      x: Math.cos((i * Math.PI) / 4),
      y: Math.sin((i * Math.PI) / 4),
      relative: true,
    })),
  ],
};

switch (cmd) {
  case "play":
    if (!arg) fail("usage: cli play <script.json>");
    cmdPlay(arg);
    break;
  case "replay":
    if (!arg) fail("usage: cli replay <bundle.json>");
    cmdReplay(arg);
    break;
  case "dump":
    if (!arg) fail("usage: cli dump <bundle.json> [--from A] [--to B] [--every N]");
    cmdDump(arg, opts(rest));
    break;
  case "continue":
    if (!arg) fail("usage: cli continue <bundle.json> [--from N] [--hold a,b] [--aim X,Y] [--frames M] [--every K] [--trace out.jsonl]");
    cmdContinue(arg, opts(rest));
    break;
  case "render":
    if (!arg) fail("usage: cli render <bundle.json> [--frame N] [--out file.svg]");
    cmdRender(arg, opts(rest));
    break;
  case "query":
    if (!arg) fail("usage: cli query <bundle.json> [--frame N | --from A --to B] [--every K] [--body ID] [--json]");
    cmdQuery(arg, opts(rest));
    break;
  case "shot":
    if (!arg) fail("usage: cli shot <bundle.json> [--frame N | --frames A..B [--every K]] [--zoom Z] [--3d] [--out f.png] [--allow-errors]  |  cli shot --diff a.png b.png [--out d.png]");
    await cmdShot(arg, opts([arg, ...rest]), [arg, ...rest]);
    break;
  case "record":
    if (!arg) fail("usage: cli record [<level>] <script.json> [--out session.json]");
    cmdRecord(arg, opts(rest), rest);
    break;
  case "compare":
    if (!arg) fail("usage: cli compare <bundle.json> --frame N --ref <rev> [--frames M] [--json]");
    cmdCompare(arg, opts(rest));
    break;
  case "compare-emit":
    if (!arg) fail("usage: cli compare-emit <bundle.json> --frame N [--frames M] --out PREFIX");
    cmdCompareEmit(arg, opts(rest));
    break;
  case "settle":
    if (!arg) fail("usage: cli settle <bundle.json> [--from N] [--frames M] [--every K]");
    cmdSettle(arg, opts(rest));
    break;
  case "scan":
    if (!arg) fail("usage: cli scan <bundle.json|--all> [--top K] [--json]");
    cmdScan(arg, opts(rest));
    break;
  case "trace":
    if (!arg) fail("usage: cli trace <bundle.json> [--from A] [--to B] [--body ID[,ID]] [--out t.jsonl]");
    void cmdTrace(arg, opts(rest));
    break;
  case "chainpath":
    if (!arg) fail("usage: cli chainpath <bundle.json> [--from A] [--to B] [--every N]");
    cmdChainpath(arg, opts(rest));
    break;
  case "fork":
    if (!arg) fail("usage: cli fork <bundle.json> --frame N [--frames M] [--out prefix]");
    cmdFork(arg, opts(rest));
    break;
  case "bundles":
    // Both corpora by default: the committed regressions (which a fresh clone
    // has) and the local scratch dir (which it does not).
    cmdBundles(arg ? [arg, ...rest.filter((r) => !r.startsWith("--"))] : BUNDLE_DIRS);
    break;
  case "selftest":
    cmdSelftest();
    break;
  case "ledges":
    void cmdLedges();
    break;
  case "corners":
    void cmdCorners();
    break;
  case "decompose":
    void cmdDecompose();
    break;
  case "tangents":
    void cmdTangents();
    break;
  case "contacts":
    void cmdContacts();
    break;
  case "render3d":
    void cmdRender3d();
    break;
  case "assets":
    void cmdAssets();
    break;
  default:
    fail(
      "usage: cli <play|record|replay|dump|query|scan|trace|settle|compare|continue|render|shot|chainpath|fork|bundles|selftest|ledges|corners|tangents|decompose|contacts|render3d|assets> [file] [options]",
    );
}

// 3D rendering cases (src/sim/render3dCases.ts): the camera correspondence
// between the WebGL scene and the 2D overlay stacked on it, the extrusion's
// winding and depth, and the level format's `visual` round trip. All pure - no
// GPU, no canvas, no level - which is what lets the claim the whole 3D renderer
// stands on be a number in the suite rather than a screenshot someone looked at.
async function cmdRender3d(): Promise<void> {
  const { runRender3dCases } = await import("../sim/render3dCases");
  const results = runRender3dCases();
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.pass || process.env.VERBOSE) console.log(`        ${r.detail}`);
    if (!r.pass) failed++;
  }
  console.log(`[render3d] ${results.length - failed}/${results.length} cases passed`);
  process.exit(failed > 0 ? 1 : 0);
}

// The prop directory's byte budget and provenance (src/tools/assetBudget.ts).
// Kept out of `render3d`, which is deliberately pure - no GPU, no canvas, no
// level, and no filesystem either. This one is entirely about what is on disk.
async function cmdAssets(): Promise<void> {
  const { runAssetChecks } = await import("./assetBudget");
  const results = runAssetChecks();
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.pass || process.env.VERBOSE) console.log(`        ${r.detail}`);
    if (!r.pass) failed++;
  }
  console.log(`[assets] ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Rigid-body contact cases (src/sim/contactCases.ts). Pure physics — a world,
// some geometry and a fixed number of steps — so they need no level, no input
// trace and no bundle, and a regression reads as a number rather than as a rope
// in a wall four hundred frames into a recording.
async function cmdContacts(): Promise<void> {
  // Dynamic for the same reason as `cli trace`: the case suite reaches into
  // engine internals (`ContactAudit`) that an old revision does not have, and
  // `cli compare` runs this very file inside a worktree of one.
  const { runContactCases } = await import("../sim/contactCases");
  const results = runContactCases();
  let failed = 0;
  let xfail = 0;
  for (const r of results) {
    // An expected failure is a pass for the exit code, and an expected PASS is a
    // failure: a case that has started working while still marked is a stale
    // marker, which is a lie about what the suite covers.
    const stale = r.passed && r.expectedFail;
    const bad = stale || (!r.passed && !r.expectedFail);
    const tag = stale ? "STALE" : r.expectedFail ? "XFAIL" : r.passed ? "PASS " : "FAIL ";
    console.log(`  ${tag} ${r.name}`);
    for (const d of r.details) console.log(`        ${d}`);
    if (stale) {
      console.log(`        this case is marked expectedFail but PASSED — delete the marker`);
    }
    if (bad) failed++;
    if (r.expectedFail && !r.passed) xfail++;
  }
  const x = xfail > 0 ? ` (${xfail} expected-fail)` : "";
  console.log(`[contacts] ${results.length - failed}/${results.length} cases green${x}`);
  process.exit(failed > 0 ? 1 : 0);
}

// Corner-exposure geometry cases (src/sim/cornerCases.ts). Pure geometry, so it
// needs no level and runs instantly - and it is what decides whether the rope may
// bend around a compound body's vertex at all.
async function cmdCorners(): Promise<void> {
  const { runCornerCases } = await import("../sim/cornerCases");
  const results = runCornerCases();
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` (exposed=${r.got}, want ${r.want})`}`);
    if (!r.ok) failed++;
  }
  console.log(`[corners] ${results.length - failed}/${results.length} cases passed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Tangent-vertex cases (src/sim/tangentCases.ts). Pure geometry, so it needs no
// level and runs instantly - and it is what decides which corner a wrap node is
// born on, which the `entry && exit` branch of the wrap generator reaches too
// rarely for a recorded session to stand in for it.
async function cmdTangents(): Promise<void> {
  const { runTangentCases } = await import("../sim/tangentCases");
  const results = runTangentCases();
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` (${r.detail})`}`);
    if (!r.ok) failed++;
  }
  console.log(`[tangents] ${results.length - failed}/${results.length} cases passed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Convex-decomposition cases (src/sim/decomposeCases.ts). Pure geometry, so it
// needs no level and runs instantly - and it is what an authored concave outline
// becomes before any solver sees it, so a wrong answer here is geometry the
// whole simulation then agrees about.
async function cmdDecompose(): Promise<void> {
  const { runDecomposeCases, checkDecomposeDeterminism } = await import("../sim/decomposeCases");
  const results = [...runDecomposeCases(), checkDecomposeDeterminism()];
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
    for (const d of r.details) console.log(`        ${d}`);
    if (!r.passed) failed++;
  }
  console.log(`[decompose] ${results.length - failed}/${results.length} cases passed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Generated grab-scenario sweep (src/sim/ledgeMatrix.ts).
async function cmdLedges(): Promise<void> {
  const { runLedgeMatrix } = await import("../sim/ledgeMatrix");
  const results = runLedgeMatrix();
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
    for (const d of r.details) console.log(`        ${d}`);
    if (!r.passed) failed++;
  }
  console.log(`[ledges] ${results.length - failed}/${results.length} cases passed`);
  process.exit(failed > 0 ? 1 : 0);
}
