import { BallLevel } from "../src/level/ballLevel";
import { button, emptyFrameInput } from "../src/input/frameInput";
import { Vec2 } from "../src/engine/vec2";
import type { RawLevelData } from "../src/level/levelFormat";
import data from "../levels/starberry-test.json";
import { checkBallInvariants, worldDigestBall } from "../src/sim/trace";

const raw = structuredClone(data) as RawLevelData;
raw.player.x = -140; raw.player.y = -130;
raw.bodies![0]!.y = 600;
const level = new BallLevel(raw);
let prev = emptyFrameInput();
const vine = level.vines[0]!;
const fruit = vine.berries[1]!.fruit;
const initial = vine.allLinks.map(b => b.globalPosition);
let caught = false, worstBranch = 0, worstSpeed = 0;
const errors: string[] = [];
const frames: unknown[] = [];
for (let f = 0; f < 420; f++) {
  const input = { ...emptyFrameInput(), fire: button(f >= 10 && f < 300, prev.fire),
    mouseWorldPosition: fruit.globalPosition, moveRight: button(f > 80 && f < 220, prev.moveRight) };
  prev = input;
  level.physicsProcess(input, 1 / 60);
  errors.push(...checkBallInvariants(level).filter(v => v.kind.startsWith("starberry-")).map(v => v.detail));
  caught ||= level.ball.chain?.end.contact.obj === fruit;
  for (const b of vine.berries) worstBranch = Math.max(worstBranch,
    b.fruit.globalPosition.distanceTo(vine.links[b.parentIndex]!.globalPosition));
  for (const b of vine.allLinks) {
    if (!Number.isFinite(b.globalPosition.x + b.globalPosition.y)) throw new Error("Non-finite plant motion");
    worstSpeed = Math.max(worstSpeed, b.linearVelocity.length());
  }
  if (f % 60 === 0) frames.push({ frame: f, attached: level.ball.chain?.end.contact.obj?.name,
    ball: level.ball.globalPosition, fruit: fruit.globalPosition,
    trunkTip: vine.links.at(-1)!.globalPosition, asleep: vine.asleep });
}
console.log(JSON.stringify({ caught, worstBranch, worstSpeed, released: vine.lra === null,
  initialFruit: initial.at(-1), errors, digestBodies: worldDigestBall(level).bodies.length, frames }, null, 2));
if (!caught || errors.length || vine.lra !== null || worstBranch > vine.starberry!.stemLength + 0.05) process.exit(1);
