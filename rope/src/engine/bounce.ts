// How a contact throws back what meets it: the one rule both contact solves
// read - the world's one-pass solve (`World.solveContacts`) and the tied-chain
// island's substepped one (`TieSolver`, which solves the ball's contacts
// whenever its chain is anchored) - and the ball's loop cap and hook besides.
// Its own module because `ties.ts` cannot import from `world.ts`, which
// imports it.

// Approach speed (m/s) below which a contact earns no ELASTIC bounce at all.
//
// Without it, any restitution above zero makes resting contacts micro-bounce for
// ever on the velocity gravity re-adds each frame - the contact reflects it, the
// next frame's gravity puts it back, and a body that should be asleep hums.
// Every engine gates restitution this way. Default restitution is 0 and
// rigid-rigid contacts have never had any, so with the shipped defaults this
// costs nothing; it is here so that turning restitution on is not a trap.
export const RESTITUTION_THRESHOLD = 1;

// The outgoing normal speed a contact is solved toward: the elastic bounce the
// pair's restitution earns, or the surface's own launch, whichever is larger.
// `approach` is the closing speed at the point (positive when the two are
// coming together).
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
export function contactBounce(approach: number, restitution: number, launch: number): number {
  const elastic = approach > RESTITUTION_THRESHOLD ? restitution * approach : 0;
  return launch > 0 ? Math.max(elastic, launch) : elastic;
}
