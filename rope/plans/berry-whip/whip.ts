// The whip rig: hook a berry, hang for 4 s, then circle the aim round the ball
// for 10 s at `period` frames a revolution - `cli contacts` `hung-anchor`'s
// input on a berry. Prints the peak ball and berry speeds under the current
// rule and under `globalThis.__BERRY_RULE = "new"` (see fork.ts for the switch).
//
// The static control in `hung-anchor` peaks at 1.6 m/s under the same input,
// and that case's bar is 5 m/s.
//
//   bun run plans/berry-whip/whip.ts 48
//   bun run plans/berry-whip/whip.ts 24

import { BallLevel } from "../../src/level/ballLevel";
import { Vec2 } from "../../src/engine/vec2";
import { button, emptyFrameInput } from "../../src/input/frameInput";
import type { RawLevelData } from "../../src/level/levelFormat";
import berryTest from "../../levels/berry-test.json";
import ball from "../../levels/ball.json";

const period = Number(process.argv[2] ?? 48);
const flags = globalThis as { __BERRY_RULE?: string };

// Each leg: the level, and how to pick the berry and place the ball under it.
const legs: { name: string; build: () => { level: BallLevel; fruit: any } }[] = [];
for (const which of [0, 1, 2]) {
  legs.push({
    name: `berry-test berry ${which}`,
    build: () => {
      // The same setup as test-berry-vines.ts's real throw.
      const data = structuredClone(berryTest) as RawLevelData;
      data.player.x = -140;
      data.player.y = -130;
      data.bodies![0]!.y = 600;
      const level = new BallLevel(data);
      return { level, fruit: level.vines[0]!.berries[which]!.fruit };
    },
  });
}
for (const [plant, which] of [[0, 0], [0, 1], [1, 0]] as const) {
  legs.push({
    name: `ball.json plant ${plant} berry ${which}`,
    build: () => {
      const level = new BallLevel(structuredClone(ball) as RawLevelData);
      const fruit = level.vines.filter((v) => v.starberry)[plant]!.berries[which]!.fruit;
      level.ball.globalPosition = fruit.globalPosition.add(new Vec2(0, 0.6));
      return { level, fruit };
    },
  });
}

for (const rule of ["old", "new"]) {
  flags.__BERRY_RULE = rule;
  for (const leg of legs) {
    const { level, fruit } = leg.build();
    let prev = emptyFrameInput();
    const feed = (aim: Vec2): void => {
      const input = { ...emptyFrameInput(), fire: button(true, prev.fire), mouseWorldPosition: aim };
      prev = input;
      level.physicsProcess(input, 1 / 60);
    };
    for (let f = 0; f < 240; f++) feed(fruit.globalPosition);
    const caught = level.ball.chain?.end.contact.obj === fruit;
    const start = level.ball.loopDirection.angle();
    let ballPeak = 0;
    let berryPeak = 0;
    for (let f = 0; f < 600; f++) {
      const angle = start + (f / period) * Math.PI * 2;
      feed(level.ball.globalPosition.add(new Vec2(Math.cos(angle), Math.sin(angle)).mul(2)));
      ballPeak = Math.max(ballPeak, level.ball.linearVelocity.length());
      berryPeak = Math.max(berryPeak, fruit.linearVelocity.length());
    }
    const held = level.ball.chain?.end.contact.obj === fruit;
    console.log(
      `${rule} ${leg.name}: caught=${caught} held=${held} peak ball ${ballPeak.toFixed(2)} m/s, berry ${berryPeak.toFixed(2)} m/s`,
    );
  }
}
