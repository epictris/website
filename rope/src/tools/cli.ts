// Headless CLI for replay/playtest tooling. Run with bun:
//   bun run src/tools/cli.ts play  playtests/retract.json
//   bun run src/tools/cli.ts replay bundle.json
//   bun run src/tools/cli.ts selftest
//
// Exit codes: 0 = pass/healthy, 1 = failure/violation, 2 = usage error.

import { readFileSync } from "node:fs";
import { runScript, type PlaytestScript } from "../sim/playtest";
import { replayRecording } from "../sim/replay";
import type { Recording } from "../sim/trace";
import { DEFAULT_LEVEL } from "../level/registry";

const [, , cmd, arg] = process.argv;

function fail(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

function cmdPlay(file: string): void {
  const script = JSON.parse(readFileSync(file, "utf8")) as PlaytestScript;
  const r = runScript(script);
  console.log(`[play] ${file} — level=${r.level} frames=${r.framesRun}`);
  for (const a of r.assertResults) console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.description}`);
  for (const v of r.violations.slice(0, 20)) console.log(`  VIOLATION f${v.frame} ${v.kind}: ${v.detail}`);
  if (r.violations.length > 20) console.log(`  … ${r.violations.length - 20} more violations`);
  console.log(r.passed ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(r.passed ? 0 : 1);
}

function cmdReplay(file: string): void {
  const rec = JSON.parse(readFileSync(file, "utf8")) as Recording;
  const r = replayRecording(rec);
  console.log(`[replay] ${file} — level=${r.level} frames=${r.framesRun}`);
  if (r.divergedAtFrame !== null) console.log(`  diverged from recording at frame ${r.divergedAtFrame}`);
  for (const v of r.violations.slice(0, 20)) console.log(`  VIOLATION f${v.frame} ${v.kind}: ${v.detail}`);
  // exit 0 healthy, 2 diverged-but-healthy (fix working), 3 invariant violated.
  const code = r.violations.length > 0 ? 3 : r.divergedAtFrame !== null ? 2 : 0;
  console.log(`RESULT: ${code === 0 ? "HEALTHY" : code === 2 ? "DIVERGED (healthy)" : "VIOLATIONS"}`);
  process.exit(code);
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
  case "selftest":
    cmdSelftest();
    break;
  default:
    fail("usage: cli <play|replay|selftest> [file]");
}
