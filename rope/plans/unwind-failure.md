# Plan: the unwind cannot refund a chain wound onto its own anchor

Status: open bug, diagnosed 2026-09-05, not fixed.
The wind-stall latch currently papers over it, which is why the corpus stays green.
This document holds everything a fresh session needs to reproduce, understand and close it.

## The symptom

`playtests/regressions/session-611f.json.gz` (level `polygon-test`, a 430 kg free rigid polygon resting on the floor, the ball's chain anchored to it).
The ball winds itself all the way up to the anchor and ends resting against the polygon with the anchor point ON the ball's rim.
From frame 248 the player keeps aiming in the winding direction at 1 to 7 rad/s.
Every frame the aim turns the ball a little, the chain's measured length grows by the ball's radius times that turn, and the unwind (`Rope.unwindOverLength`) refunds nothing.
`cli trace` prints `used=0.00000 (0%)` for 35 frames running while the residual climbs 5 to 20 mm a frame, 11 mm at frame 246 to 226 mm at frame 280.
Nothing else in the frame can pay the length either: the ball is against the body so the solve's haul is undone by the push-out, and `winchOwed` is false because no scene chain holds the polygon.
The over-length falls through to the stall lease (`Rope.absorbBlockedLength`), which is the chain growing without limit.

At frame 283 the ball happens to have moved 18.7 mm off the anchor, the unwind works again (100% of a 0.052 rad window refunded), and the refund is whole, so the wind-stall latch fires (`BallPlayer.windStall`).
The steering stops writing spin, the ball sits at rotation 13.143, and the lease pays the residual back down over the next ten frames (150 mm, 65 mm, 8 mm, 3.7 mm).
That latch is the only reason this bundle replays under the `rope-over-length` bar (`CHAIN_OVER_LENGTH_TOLERANCE`, 0.25 m in `src/sim/trace.ts`).
The recording itself, made on the tree it was recorded on, ends the same episode 3 cm over its length, so the failure predates every change made on 2026-09-05.

### How it was found

The stall latch was changed on 2026-09-05 to stop it freezing a ball whose chain leaves radially (`session-287f`; see the `point-blank-turn` case in `cli contacts` and the CLAUDE.md paragraph "The latch asks for a chain that WINDS").
The first version of that change gated the latch on the refunded turn being worth at least `CHAIN_TOLERANCE` of chain.
Frame 283's refund is 2.7 mm, so the latch never fired, the ball kept turning past 13.143 into rotations where the unwind fails again, and `session-611f` ran 25 cm over length at frames 572 to 584.
The latch now gates on the spool instead (`BallPlayer.STALL_LATCH_SPOOL_SHARE`), which fires at frame 283 and restores the mask.
The mask is not a fix.

## Reproduction

Every command runs from `rope/`.

```sh
# the corpus replay: PASS today, because the latch masks it
bun run src/tools/cli.ts replay playtests/regressions/session-611f.json.gz

# the unwind giving up, frame by frame: look at the `unwind` rows
bun run src/tools/cli.ts trace playtests/regressions/session-611f.json.gz --from 246 --to 284

# the state: 44 nodes, 43 of them coil on the ball, and a free span of 0.0000 m
bun run src/tools/cli.ts query playtests/regressions/session-611f.json.gz --frame 270 --json
```

To see the bug without the mask, disable the latch and replay: in `BallLevel.physicsProcess` make the `this.ball.windStall = Math.sign(this.aimSpin)` assignment unreachable (or set `STALL_LATCH_SPOOL_SHARE` to 10), then run the replay above.
It fails with `rope-over-length: len=1.4 > max=1.1` from frame 572.
Revert before committing anything.

### The decisive probe

The script below rebuilds the level from the bundle, steps it to a frame, and measures the chain's path length at the ball's rotation and at small offsets either side.
It uses two private members through `any`, `calculateRopePathLength` and `coilWindAngle`.

```ts
// probe611.ts - run with `bun run probe611.ts` from anywhere; paths are absolute
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { levelFromRecording } from "/home/tris/projects/website/rope/src/sim/replay";
import { inputDeserializer } from "/home/tris/projects/website/rope/src/sim/trace";
import { BallLevel } from "/home/tris/projects/website/rope/src/level/ballLevel";
const raw = readFileSync("/home/tris/projects/website/rope/playtests/regressions/session-611f.json.gz");
const rec = JSON.parse(gunzipSync(raw).toString("utf8"));
const level = levelFromRecording(rec) as BallLevel;
const de = inputDeserializer();
const probeAt = new Set([246, 250, 251, 260, 270, 283]);
for (let i = 0; i < 290; i++) {
  level.physicsProcess(de(rec.frames[i]), 1 / 60);
  const f = i + 1;
  if (!probeAt.has(f)) continue;
  const ball = level.ball; const ch: any = ball.chain;
  const dist = ch.end.contact.globalPosition.distanceTo(ball.globalPosition);
  const theta = ball.globalRotation;
  const L0 = ch.calculateRopePathLength();
  const rows: string[] = [];
  for (const d of [-0.1, -0.05, -0.02, -0.005, 0, 0.005, 0.02, 0.05, 0.1]) {
    ball.globalRotation = theta + d;
    rows.push(`${d >= 0 ? "+" : ""}${d.toFixed(3)}:${((ch.calculateRopePathLength() - L0) * 1000).toFixed(2)}mm`);
  }
  ball.globalRotation = theta;
  ch.calculateRopePathLength();
  console.log(`f${f} rot ${theta.toFixed(4)} len ${L0.toFixed(4)} max ${ch.maxRopeLength.toFixed(4)} anchor off rim ${((dist - ball.radius) * 1e6).toFixed(1)} um coilWindAngle ${ch.coilWindAngle?.toFixed(4)} spool ${ch.lengthPerRadian(ball).toFixed(4)} wraps ${ch.wraps.length}`);
  console.log(`     dL vs rotation offset: ${rows.join("  ")}`);
}
```

Its output on the tree of 2026-09-05:

```
f246 rot 11.2188 len 1.1466 max 1.1354 anchor off rim 13.5 um coilWindAngle 9.5540 spool -0.1196 wraps 39
     dL vs rotation offset: -0.100:11.99mm  -0.050:6.00mm  -0.020:2.40mm  -0.005:0.60mm  +0.000:0.00mm  +0.005:0.28mm  +0.020:2.08mm  +0.050:5.68mm  +0.100:11.68mm
f250 rot 11.3397 len 1.1608 max 1.1354 anchor off rim 5.8 um coilWindAngle 9.6734 spool 0.0000 wraps 39
     dL vs rotation offset: -0.100:11.99mm  -0.050:6.00mm  -0.020:2.40mm  -0.005:0.60mm  +0.000:0.00mm  +0.005:0.59mm  +0.020:2.39mm  +0.050:5.99mm  +0.100:11.98mm
f260 rot 11.5578 len 1.1872 max 1.1354 anchor off rim 1.6 um coilWindAngle 9.8917 spool -0.1200 wraps 40
     dL vs rotation offset: -0.100:11.99mm  -0.050:6.00mm  -0.020:2.40mm  -0.005:0.60mm  +0.000:0.00mm  +0.005:0.15mm  +0.020:1.95mm  +0.050:5.55mm  +0.100:11.54mm
f270 rot 12.0274 len 1.2434 max 1.1354 anchor off rim 42.0 um coilWindAngle 10.3609 spool 0.1148 wraps 42
     dL vs rotation offset: -0.100:11.72mm  -0.050:5.72mm  -0.020:2.12mm  -0.005:0.32mm  +0.000:0.00mm  +0.005:0.60mm  +0.020:2.39mm  +0.050:5.99mm  +0.100:11.99mm
f283 rot 13.1431 len 1.3282 max 1.1354 anchor off rim 18685.6 um coilWindAngle 10.8986 spool 0.0516 wraps 44
     dL vs rotation offset: -0.100:-1.11mm  -0.050:-1.62mm  -0.020:-0.89mm  -0.005:-0.25mm  +0.000:0.00mm  +0.005:0.27mm  +0.020:1.16mm  +0.050:3.32mm  +0.100:7.75mm
```

Read the middle rows: while the anchor is within microns of the rim, the path length is a V with its vertex at the ball's current rotation, growing by exactly `radius x |offset|` (0.12 m/rad, 12 mm per 0.1 rad) whichever way the ball turns.
No rotation shortens the chain, so a search that only accepts a shorter length has nothing to accept.
At frame 283, with the anchor 18.7 mm off the rim, the length is a slope again (negative for one direction) and the unwind works.

## The mechanism

Three pieces of `src/classes/rope.ts` combine.

1. **The coil is an angle, re-derived each regeneration** (`Rope.syncCoil`, see CLAUDE.md "The coil").
   The tangent point is where a taut line from the next node (here the anchor) touches the ball's circle, and the wind angle runs from the material start point round to that tangent point.
   `syncCoil` has a guard for the degenerate frame:

   ```ts
   // No tangent exists to a point inside the circle - a degenerate frame, and
   // not one to re-derive an angle from. Leave the coil as it stands.
   if (radius <= 0 || exitTowards.distanceTo(centre) <= radius) return;
   ```

   A ball wound all the way up sits with its anchor ON its rim, so `exitTowards.distanceTo(centre)` is within float noise of `radius` for frame after frame: 13 um, 6 um, 26 um, 2 um, 42 um above it on the probed frames, and below it on the frames the trace prints `spool=0.00000`.
   The guard was written for a one-off degenerate frame.
   Here it holds for 35 frames.

2. **When the guard returns, the coil nodes ride the body.**
   `RopeWrap` contacts are stored body-local, so the existing coil nodes rotate with the ball while the anchor stays where it is.
   The last coil node is therefore carried away from the anchor by `radius x turn` every frame, and the terminal span between them is measured as that chord (it is not an arc: `Rope.spanLength` only arcs a span whose two ends are on the same circle, and the anchor is on the polygon).
   That is where the length comes from: the unwind's window each frame is the aim's turn, and the residual grows by the window times the radius.
   Because the last node is carried off whichever way the ball turns, the terminal span grows whichever way the trial rotation goes.
   That is the V.

3. **The unwind is a descent, and accepts only a shorter length** (`Rope.unwindOverLength`).
   It is Newton on `Rope.lengthPerRadian` with `UNWIND_ITERATIONS` (4) steps of `UNWIND_BACKTRACKS` (6) halvings, keeping the best rotation seen, bounded to the window between the frame's start rotation and its current one.
   On a V no candidate improves, so it breaks out with `used=0`.
   `lengthPerRadian` compounds this: it skips a span shorter than 0.1 mm (`moving.distanceSquaredTo(fixed) < PX * PX * 1e-4`), so on the frames where the terminal span has just been absorbed the rate reads exactly 0 and the search stops at `MIN_SPOOL_RATE` before trying anything; on the others the rate is the chord's direction, which is numerically arbitrary at that length, hence the +0.12 / -0.12 alternation in the trace.

On the frames where the anchor reads a few microns OUTSIDE the radius, `syncCoil` does re-derive the coil: the tangent point is essentially the anchor, the terminal span is absorbed into the coil angle (the `coilWindAngle` column climbs 9.55, 9.67, 9.71, 9.89, 10.36, 10.90 as the residual is folded in), and the spool reads a clean +/-0.12.
That absorption is what turns the riding-node chord into permanent coil.
It is also why the probe still shows a V on those frames: the trial rotations inside the probe (and inside the unwind) put the anchor back inside the radius and the guard returns.

What SHOULD be true in this state: the free chain is zero, so any turn in the winding direction is refused in full (the unwind refunds the whole window) and any turn the other way is free (it pays coil out).
The length must be a monotone function of the ball's rotation with slope `+/-radius`, not a V.

## The fix, as far as it has been thought through

The guard is the bug.
For a next node on or inside the circle the tangent point is not undefined for our purposes: the chain leaves the ball radially at the point of the rim nearest the anchor.
Project `exitTowards` onto the circle and use that as the tangent point, that is `centre + (exitTowards - centre).normalized() x radius`, guarding only the genuinely undefined `exitTowards === centre`.
With the tangent re-derived every frame the wind angle tracks the ball's rotation linearly, the terminal span is zero, `lengthPerRadian` sees the coil's own slope, and the unwind refunds the winding.

Things to check while doing it:

- `syncCoil`'s unwrapping picks the whole turn nearest last frame's angle.
  With the tangent pinned at the anchor and the start point rotating, the raw angle moves continuously, so the unwrap should behave; confirm with the probe that `dL` is linear in the offset with slope +/-0.12 on frames 246 to 270.
- The very first coil frame (`runLength === 0 && coilWindAngle === null` returns before the guard) is unaffected.
- `Rope.lengthPerRadian`'s 0.1 mm span skip should probably stay, since with the fix the terminal span is genuinely zero and the coil's leaving span (the last coil node to the anchor) carries the rate.
  Verify the rate is +/-0.12 and never 0 on the fixed replay.
- `Rope.regenerateAndMeasure` takes its baseline after a coil sync so the coil's ride does not read as a discontinuity (see CLAUDE.md "The coil").
  A coil that now re-derives on frames it used to skip may change `topologyJump` on those frames; watch `rope-credit-unearned` and `rope-solve-kick` on the corpus.
- `RopeGeneration.calculateCircleTangentPoint` (`src/lib/ropeGeneration.ts`) is the helper the guard protects; it computes an angle from `fromPoint - center` and will produce something for a point on the rim, so the projection may be as simple as calling it with the projected point.

Do not fix it by teaching the unwind to accept a longer candidate, or by widening the stall lease.
The measurement is what is wrong; the search and the lease are behaving correctly on the number they are given.

## Acceptance

1. `session-611f` replays HEALTHY with the wind-stall latch disabled (see Reproduction).
   Its residual must not climb from frame 248; `cli trace` should show the unwind refunding the window on those frames.
2. The probe shows a monotone `dL` on frames 246 to 270, slope of magnitude 0.12 m/rad, no V.
3. A detector in `cli contacts` next to `ball-sparks` `wound`: the ball wound completely onto a rigid anchor with the anchor on its rim, the aim held in the winding direction for 60 frames.
   Assert the chain's over-length never exceeds `CHAIN_TOLERANCE` beyond its lease, that the unwind refunds (rotation span under 1e-3 rad, as `wound` asserts), and, as the rig's precondition, that the anchor sits within 1 mm of the rim.
   Build it red on the current tree first: the same rig should show the residual climbing with `windStall` forced off.
4. `bun run test` green, in particular `whirl-anchor`, `winch-load`, `winch-anchor-load`, `hang-settle` (`cli spring`), `ball-sparks`, `hung-anchor`, `point-blank-turn` (`cli contacts`) and the whole bundle corpus.
   Bundles that reach the wound-tight state will legitimately diverge; every other bundle must stay bit-identical, because the guard is the only branch that changes.
5. Once the unwind carries this state, reconsider whether `session-611f`'s frame 283 latch is still needed at all; it must at least still fire on the `wound` rig.

## Related history

- CLAUDE.md "The coil" explains why the coil is an angle and not nodes, and why `regenerateAndMeasure` syncs the coil before its baseline.
- CLAUDE.md "The latch asks for a chain that WINDS" records the two latch variants tried on 2026-09-05 and why the spool gate won.
- `session-475f` (wound all the way up, the stall growing 18 cm to 366 cm) is the original wound-tight runaway the unwind was written for; this bug is the case its own measurement cannot see.
- `session-394f` is why the unwind is bounded to the frame's window and never spins the ball backwards; keep that bound.
