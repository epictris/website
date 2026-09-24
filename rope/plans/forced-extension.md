# TODO: the chain being forcibly extended

Status: a note, not a plan.
Recorded 2026-09-23, not to be tackled in that session.
The belt tear-out (`docs/conveyors.md`, "The tear-out") is a special case of this and is kept; what is wanted is the general answer, and the tear-out should become one instance of it.

## The problem

When the anchor end of the chain is carried away by something the solver cannot argue with, and the ball end cannot follow, the chain has to give somewhere.
Today it gives at the stall lease: `Rope.blockedSlack` is re-derived from the geometry every frame, so a blocked correction is leased out again every frame, and a carrier that never stops carrying grows the constraint length without bound.
The lease was designed for a block that EASES (a ball pinned against scenery while retracting, `docs/ball-chain.md`) and is released at a bounded rate when it does.
A block that never eases is outside what it was designed for.

Carriers that can do this:

- a conveyor's ride (`RopeRide`): the anchor moves at belt speed for ever;
- a scripted mover with the anchor on it (pendulum, rotor, traveller): the anchor moves on the level's authority, and a ball wedged behind scenery cannot follow (nobody has recorded this one yet, but nothing in the lease distinguishes it from the belt);
- a rail clamp run off an open end, or a heavy rigid body falling away with the anchor, are the same shape with a finite budget.

## The evidence

`session-160f` (a browser bundle on `TEST_BELT`, 2026-09-23, bit-exact on tree `9e9a9a58959a`):

- the ball, hooked to belt A's top run, rode off the end onto the floor; the anchor went round the end roller onto the return run and dragged the ball back toward the belt;
- the belt's underside is 20 cm above the floor and the ball is 24 cm across, so at f118 the ball stopped against the end roller at the mouth of the gap;
- f119 to f130: the length solve moved the ball 24.8 mm toward the anchor every frame, the second push-out gave exactly that back (`push=24.89mm` in `cli query`), and the lease grew 25 mm a frame, one frame of belt travel;
- f130: lease 22 cm; f131: the tear-out fired (`tearOffOverdrawnRide`, threshold `ATTACH_SNAP_TOLERANCE` 20 cm) and the cuff became a dangling tip.

Before the tear-out existed, the headless run of the same jam grew the chain from 1.80 m to 3.04 m in 300 frames (`rope-grew` violations from f291).

## What a general answer has to decide

- **What gives.** The hook lets go (the tear-out, an authored feel: a cuff ripped out of the belt), or the carrier is refused (impossible for a belt or a mover: authority is the point of them), or the ball is dragged through whatever blocks it (impossible: it is scenery), or the chain breaks.
  For a driven carrier the only honest outcomes are the hook letting go and the chain breaking.
- **When.** The tear-out fires on a LEASE past a length.
  The lease is a proxy for tension the solver cannot express: the ball is pinned, so no force is measured, only a displacement refused.
  A general rule wants a tension-like quantity that every carrier produces the same way: the refused correction per frame times the frames it persists, or the lease itself, but named as such and applied to every carried anchor, not to rides only.
  `docs/breakable.md` already has tension-breaking listed as open; the two are one problem.
- **Where it is read.** The tear-out is called from `BallLevel` at the top of the frame for a ride.
  The general version belongs where the lease is measured (`Rope.absorbBlockedLength` and the stall bookkeeping), so a mover-carried anchor and a belt-carried one are judged by one number.
- **What the player sees.** A tear is silent today.
  Whatever fires should be an event the renderer can spark on, the way hook-proof steel sparks (`docs/sparks.md`).

## Not decided

- Whether the threshold is a length (20 cm, borrowed from the attach snap) or a time (nine frames at 1.5 m/s felt quick).
- Whether a mover-carried anchor should ever let go, or whether that is the level author's problem (a pendulum swinging the anchor behind a wall is a level bug, a belt running for ever is not).
- Whether `rope-grew` should fire on a lease that grows monotonically for more than N frames regardless of what carries it, so the class is caught before a level ships it.

## Where to start when it is picked up

1. Record a mover carrying an anchor away from a wedged ball (`TEST_SWING` or a rotor) and confirm the lease grows the same way; that makes it a class and not a belt bug.
2. Move the tear decision from `BallLevel.tearOffOverdrawnRide` to the lease, keyed on "carried anchor" rather than "ride", with the belt case as the first regression (`session-160f` replays bit-exact today and would be the red-then-green bundle).
3. Add the spark.
