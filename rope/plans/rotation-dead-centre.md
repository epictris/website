# Plan: the ball's rotation locks at the chain's dead centre

Status: open bug, diagnosed 2026-09-14 from `session-702f`, not fixed.
The corpus stays green because nothing here breaks an invariant: the chain never goes over length, no body is embedded, no energy is minted.
The failure is entirely one of feel, and the only instrument that sees it is the unwind's own `used%` row.

Reported as "the ball rotation gets blocked for some reason near the end".

## The symptom

`session-702f.json` (level `ball`, recorded at `0f2da93`, `srcHash f3f83f267440`, 702 frames).
It replays bit-exact and reports HEALTHY.

The run has five anchored windows.
In the last one the ball's steering stops working twice, for ten frames and then for three.

| window | mean unwind refund | frames >= 80% | frames >= 95% |
|---|---|---|---|
| f57-110 | 0% | 0 | 0 |
| f166-225 | 0% | 0 | 0 |
| f306-365 | 0% | 0 | 0 |
| f450-506 | 6% | 0 | 0 |
| **f588-664** | **28%** | **12** | **4** |

Over **f606-615** the steering asks for 172 degrees of turn and the ball delivers 12.
At f613 the refund is exactly 100% and the ball's angular velocity leaves the phase at `w=0.000` against a demand of -22.1 rad/s.
It happens again over **f634-636**: 44 degrees asked, 17 delivered.

Every high-refund frame in that window leaves the ball at a spool rate between 0.00006 and 0.00136 m/rad, against the ball's rim radius of 0.12.
That is the whole of the diagnosis in one number, and the rest of this document is where it comes from.

## Reproduction

The bundle is in `~/Downloads/session-702f.json` and was copied to `playtests/bundles/` (gitignored) to run these.
Promote it to `playtests/regressions/` when the fix lands, because none of the committed corpus reaches this geometry.

```sh
# HEALTHY, bit-exact, tree match - the failure breaks no invariant
bun run src/tools/cli.ts replay playtests/bundles/session-702f.json

# the lock: read the `unwind ... used=` and `aim ... Δw=` rows
bun run src/tools/cli.ts trace playtests/bundles/session-702f.json --from 596 --to 620 --body 0

# the frame the whole turn is refused, with the length solve opened
bun run src/tools/cli.ts trace playtests/bundles/session-702f.json --from 613 --to 613 --solve

# the chain is a bare two-node span for the whole window, then gains a wrap at f616
bun run src/tools/cli.ts chainpath playtests/bundles/session-702f.json --from 596 --to 620
```

### The decisive probe

`PhaseTrace.unwind` prints the window, what the search used, and the residual, but not the excess the search was handed.
That number is what separates "the solve did not converge" from "something re-broke the constraint after the solve", and they have opposite fixes.
Add this temporarily at the top of the `if (PhaseTrace.enabled)` block in `Rope.unwindOverLength`, with `startExcess` and `startRate` captured right after `bestExcess` is first assigned:

```ts
const startExcess = bestExcess;
const startRate = this.lengthPerRadian(body);
// ... after the search, inside `if (PhaseTrace.enabled)`:
console.error(
  `    PROBE startExcess=${(startExcess * 1000).toFixed(3)}mm startRate=${startRate.toFixed(5)} ` +
    `endExcess=${(bestExcess * 1000).toFixed(3)}mm walked=${(bestRotation - startRotation).toFixed(5)} ` +
    `window=${(highRotation - lowRotation).toFixed(5)} forgive=${(forgive * 1000).toFixed(3)}mm`,
);
```

What it prints over f606-615:

```
f606  startExcess= 0.954mm  startRate=-0.01297  endExcess=0.300mm  walked=0.11250  window=0.13498
f607  startExcess= 1.432mm  startRate=-0.01617  endExcess=0.405mm  walked=0.13230  window=0.16253
f608  startExcess= 2.653mm  startRate=-0.02311  endExcess=0.546mm  walked=0.19195  window=0.21072
f609  startExcess= 3.770mm  startRate=-0.02766  endExcess=0.730mm  walked=0.22146  window=0.25013
f610  startExcess= 5.293mm  startRate=-0.03356  endExcess=0.786mm  walked=0.26882  window=0.28945
f611  startExcess= 7.733mm  startRate=-0.04085  endExcess=0.988mm  walked=0.33422  window=0.34749
f612  startExcess= 7.747mm  startRate=-0.04067  endExcess=1.062mm  walked=0.31981  window=0.34965
f613  startExcess= 8.932mm  startRate=-0.04456  endExcess=0.857mm  walked=0.36798  window=0.36798
f614  startExcess=10.364mm  startRate=-0.04711  endExcess=1.287mm  walked=0.38298  window=0.40383
f615  startExcess=14.891mm  startRate=-0.05683  endExcess=1.390mm  walked=0.45947  window=0.48094
```

