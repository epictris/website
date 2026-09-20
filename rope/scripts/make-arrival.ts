// Turn a recorded session bundle into a level's RECORDED ARRIVAL - the input
// stream a level opens on, played back by the sim before the ball is handed to
// the player (see `SpawnData.arrival` and docs/ball-rolling.md#the-recorded-arrival).
//
//   bun run scripts/make-arrival.ts <bundle.json> <level-file> [name]
//   bun run scripts/make-arrival.ts ~/Downloads/session-449f.json cave
//
// What it writes is a STREAM, not a replay: the frames and the point the ball
// starts from, and nothing else. The digests, the world digests and the input
// trace that make the bundle evidence are dropped, because the app is not
// checking the run when it plays it - it is playing it, on a level built from
// the level FILE, with the sim it ships. Keep the bundle itself in
// `playtests/arrivals/` and `cli replay` can be pointed at it whenever the
// question is whether the tree still reproduces the run the stream was cut
// from; this file is what the browser downloads.
//
// THE CHECK THAT MATTERS IS THE GEOMETRY. A stream only replays what was
// recorded while the level it is played on is the level it was recorded on, and
// the one thing that may differ is the SPAWN - the recording started wherever
// the arrival starts, and the level's own spawn is where a reset puts the
// player. Everything else - the bodies, the environment, the camera paths, the
// ball's radius - has to be identical or the arrival is of a level that no
// longer exists, so a difference here is a hard failure with the field named
// rather than a warning nobody reads.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Recording } from "../src/sim/trace";
import type { RawLevelData } from "../src/level/levelFormat";
import type { ArrivalStream } from "../src/level/arrivals";

// WHERE THE STREAM IS CUT: an arrival ends when the ball in it stops moving,
// not when the person who recorded it got round to pressing P.
//
// The tail between those two is the worst second in the game. The ball is
// standing still, the opening is over, the controls are dead and nothing on
// screen says which of those is a bug - so the player's first act is to move
// the mouse to find out whether anything is listening. The cave's recording
// carried 1.1 s of it.
//
// Found by scanning BACKWARDS for the last frame the ball was still travelling.
// Forwards, any pause would do - a ball hanging on its spawn anchor for a
// second before the first throw, a ball resting on a ledge between two - and
// the opening would be cut off at the first of them.
const STILL_SPEED = 0.1; // m/s: a ball this slow is settling, not travelling
// ...and the beat left after it, so the hand-over is not the same instant as
// the landing. A tenth of a second: enough that the ball is seen to arrive
// before the reticle appears, short enough not to be a wait.
const HANDOVER_TAIL = 6; // frames

const root = join(import.meta.dirname, "..");

const [bundlePath, levelFile, nameArg] = process.argv.slice(2);
if (!bundlePath || !levelFile) {
  console.error("usage: bun run scripts/make-arrival.ts <bundle.json> <level-file> [name]");
  process.exit(1);
}
const name = nameArg ?? levelFile;

const rec = JSON.parse(readFileSync(bundlePath.replace(/^~/, process.env.HOME ?? "~"), "utf8")) as Recording;
const level = JSON.parse(readFileSync(join(root, "levels", `${levelFile}.json`), "utf8")) as RawLevelData;

if (rec.controller !== "ball") {
  console.error(`[arrival] ${bundlePath} was recorded with the ${rec.controller ?? "grapple"} controller.`);
  process.exit(1);
}
const recorded = rec.data;
if (!recorded) {
  console.error(
    `[arrival] ${bundlePath} carries no level data, so there is nothing to check it against the level file with. ` +
      `Record the arrival from the level page (P), which embeds the level the run was played on.`,
  );
  process.exit(1);
}

