// A/B fork of a recorded bundle: the recorded inputs up to `at` under the
// CURRENT rule, then `at..to` played twice from that same state - once on the
// current rule, once with `globalThis.__BERRY_RULE = "new"` - so the two legs
// differ only in the rule over the window.
//
// A whole-bundle replay cannot A/B a rule that changes the run before the
// window (session-221f leaves its recording at f28, the first hook), and the
// recorded inputs mean nothing after that.
//
// The tree must read the switch for this to compare anything: wrap the
// experiment in `(globalThis as any).__BERRY_RULE === "new" ? ... : ...` while
// measuring, and take it out again before anything is kept.
//
//   bun run plans/berry-whip/fork.ts playtests/bundles/session-221f.json 150 178 263
//   bun run plans/berry-whip/fork.ts playtests/bundles/session-501f.json 320 372 261

import { readFileSync } from "node:fs";
import { levelFromRecording } from "../../src/sim/replay";
import { recordingDeserializer } from "../../src/sim/trace";

const [file, atArg, toArg, berryArg] = process.argv.slice(2);
const at = Number(atArg);
const to = Number(toArg);
const berryId = Number(berryArg);
const rec = JSON.parse(readFileSync(file!, "utf8"));
const flags = globalThis as { __BERRY_RULE?: string };

function run(rule: "old" | "new"): void {
  flags.__BERRY_RULE = "old";
  const level = levelFromRecording(rec) as any;
  const de = recordingDeserializer(rec);
  const rows: string[] = [];
  let peak = 0;
  let gain = -Infinity;
  let e0 = 0;
  for (let i = 0; i < to; i++) {
    if (i === at) flags.__BERRY_RULE = rule;
    level.physicsProcess(de(rec.frames[i]), 1 / 60);
    const n = i + 1;
    if (n < at) continue;
    const ball = level.ball;
    const speed = ball.linearVelocity.length();
    // The ball's own mechanical energy, y down.
    const e = 0.5 * ball.mass * speed * speed - ball.mass * 9.8 * ball.globalPosition.y;
    if (n === at) e0 = e;
    peak = Math.max(peak, speed);
    gain = Math.max(gain, e - e0);
    const berry = level.world.bodies.find((b: any) => b.buildIndex === berryId);
    if ((n - at) % 2 === 0) {
      rows.push(
        `${n} ball=(${ball.globalPosition.x.toFixed(2)},${ball.globalPosition.y.toFixed(2)}) |v|=${speed.toFixed(2)} ` +
          `dE=${(e - e0).toFixed(0)}J berry=(${berry.globalPosition.x.toFixed(2)},${berry.globalPosition.y.toFixed(2)}) ` +
          `bv=(${berry.linearVelocity.x.toFixed(2)},${berry.linearVelocity.y.toFixed(2)}) ${ball.chain ? "held" : "-"}`,
      );
    }
  }
  console.log(`== ${rule}  peak |v| ${peak.toFixed(2)} m/s  max ball energy gain ${gain.toFixed(0)} J`);
  console.log(rows.join("\n"));
}

run("old");
run("new");
