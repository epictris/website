# Open bug: a pivot body as the winch's anchor can be whirled into a slingshot

Status: **diagnosed, not fixed** (2026-08-25).
Two bounded fix attempts were spent and reverted (see "What was tried"), so per the debugging discipline this is the written diagnosis.
The short form lives in `CLAUDE.md` under the spin-rollback section; this file carries the repro and the measurements.

## The symptom

Anchor the ball's chain to a pivot-mounted body and whip the aim cursor in circles while holding deploy.
The body is pumped into a whip, the ball into a slingshot: reported three times as "the branch flung the player off" / "the branch applies massive force to the ball" (`session-136f`, `session-1010f`, both in `playtests/regressions/`).
Those two recordings also involved since-fixed bugs in the sprung-anchor load transfer; this class is what remains after those fixes, and it reproduces on a build with them in.

## The isolating measurement

Same rig, same inputs, only the anchor's mounting changes.
Rig: the thin hinged bar shaped like `levels/ball.json`'s pivoting log (concave elbow, ~10 px arms), ball anchored to its far arm, 240 frames of hold, then the cursor whipped in a 2 m circle around the ball at a full turn per 1.5 s for 600 frames.

| anchor | peak ball speed |
|---|---|
| static | 2.5 m/s |
| plain pivot (no spring) | 137 m/s |
| sprung pivot (0.5 Hz, zeta 0.15) | 55 m/s |

A static anchor is governed; any pivot is not.
The geometry matters: a plain 3 m x 0.24 m rect log at the same frequencies stays tame (peak body rate 1.35 rad/s in `cli spring` `winch-load`'s endgame clause) - the thin ELBOW, whose corners the chain wraps, is what ignites.

## Repro script

Paste into a scratch file and `bun run` it (it drives a real `BallLevel`; swap the `body` fields per the table above):

```ts
import { BallLevel } from "<repo>/rope/src/level/ballLevel";
import { button, emptyFrameInput } from "<repo>/rope/src/input/frameInput";
import { Vec2 } from "<repo>/rope/src/engine/vec2";
import { RigidBody2D } from "<repo>/rope/src/engine/body";

const verts = [
  { x: 116.01307189541359, y: -80.39215686274304 },
  { x: 26.01307189541373, y: 29.60784313725693 },
  { x: -153.9869281045867, y: 39.60784313725689 },
  { x: -153.9869281045867, y: 29.60784313725693 },
  { x: 16.01307189541359, y: 9.607843137257 },
  { x: 106.01307189541345, y: -90.39215686274301 },
];
const data = {
  player: { x: 2600, y: -650, radius: 12 },
  bodies: [
    { kind: "rigid", x: 2700, y: -810, rot: 0.26179938779915, friction: 1,
      pivot: true, pivotX: 109.99999999999987, pivotY: -79.99999999999989,
      // sprung variant; delete these two for the plain-pivot variant,
      // and change kind to "static" (dropping the pivot fields) for the control
      pivotFreq: 0.5, pivotDamping: 0.15,
      objects: [{ type: "collision", shape: { kind: "poly", verts } }] },
  ],
} as any;
const level = new BallLevel(data);
const log = level.bodies.find(
  (b): b is RigidBody2D => b !== (level as any).ball && b instanceof RigidBody2D,
)!;
let prev = emptyFrameInput();
const feed = (aim: Vec2) => {
  const input = { ...emptyFrameInput(), fire: button(true, prev.fire), mouseWorldPosition: aim } as any;
  prev = input;
  level.physicsProcess(input, 1 / 60);
};
const aimAt = log.globalPosition.add(new Vec2(-0.5, 0.35).rotated(log.globalRotation));
for (let f = 0; f < 240; f++) feed(aimAt);
const start = level.ball.loopDirection.angle();
let maxW = 0, maxV = 0;
for (let f = 0; f < 600; f++) {
  const angle = start + (f / 90) * Math.PI * 2;
  feed(level.ball.globalPosition.add(new Vec2(Math.cos(angle), Math.sin(angle)).mul(2)));
  maxW = Math.max(maxW, Math.abs(log.angularVelocity));
  maxV = Math.max(maxV, level.ball.linearVelocity.length());
}
console.log("maxW", maxW.toFixed(2), "maxBallV", maxV.toFixed(1));
```

Measured on the fixed build (gated weight transfer in): sprung elbow `maxW 26.1, maxBallV 54.8`; pre-session physics is the same to within noise, which is what shows the class predates this feature - a windmill fin has been anchorable since pivot bodies existed.

## The mechanism

The winch's governor assumes winding either hauls the ball to its anchor or is refused by the unwind (`Rope.unwindOverLength`), with the spin-rollback re-breaking the constraint so the unwind has length to refuse.
A pivot anchor leaks through all of it:

- The bar's rotation co-rotates with the whirling ball, so the pair orbits together, the chain never winds tight, and the unwind never has anything to refuse.
- The kinematic aim pays its winch budget (`|omega| x lengthPerRadian`, ~3.75 m/s of credit allowance per frame at full whip) into the system every frame - an infinite energy source by construction.
- The share of each correction the rollback leaves (the real-motion share, `1 - spinShare`) lands in the pivot's ROTATION, whose credit path (`addRotation` in `Rope.solvePass`'s credit loop) has no velocity-level bound - it is the one credit in the engine with no analogue of `clampCreditAlong`.
- A pivot's rotational effective mass `arm^2 / I` on the elbow sits near the ball's own `1/m`, so the pivot absorbs roughly half of every correction, into a frictionless bearing that stores it (a sprung one has damping `2 x zeta x omega` ~ 0.94/s against a credit re-earned at 60/s).

