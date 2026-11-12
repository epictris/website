// How a contact throws back what meets it: the one rule both contact solves
// read - the world's one-pass solve (`World.solveContacts`) and the tied-chain
// island's substepped one (`TieSolver`, which solves the ball's contacts
// whenever its chain is anchored) - and the ball's loop cap and hook besides.
// Its own module because `ties.ts` cannot import from `world.ts`, which
// imports it.

import { Density, sphereMass } from "../lib/shapeGeometry";

// Approach speed (m/s) below which a contact earns no ELASTIC bounce at all.
//
// Without it, any restitution above zero makes resting contacts micro-bounce for
// ever on the velocity gravity re-adds each frame - the contact reflects it, the
// next frame's gravity puts it back, and a body that should be asleep hums.
// Every engine gates restitution this way. Default restitution is 0 and
// rigid-rigid contacts have never had any, so with the shipped defaults this
// costs nothing; it is here so that turning restitution on is not a trap.
export const RESTITUTION_THRESHOLD = 1;

// The mass of a launch surface's FACE, kg: the iron ball's (a 12 cm cast-iron
// sphere, `BallPlayer.DENSITY` at the level's radius), so that the ball leaves a
// pad at exactly the pad's authored `launch`.
//
// Every pad in `ball.json` was tuned with the ball as the only thing that would
// touch it, so `launch` is "the speed this pad throws the ball". Since roots,
// vines and rigid bodies meet pads too, a pad no longer throws everything at
// that speed: its face is a mass `M` moving out at `launch`, and what it gives a
// body of effective mass `m` at the contact is an elastic hit from that face,
// `2·M·launch / (M + m)`. The ball (`m = M`) leaves at `launch`; a heavier body
// slower (a 105 kg root at 0.66x), a lighter one faster but never past twice it
// (a 1.7 kg cuff at 1.94x). The island pays a launch after its substeps,
// against each contact's FREE-BODY mass (`applyRestitution`), so a jointed body
// is thrown as if loose and its joints take the excess back the next frame; a
// throw that is an IMPULSE is what survives that, since a hinge's reaction acts
// through the hinge point and cannot touch the angular momentum the impulse gave
// the body about it. A 33 kg root segment hinged to a static, its chain let go,
// leaves `session-406f`'s mushroom at 10.9 rad/s (660 J) where the speed floor
// left it at 9.0 (440 J); with the ball still hanging from it, most of either
// throw goes into yanking the ball up through the chain (3.3 rad/s, 2.7 before).
//
// Struck from rest: the arrival is the restitution's business (below), never
// the face's. An elastic hit off a face that is always moving at `launch` hands
// a body lighter than the face up to 2·launch MORE on every bounce, and a link
// bouncing on a pad would pump itself without limit.
export const LAUNCH_FACE_MASS = sphereMass(0.12, Density.CAST_IRON);

// The normal speed a launch surface throws a body of this contact's effective
// mass with, from rest: `invEffN` is the contact's inverse effective mass along
// its normal, both bodies, as the solve that pays it computes it.
export function launchThrow(launch: number, invEffN: number): number {
  const ratio = LAUNCH_FACE_MASS * invEffN;
  return (2 * ratio * launch) / (ratio + 1);
}

// The outgoing normal speed a contact is solved toward: the elastic bounce the
// pair's restitution earns, or the surface's own launch, whichever is larger.
// `approach` is the closing speed at the point (positive when the two are
// coming together), and `invEffN` the contact's inverse effective mass along
// the normal, which a launch is weighed against (`launchThrow`).
//
// One function, called by both solves, by `BallPlayer.applyLoopCap` and by
// `BallHook.bounce`, because the cap's whole job is to hold a loop landing to
// what the ball's own arrival was worth - and it can only do that if it
// computes "what was that worth" the same way the solve does.
//
// THE DEAD ZONE is `RESTITUTION_THRESHOLD` and it gates the restitution only:
// below it a contact earns no elastic bounce, so a body resting on an ordinary
// lively surface does not re-bounce for ever on the velocity gravity re-adds
// each frame.
//
// A LAUNCH HAS NO DEAD ZONE AND NO RAMP. Nothing may rest on a launch surface:
// whatever touches it is thrown at the full launch speed, however gently it
// arrived, and whether or not a chain holds it. A pad that hums under a resting
// body is exactly what is asked for - the body cannot be resting there. An
// earlier version faded the launch in between 1 and 2 m/s of approach so that
// a body could settle on a pad, and a ball dropping 8 cm onto one left at 1.7
// m/s where the same pad threw a 25 cm drop at 10 m/s (`session-188f` f42
// against f135). Whether a contact touches at all - and so pays the launch - is
// each solve's question, not this one's.
//
// `launch <= 0` returns the elastic answer by the same arithmetic the solver
// used before launches existed, which is what keeps every recorded replay -
// none of which authors a launch - bit-identical.
export function contactBounce(approach: number, restitution: number, launch: number, invEffN: number): number {
  const elastic = approach > RESTITUTION_THRESHOLD ? restitution * approach : 0;
  return launch > 0 ? Math.max(elastic, launchThrow(launch, invEffN)) : elastic;
}