The search is not stalling and is not failing.
It is being handed 9 to 15 mm and buying it at a rate twenty times below the rim, so it spends the entire window every frame.

Revert the probe before committing anything.

## The mechanism

### The chain has no coil, so its length has a stationary point in the ball's rotation

Through the whole window the chain is a bare two-node span: a material attachment on the ball's rim, straight to an attachment on body #124.
`chainpath` shows `nodes=2` from f596 to f615, and `nodes=3` only from f616.

For that shape `Rope.lengthPerRadian` reduces to `r * sin(phi)`, where `phi` is the angle between the rim offset and the line from the ball's centre to the anchor.
So the chain path length has a minimum at `phi = 0`, the rim attachment radially in line with the anchor, and turning the ball either way from there lengthens it.

Do not measure `phi` off `chainpath`: it prints node positions rounded to whole scene pixels, and at a 12 px rim radius that rounding is worth about 5 degrees, which is larger than the angles that matter here.
The trace's own `spool` is exact, and `phi = asin(spool / 0.12)` inverts it.
That column against the unwind's `used%`, from the `--from 596 --to 620` trace above:

```
f596  used=  0%  spool= 0.04210  phi= 20.54 deg
f600  used=  0%  spool= 0.03833  phi= 18.63 deg
f602  used=  0%  spool= 0.02862  phi= 13.80 deg
f603  used=  0%  spool= 0.02084  phi= 10.00 deg
f604  used=  0%  spool= 0.01166  phi=  5.58 deg
f605  used=  0%  spool= 0.00088  phi=  0.42 deg
f606  used= 83%  spool= 0.00136  phi=  0.65 deg
f607  used= 81%  spool= 0.00067  phi=  0.32 deg
f608  used= 91%  spool= 0.00124  phi=  0.59 deg
f609  used= 89%  spool= 0.00034  phi=  0.16 deg
f610  used= 93%  spool= 0.00027  phi=  0.13 deg
f611  used= 96%  spool= 0.00094  phi=  0.45 deg
f612  used= 91%  spool=-0.00071  phi= -0.34 deg
f613  used=100%  spool= 0.00126  phi=  0.60 deg
f614  used= 95%  spool= 0.00040  phi=  0.19 deg
f615  used= 96%  spool=-0.00070  phi= -0.33 deg
f616  used=  0%  spool= 0.04863  phi= 23.91 deg
```

The ball arrives at the dead centre under its own steering over f596-605, while the unwind is doing nothing at all, and from f606 it is **pinned** there.
Every one of those ten frames the aim turns it 6 to 28 degrees off the minimum (that is `startRate` in the probe above, -0.013 to -0.057 m/rad), and every one of them the unwind walks it back to within 0.7 degrees of it.

The pinning is not an attraction the search exerts from a distance: `unwindOverLength` clamps every candidate to `[rotationAtFrameStart, startRotation]`, so it can only ever undo the frame, never overshoot.
What makes the dead centre a trap is that undoing the frame *is* returning to it.
Once the ball is there, every turn in either direction is wound length, so every turn is refused, so the ball is still there next frame.
f616 is the only thing that breaks it, and f616 is the steering flipping (below), not the ball escaping.

### What the unwind is actually paying for is the spin rollback's re-break

`trace --solve` at f613:

```
solve:length   it=0  err 22.762 -> 0.000mm    #0 1/m=1.92e-2  #124 1/m=2.30e-2
rope-solve     body#  0 Player       Δp=(  2.042, -10.158)mm
rope-solve     body#124 RigidBody2D   Δp=( -2.444,  12.157)mm
spin-rollback  body#124 RigidBody2D   Δp=(  1.761,  -8.757)mm
hang-load      body#124 RigidBody2D   Δv=( 0.0000,   0.1408)
unwind         window=0.36798 used=0.36798 (100%) residual=0.857mm spool=0.00126m/rad
unwind         body#  0 Player       Δw=22.0787 -> w=0.000  Δrot=0.36798
```