// Every field but the spawn, compared as the bytes they are written as: the
// level file and the bundle's copy of it are the same JSON, so a stringify of
// each field is an exact comparison that names the field that differs.
const json = (v: unknown): string => JSON.stringify(v);
const fields = new Set([...Object.keys(recorded), ...Object.keys(level)]);
fields.delete("player");
const differs = [...fields].filter(
  (k) => json((recorded as Record<string, unknown>)[k]) !== json((level as Record<string, unknown>)[k]),
);
if (differs.length > 0) {
  console.error(
    `[arrival] the bundle was recorded on a different ${levelFile}: ${differs.join(", ")} ` +
      `${differs.length === 1 ? "differs" : "differ"} from the level file. ` +
      `An arrival only replays on the level it was recorded on - re-record it against the level as it stands.`,
  );
  process.exit(1);
}
// The spawn is the one field that is ALLOWED to differ, and only in where it
// is: an arrival starts where the recording did and hands over where the
// level's own spawn is. Everything else about the spawn is the run itself - the
// ball's size, and whether it opens on its anchor - so those are held to the
// level file like the geometry above.
if (recorded.player.radius !== level.player.radius) {
  console.error(
    `[arrival] the bundle's ball is r=${recorded.player.radius} and the level's is r=${level.player.radius}: ` +
      `a different ball plays a different run.`,
  );
  process.exit(1);
}
if (Boolean(recorded.player.hang) !== Boolean(level.player.hang)) {
  console.error(
    `[arrival] the bundle ${recorded.player.hang ? "started hanging" : "started on the ground"} and the level ` +
      `${level.player.hang ? "says hang" : "does not"}: the build throws the spawn chain, so the two openings are different runs.`,
  );
  process.exit(1);
}
// A recording made on a rolling entry opened with the SIM driving the ball, and
// an arrival is the input stream alone: played back, its first second would be
// a ball nobody pushed.
if (recorded.player.roll) {
  console.error(
    `[arrival] the bundle was recorded on a spawn that rolls in (roll=${recorded.player.roll}). ` +
      `An arrival replaces the entry rather than containing it - re-record with the roll off.`,
  );
  process.exit(1);
}

// The frame the stream is cut at (see `STILL_SPEED`). A bundle with no digests
// cannot be asked when its ball stopped, and is kept whole rather than guessed
// at - `arrival-lands` is what would report the dead tail that leaves.
function settledAt(): number {
  const digests = rec.digests;
  if (!digests || digests.length === 0) {
    console.warn(
      `[arrival] this bundle carries no digests, so where its ball stops cannot be read: keeping every frame.`,
    );
    return rec.frames.length;
  }
  for (let i = digests.length - 1; i >= 0; i--) {
    const d = digests[i]!;
    if (Math.hypot(d.vx, d.vy) < STILL_SPEED) continue;
    return Math.min(rec.frames.length, d.frame + HANDOVER_TAIL);
  }
  // A recording in which the ball never travels at all. Nothing to cut: the
  // whole of it is as still as its end.
  return rec.frames.length;
}

const keep = settledAt();
const frames = rec.frames.slice(0, keep);

const stream: ArrivalStream = {
  level: levelFile,
  // In the level file's own pixels, like every other length on disk: the sim
  // scales it by PX exactly as it scales the spawn, so the ball is placed on
  // the double the recording started from (see `BallLevel.startArrival`).
  from: { x: recorded.player.x, y: recorded.player.y },
  ...(rec.heldAtStart ? { heldAtStart: rec.heldAtStart } : {}),
  recorded: {
    bundle: bundlePath.split("/").pop() ?? bundlePath,
    ...(rec.git ? { git: rec.git } : {}),
    ...(rec.srcHash ? { srcHash: rec.srcHash } : {}),
    // What the bundle held, when the stream is shorter: the cut is a decision
    // about the opening, and the file it was cut from says so.
    ...(keep < rec.frames.length ? { frames: rec.frames.length } : {}),
  },
  frames,
};

const out = join(root, "src", "level", "arrivals", `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(stream)}\n`);

console.log(
  `[arrival] ${name}: ${frames.length} frames (${(frames.length / 60).toFixed(1)} s) from ${stream.from.x}, ${stream.from.y} ` +
    `-> ${out.slice(root.length + 1)} (${(readFileSync(out).length / 1024).toFixed(1)} kB)`,
);
if (keep < rec.frames.length) {
  const cut = rec.frames.length - keep;
  console.log(
    `[arrival] cut ${cut} frames (${(cut / 60).toFixed(2)} s) of settled tail off the end of ${rec.frames.length}: ` +
      `the ball was last travelling faster than ${STILL_SPEED} m/s at f${keep - HANDOVER_TAIL}.`,
  );
}
console.log(
  `[arrival] keep the bundle: gzip it into playtests/arrivals/ so \`cli replay\` can hold the tree to it.`,
);