Trace signature (`cli trace <bundle> --body <log>`): `rope-solve` feeding dW of -1 to -3 rad/s per frame with `spin-rollback` returning only the spinShare fraction, net accumulation of ~-0.5 to -1.5 rad/s per frame for as long as the whirl lasts.

## What was tried and why it failed

1. **Weaken the rollback for sprung bodies** (exempt entirely, then position-share-only): removes the governor exactly where the anchor is lightest; both ran away harder (13 and 7 rad/s whips on `session-136f`).
   The shipped design keeps the rollback whole and transfers the hanging load as a gated, gravity-directed `applyHangLoad`-style impulse - that fixes the LOAD bugs, not this class.
2. **Bound the rotation credit by `creditBound`** (angular image of `clampCreditAlong`, `arm x credit <= bound`, implemented in `Rope.solvePass` and reverted): ineffective, because the bound is computed from the bodies' own velocities and chases the runaway once the whirl is real motion - measured 1.9 -> 7.9 rad/s of bound while the credit ran away underneath it, and the elbow rig still hit 26 rad/s with the clamp in.

## Fix directions worth designing (not patching)

- The unwind refusing spin whose correction landed in an anchor's ROTATION: treat length the solve paid by rotating the anchor body as length the ball's spin still owes, so the whirl stalls the way a static anchor does.
  This is the direction the existing machinery points (the rollback already does exactly this for the share it removes), but it needs the per-body rotational share of each solve measured where the unwind can see it.
- A coupled velocity-level solve over the path (the honest form the docs already name as missing for `settleChainBodies`).
- Bearing damping on pivot bodies is NOT the answer: it taxes every legitimate swing to hide an energy source.

## Standing coverage

None that goes red on the whip itself - the invariants are velocity-shaped and the aim is held, so `energy-gained` is disarmed; both recorded bundles replay within invariants.
`cli spring` `winch-load`'s endgame clauses (body never whipped, ball never flung) guard the rect-log rig, which stays tame; the elbow rig above is the reproduction and deliberately not a case, since it would be red on day one.
If this is fixed, turn the repro into a `winch-load` clause (or its own case) and delete this file.