The length solve converges exactly, on its first iteration, splitting 22.762 mm between the ball (10.16 mm) and the anchor (12.16 mm) by inverse mass.
The `spin-rollback` then puts 8.757 mm of the anchor's 12.157 mm back, which is 72% of it, and that re-break is precisely the 8.932 mm the probe shows the unwind being handed.

So the frame is not fighting a solver residual.
It is the designed sequence, working as written, in a geometry where its last stage cannot pay:

1. The aim writes the player's turn.
2. The turn lengthens the chain, because the ball is at the length minimum.
3. The solve pays for it, hauling ball and anchor together.
4. `spinShare` reads the over-length as the spin's, so the rollback takes the anchor's share of the haul back off it, re-breaking the constraint by 8.9 mm.
5. The unwind is handed those 8.9 mm, and at the dead centre the only rotation that buys them is all of it.

Body #124 is a free 43.5 kg body in open flight that no scene chain holds, so `keepsHaul` does not cover it and it is rolled back in full.

### `spinLength` is a linear estimate, and near a stationary point it runs 1.9x hot

`ballLevel.ts:619`:

```ts
const spinLength =
  Math.abs(this.ball.globalRotation - ballRotationAtFrameStart) *
  Math.abs(this.ball.chain.lengthPerRadian(this.ball));
```

That is `|dtheta| * rate`, with the rate taken at the rotation the aim has already turned the ball to, i.e. at the END of the turn.
It is a first-order model of a quantity the frame can measure exactly, and the model is only right while the rate is constant across the turn.
At a stationary point the rate is not constant across the turn: it is zero at one end of it.

At f613, with `rate = 0.04456` and `dtheta = 0.36798`, the rim swept `phi` from 0.0125 to 0.3804 rad:

| | length wound on | `spinShare` |
|---|---|---|
| linear, as coded | `0.36798 * 0.04456` = **16.40 mm** | 16.40 / 22.762 = **0.720** |
| exact, `r * (cos phi_start - cos phi_end)` | **8.57 mm** | 8.57 / 22.762 = **0.377** |

The 0.720 is confirmed independently by the rollback itself: it moved #124 back 8.757 of the 12.157 mm it had been given, which is 0.7203.

So the rollback re-breaks twice the length the turn actually wound on.
This is a real defect on its own and it is not confined to the dead centre: any frame whose spool rate varies materially across the turn is mis-charged, and the error is always in the same direction when the ball is turning away from a stationary point.
It is not, however, the whole of this bug.
Halving the re-break to 4.4 mm still costs about 0.27 rad of the 0.368 rad window, because the relation between rotation and length near the minimum is quadratic.

## The knock-on: the wind-up reverses itself

The lock does not just freeze the ball, it throws the wind-up away.

`BallPlayer.resolveInput` steers on `wrapAngle(toAim.angle() - loopDirection.angle()) * AIM_TURN_GAIN`.
While the rotation is locked the player keeps circling the cursor, so the error grows without the ball ever closing it:

```
f606  err= -46.4 deg   demand  -8.10 rad/s
f609  err= -86.0 deg   demand -15.01 rad/s
f611  err=-119.5 deg   demand -20.85 rad/s
f613  err=-126.5 deg   demand -22.08 rad/s
f614  err=-138.8 deg   demand -24.23 rad/s
f615  err=-165.3 deg   demand -28.86 rad/s
f616  err=+132.8 deg   demand +23.18 rad/s
```

At f616 the error crosses 180 degrees, `wrapAngle` flips it, and the steering drives the ball backwards at +23.2 rad/s.
That is what breaks the lock, and it breaks it the wrong way.

The same wrap fires again at f653, at the top of the wind-up that finally did start: over f637-644 the spool climbs to the rim radius, the chain path grows to 12 nodes as the coil builds, and the ball is hauled from 1.80 m to 0.117 m off its anchor.
Spin goes from -16.7 to +25.3 rad/s in one frame (err -148.3 deg at f652, +144.7 at f653) and the wind-up is discarded.
That second wrap is not the dead centre's doing: the cursor passes 0.333 m from the ball's centre at f652, which swings the aim direction 83 degrees in one frame, and a gain-10 controller whose achieved spin is already 20 to 35 percent short of its demand cannot track that.

## The fix, as far as it has been thought through

Three separable pieces.
They are listed in the order they should be attempted, which is also increasing order of risk.

### 1. Measure `spinLength` exactly

