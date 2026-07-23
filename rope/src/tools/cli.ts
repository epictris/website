// Headless CLI for replay/playtest tooling. Run with bun:
//   bun run src/tools/cli.ts play      playtests/retract.json
//   bun run src/tools/cli.ts replay    bundle.json
//   bun run src/tools/cli.ts dump      bundle.json [--from A] [--to B] [--every N]
//   bun run src/tools/cli.ts continue  bundle.json [--from N] [--hold left,jump]
//                                      [--frames M] [--every K] [--trace out.jsonl]
//   bun run src/tools/cli.ts bundles   [dir]        (default playtests/bundles)
//   bun run src/tools/cli.ts selftest
//
// Exit codes: 0 = pass/healthy, 1 = failure/violation, 2 = usage error.
// (replay: 2 = diverged-but-healthy, 3 = invariant violated.)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Level } from "../level/level";
import { LEVELS, DEFAULT_LEVEL } from "../level/registry";
import { PhysTrace } from "../engine/physTrace";
import { runScript, type PlaytestScript } from "../sim/playtest";
import { runLedgeMatrix } from "../sim/ledgeMatrix";
import { replayRecording } from "../sim/replay";
import {
  ACTIONS,
  checkInvariants,
  digest,
  inputDeserializer,
  StuckDetector,
  type Digest,
  type Recording,
  type Violation,
} from "../sim/trace";

const [, , cmd, arg, ...rest] = process.argv;

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

function loadRecording(file: string): Recording {
  return JSON.parse(readFileSync(file, "utf8")) as Recording;
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
  console.log(`[replay] ${file} — level=${r.level} frames=${r.framesRun}`);
  if (r.divergedAtFrame !== null) console.log(`  diverged from recording at frame ${r.divergedAtFrame}`);
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
  if (r.divergedAtFrame !== null) console.log(`  diverged from recording at frame ${r.divergedAtFrame}`);
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
  const spec = LEVELS[rec.level];
  if (!spec) fail(`Unknown level: ${rec.level}`);
  if (spec.controller === "ball") fail(`continue does not support ball levels yet (${rec.level})`);
  const from = Math.min(Number(o.from ?? rec.frames.length), rec.frames.length);
  const frames = Number(o.frames ?? 120);
  const every = Number(o.every ?? 3);
  const holdNames = (o.hold ?? "").split(",").filter(Boolean);
  const NAME_TO_BIT: Record<string, number> = {
    left: 1 << 0,
    right: 1 << 1,
    jump: 1 << 2,
    retract: 1 << 3,
    extend: 1 << 4,
    fire: 1 << 5,
  };
  let heldBits = 0;
  for (const n of holdNames) {
    if (!(n in NAME_TO_BIT)) fail(`unknown --hold action: ${n} (${Object.keys(NAME_TO_BIT).join("|")})`);
    heldBits |= NAME_TO_BIT[n]!;
  }

  const level = new Level(spec.data, spec.init);
  const de = inputDeserializer();
  const stuck = new StuckDetector();
  const violations: Violation[] = [];

  for (let i = 0; i < from; i++) level.physicsProcess(de(rec.frames[i]!), 1 / 60);

  if (o.trace) {
    PhysTrace.reset();
    PhysTrace.enabled = true;
    level.player.stateChanged = (s) => PhysTrace.emit({ t: "transition", to: s.constructor.name });
  }

  console.log(`[continue] ${file} — level=${rec.level} from=f${from} hold=${holdNames.join("+") || "-"} frames=${frames}`);
  for (let i = 0; i < frames; i++) {
    const pos = level.player.globalPosition;
    const input = de({ h: heldBits, mx: pos.x, my: pos.y });
    level.physicsProcess(input, 1 / 60);
    const d = digest(level);
    violations.push(...checkInvariants(level));
    const sv = stuck.push(level, input);
    if (sv) violations.push(sv);
    if (PhysTrace.enabled) {
      const s = level.player.state as { supportBody?: { name?: string; constructor: { name: string } } | null };
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

// Replay every bundle in a directory with current physics; invariants (incl.
// the stuck detector) must hold. Digest divergence is informational — bundles
// recorded before a physics fix legitimately diverge.
function cmdBundles(dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    fail(`cannot read bundle dir: ${dir}`);
  }
  if (files.length === 0) fail(`no bundles in ${dir}`);
  let failed = 0;
  for (const f of files) {
    const r = replayRecording(loadRecording(join(dir, f)));
    const div = r.divergedAtFrame !== null ? ` (diverges @f${r.divergedAtFrame})` : "";
    if (r.violations.length > 0) {
      failed++;
      console.log(`FAIL ${f} — ${r.violations.length} violation(s)${div}`);
      printViolations(r.violations, 5);
    } else {
      console.log(`PASS ${f} — ${r.framesRun} frames${div}`);
    }
  }
  console.log(failed === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failed}/${files.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

// Determinism + replay round-trip self-test: run a scripted session, replay its
// captured inputs+digests, and confirm bit-for-bit reproduction.
function cmdSelftest(): void {
  const script: PlaytestScript = {
    level: DEFAULT_LEVEL,
    frames: 300,
    holds: [
      { action: "fire", from: 40, to: 300 },
      { action: "retract", from: 80, to: 200 },
      { action: "move_right", from: 120, to: 220 },
      { action: "jump", from: 210, to: 214 },
    ],
    mouse: [{ from: 1, to: 300, x: 220, y: -220, relative: true }],
  };

  const a = runScript(script);
  const rec: Recording = { level: script.level, frames: a.serializedFrames, digests: a.digests };
  const b = replayRecording(rec);

  const ok = b.divergedAtFrame === null && b.violations.length === 0;
  console.log(`[selftest] ran ${a.framesRun} frames, replayed ${b.framesRun}`);
  console.log(`  diverged: ${b.divergedAtFrame ?? "no"}  violations: ${b.violations.length}`);
  if (b.violations[0]) console.log(`  first: f${b.violations[0].frame} ${b.violations[0].kind}`);
  console.log(ok ? "RESULT: DETERMINISTIC" : "RESULT: NON-DETERMINISTIC / UNHEALTHY");
  process.exit(ok ? 0 : 1);
}

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
    if (!arg) fail("usage: cli continue <bundle.json> [--from N] [--hold a,b] [--frames M] [--every K] [--trace out.jsonl]");
    cmdContinue(arg, opts(rest));
    break;
  case "bundles":
    cmdBundles(arg ?? "playtests/bundles");
    break;
  case "selftest":
    cmdSelftest();
    break;
  case "ledges":
    cmdLedges();
    break;
  default:
    fail("usage: cli <play|replay|dump|continue|bundles|selftest|ledges> [file] [options]");
}

// Generated grab-scenario sweep (src/sim/ledgeMatrix.ts).
function cmdLedges(): void {
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