Replace `|dtheta| * rate` with the length the turn actually wound on: the chain path length at `ballRotationAtFrameStart` differenced against the path length now.
`unwindOverLength`'s `excessAt` closure is the pattern, including the `syncCoil()` call that makes a rotated coil measure correctly, and the transform-epoch cache means asking costs nothing.

This is cheap, strictly more correct, and the one piece here that can be justified without a feel judgement.
It diverges every recording that winds chain, so it needs `cli ab --ref HEAD` over `playtests/regressions` and a re-recorded browser bundle, not just a green corpus.

It will not on its own unlock the dead centre.

### 2. The dead centre itself

The honest reading is that the rollback's premise is false here for the same reason it is false for the case `keepsHaul` already carves out.
`docs/ball-chain.md` states it: "A FREE rigid body a scene chain holds is answered by neither, because for it the rollback's premise is simply false."
A free rigid body the ball is hauling on across open air, which no chain holds at all, is not obviously a different animal.

Extending `keepsHaul` to cover it is the shape of the fix, but it must not be written before it is measured, because `session-265f` is exactly what the rollback protects: a rigid polygon RESTING ON THE FLOOR, fed 0.08 m/s a frame and slid 31 cm across the level.
`ridingPath` only tests contact between the anchor and the BALL, so it does not currently distinguish that polygon from this one, and a naive widening would regress it.
The distinguishing fact is whether the anchor has anything to push against, which is a question about the anchor's own contacts rather than about the ball's.

Measure first: put `session-265f` and `session-702f` side by side, print the anchor's contact set and normal impulses on the frames in question, and find out whether "the anchor is in free flight" separates them cleanly.
If it does not, this piece stops here and the plan says so rather than guessing.

### 3. The steering wrap

During a wind-up a demand reversal past 180 degrees is never what the player meant.
The ball is behind the cursor because the chain is refusing its turn, not because the short way round has changed.

The narrow form: while the chain is attached and the frame's turn is being wound on, carry the unwrapped error rather than the wrapped one, so the steering keeps driving the same way instead of flipping.
This is a feel change and falls squarely under the "validate the behaviour before writing the cases" rule in the repo root `CLAUDE.md`.
Get it playtested before any case is written against it.

## Acceptance

- A detector red on `session-702f` before the fix and green after, and proved by temporarily reverting.
  The quantity it should measure is the one that is wrong: a run of frames where the unwind refunds nearly the whole window while the spool rate sits far below the rim, which is a statement about the ball being unable to turn rather than about over-length.
  `roll-unfunded`'s shape is the model - a DRIVE that is re-earned every frame for as long as its cause lasts, so the bar is a run length and not a single frame.
- `session-702f` promoted to `playtests/regressions/`.
- `bun run test` green, and `cli ab --ref <rev>` over the corpus for piece 1, because that piece diverges recordings on purpose.
- A browser bundle recorded against the change and run through `cli diverge`, per the working practice: headless validation cannot see the browser.
- `docs/ball-chain.md` updated in the same change for whatever lands, since every paragraph in it is a postmortem and this is another one.

### What green cannot see

- Whether the ball now turns the way the player expects at the dead centre.
  No invariant fires on this bug today and none of the three fixes above changes that, so the verdict is a playtest.
- Whether piece 3 makes the wind-up feel controllable or merely makes it spin further before the player notices.

## Related history

- `session-315f`: the unwind walking the frame's rotation back every frame, read from the game as the platform turning to ice.
  Fixed by gating the spin's share on the chain being attached (`endFixed`).
  Same symptom, different cause, and the reason the `spinShare` comment block exists.
- `session-337f`: the coupled sweep's `CHAIN_TOLERANCE` billed to the spin, cancelling the ball's entire frame of rotation on 107 of 312 frames, read as a force resisting the turn.
  Fixed by the `forgive` parameter, scoped to a held vine.
  Closest existing precedent for "the rotation is refused for length the spin does not owe", and worth re-reading before piece 1.
- `session-611f` and `plans/unwind-failure.md`: the unwind refunding nothing at 0% for forty frames.
  That is the opposite failure of the same search, and its fix (measuring every candidate with the coil brought to it) is the reason the search is trustworthy enough here to say the problem is upstream of it.
- `session-265f`: the rigid polygon fed the spin's share and slid 31 cm.
  The case piece 2 must not regress.
- `session-149f` and `keepsHaul`, 2026-09-12: the free chain-hung holder that keeps its share of the haul.
  The argument piece 2 wants to extend.
