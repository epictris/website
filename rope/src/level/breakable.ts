// Breakable geometry: scene bodies that take a beating and then come apart.
//
// A body authors two numbers (`LevelBodyData.breakForce` / `durability`): how
// hard a hit has to be to hurt it, in newtons, and how many such hits it
// survives. When the count runs out the body LEAVES THE WORLD, and what the
// player sees is a shower of chunks the render side throws (`render/debris.ts`)
// from the one fact the sim contributes - a `BreakEvent`.
//
// The fragments are never bodies. Debris that can be stood on, hooked, wrapped
// and knocked about is a second level's worth of physics for a second of
// spectacle, and this way a wall that breaks costs the frame after it exactly
// what a wall that was never there costs.
//
// WHAT IS MEASURED is the solver's own accumulated normal impulse over the step
// (`ContactConstraint.normalImpulse`), divided by the step to be the force the
// threshold is written in. It is the honest quantity and it is already computed:
// the same number `BodyDigest.contactPn` records, which is what makes a break
// readable from a recorded bundle without re-simulating it.
//
// The whole mechanism is behind `breakForce === 0`, which is every body of
// every level authored before it, so a level with no breakable geometry pays
// one test per contact and keeps every recorded replay bit-identical.

import type { CollisionObject2D, PhysicsBody2D } from "../engine/body";
import type { Vec2 } from "../engine/vec2";
import type { ContactConstraint, World } from "../engine/world";
import type { Rope } from "../classes/rope";
import type { RopeContact } from "../lib/ropeContact";

// One body coming apart, as the facts the sim had in hand.
//
// The BODY rather than a copy of its geometry: it has been removed from the
// world by the time this is read, but the object is intact and is the only
// thing that knows its own outline, its colour and how fast it was going. The
// render side takes what it needs when it ingests the event and keeps nothing
// afterwards, exactly as the spark system does with a contact (see
// `level/sparkEvents.ts`) - and, like a spark, nothing in the sim ever reads
// one back.
export interface BreakEvent {
  readonly body: CollisionObject2D;
  // World metres: where the finishing hit landed.
  readonly point: Vec2;
  // Out of the BROKEN body's surface, whichever side of the contact pair it
  // was. So the blow came from `+normal` and was travelling along `-normal`,
  // which is the way the chunks are thrown.
  readonly normal: Vec2;
  // Newtons the finishing hit carried, and never less than the threshold it
  // broke. How much MORE than the threshold is what sizes the debris: a wall
  // that gives way to the last of ten taps should not explode like one a slam
  // went through.
  readonly force: number;
  // The threshold it was authored with, so the render side can read the force
  // as a multiple of it without reaching back into the body.
  readonly threshold: number;
}

// Below this fraction of the threshold a pair has stopped hitting and is armed
// again. A plain "back under the threshold" re-arms on the solver's own flicker
// - the load on a body settling onto a face crosses and re-crosses its own mean
// for a dozen frames - and every crossing would be another hit.
const REARM_FRACTION = 0.5;
// ...and for this many consecutive frames, for the same reason one frame under
// the bar is not the end of a strike.
const REARM_FRAMES = 3;
// Consecutive frames a pair may go untouched before it is forgotten entirely,
// which is the same as being armed. It only stops the map growing over a
// session (`CONTACT_TRACK_TTL` in `render/sparks.ts` exists for the same
// reason), so it is well past `REARM_FRAMES` and can never be what decides
// whether a touch is a fresh hit.
const TRACK_TTL = 60;

// What one pair - a breakable body and one thing pressing on it - is up to.
interface PairState {
  // In a strike: the load has crossed the threshold and has not yet let go, so
  // the hit has been counted and must not be counted again.
  hot: boolean;
  // Consecutive frames under `REARM_FRACTION` of the threshold.
  cool: number;
  // The last frame this pair carried any load at all, for the TTL sweep.
  seen: number;
}

// This frame's load from one striker, accumulated over every piece of the
// breakable body it is pressing on: a crate landing flat on a floor makes two
// contact points and hit it ONCE, with the sum of them.
interface PairLoad {
  body: CollisionObject2D;
  other: CollisionObject2D;
  impulse: number;
  // The deepest-loaded point of the pair, which is where the debris comes from.
  point: Vec2;
  normal: Vec2;
  best: number;
}

// The per-pair accounting, kept across frames and owned by the level.
//
// Its map is keyed by a pair of body ids and is only ever LOOKED UP by a scan
// that walks `World.frameContacts` in the solver's own order, so its iteration
// order reaches no decision the sim makes - the same care `World.contactCache`
// is written with.
export class BreakTracker {
  private readonly pairs = new Map<string, PairState>();
  private readonly loads = new Map<string, PairLoad>();
  private frame = 0;

  // Count this frame's hits and return the bodies they finished off, in the
  // order the contacts reported them.
  //
  // Called at the END of a level's step, after every phase that holds body
  // references has run: what it returns is removed from the world, and a body
  // taken out from under the chain phase mid-frame is a dangling reference in
  // whatever was mid-solve. The contacts it reads are this frame's and are not
  // touched by the wait.
  scan(world: World, dt: number): BreakEvent[] {
    this.frame++;
    this.loads.clear();
    for (const c of world.frameContacts) {
      if (c.normalImpulse <= 0) continue;
      // Either side of the pair may be the breakable one, and both may be: a
      // rotten crate dropped on a rotten floor breaks whichever of them the
      // blow was too much for.
      this.accumulate(c, c.a, c.b, false);
      this.accumulate(c, c.b, c.a, true);
    }

    const events: BreakEvent[] = [];
    for (const load of this.loads.values()) {
      const body = load.body;
      // Already finished off, by a striker earlier in this same frame: a floor
      // hit by two things at once breaks once, and one that has broken takes no
      // further hits from anything.
      if (body.impactHits >= body.durability) continue;
      const key = pairKey(body, load.other);
      let state = this.pairs.get(key);
      if (state === undefined) {
        state = { hot: false, cool: 0, seen: this.frame };
        this.pairs.set(key, state);
      }
      state.seen = this.frame;
      const force = load.impulse / dt;
      if (force >= body.breakForce) {
        state.cool = 0;
        // ONE hit per strike, however many frames it takes to land. A body
        // resting on a breakable floor presses on it over the threshold every
        // frame for as long as it sits there, and counting those is a floor
        // with a durability of ten that survives a sixth of a second.
        if (state.hot) continue;
        state.hot = true;
        body.impactHits++;
        if (body.impactHits < body.durability) continue;
        events.push({
          body,
          point: load.point,
          normal: load.normal,
          force,
          threshold: body.breakForce,
        });
        continue;
      }
      if (force < body.breakForce * REARM_FRACTION) {
        cool(state);
      } else {
        // Between the two bars: neither a fresh hit nor the end of one. The
        // band is what stops the solver's own flicker either side of a settling
        // load being read as a drum roll.
        state.cool = 0;
      }
    }

    this.sweep();
    return events;
  }

  // Every pair this frame's contacts did NOT mention, and then the ones that
  // have been quiet long enough to forget.
  //
  // A pair that has stopped touching cools exactly as one pressing gently does,
  // and it has to: a ball bouncing on a breakable floor is in the air between
  // strikes, so a pair that only cools while it is in contact stays hot through
  // the whole bounce and the second landing counts for nothing. Three frames of
  // silence is 50 ms, which no real bounce is shorter than and no solver
  // flicker is longer than.
  //
  // The TTL is a different statement and a much slower one: it only stops the
  // map growing over a session, and by the time it fires the pair has been cold
  // for a second.
  private sweep(): void {
    if (this.pairs.size === 0) return;
    for (const [key, state] of this.pairs) {
      if (state.seen !== this.frame) cool(state);
      if (this.frame - state.seen >= TRACK_TTL) this.pairs.delete(key);
    }
  }

  private accumulate(
    c: ContactConstraint,
    body: CollisionObject2D,
    other: CollisionObject2D,
    flip: boolean,
  ): void {
    if (body.breakForce <= 0 || body.removed) return;
    const key = pairKey(body, other);
    const held = this.loads.get(key);
    if (held === undefined) {
      this.loads.set(key, {
        body,
        other,
        impulse: c.normalImpulse,
        point: c.point,
        // `frameContacts` orients every normal out of `b` toward `a`, so it
        // already points out of the breakable body when the breakable one is
        // `b`, and has to be turned around when it is `a`.
        normal: flip ? c.normal : c.normal.neg(),
        best: c.normalImpulse,
      });
      return;
    }
    held.impulse += c.normalImpulse;
    if (c.normalImpulse > held.best) {
      held.best = c.normalImpulse;
      held.point = c.point;
      held.normal = flip ? c.normal : c.normal.neg();
    }
  }
}

function pairKey(body: CollisionObject2D, other: CollisionObject2D): string {
  return `${body.id}:${other.id}`;
}

// One frame of not-hitting. `REARM_FRAMES` of them and the next load over the
// threshold is a fresh hit.
function cool(state: PairState): void {
  if (!state.hot) return;
  state.cool++;
  if (state.cool < REARM_FRAMES) return;
  state.hot = false;
  state.cool = 0;
}

// Take a broken body out of the level: out of the world, and out of the body
// list the rope is handed as its scene (which is MUTATED rather than replaced -
// `BallPlayer.sceneBodies` holds the array itself).
//
// Wrap nodes riding it need nothing here: every rope drops its own nodes on a
// removed body at the top of its next regeneration (`Rope.dropWrapsOnGoneBodies`),
// which is where a body that leaves the world has always been answered. What
// does need saying is the ANCHOR, and that is the caller's - a chain whose far
// end was on this body is released by whoever owns the chain.
export function removeBrokenBody(
  world: World,
  bodies: PhysicsBody2D[],
  body: CollisionObject2D,
): void {
  world.remove(body);
  const i = bodies.indexOf(body as PhysicsBody2D);
  if (i >= 0) bodies.splice(i, 1);
}

// Breakable bodies an authored chain or a vine hangs FROM are not breakable.
//
// A `SceneChain`'s ends and a vine's anchor are fixed at construction and never
// re-anchor, so a body that leaves the world under one leaves a constraint
// solving against a contact on nothing. The level file is where that is stated
// wrong, so it is said out loud at build and the threshold is dropped: the
// geometry still plays, it simply cannot break.
//
// Only the ends. A chain that WRAPS a breakable body is fine, and deliberately
// so - the rope drops its own nodes on a body that has left the world, so a
// chain draped over a ledge that gives way simply falls off it.
export function guardBreakables(
  chains: readonly { readonly rope: Rope }[],
  vines: readonly { readonly anchorContact: RopeContact; readonly anchor2Contact: RopeContact | null }[],
): void {
  const unbreak = (anchor: CollisionObject2D): void => {
    if (anchor.breakForce <= 0) return;
    console.warn(
      `[breakable] body ${anchor.buildIndex} has a chain or vine anchored to it, so it cannot break (a constraint cannot outlive the body it hangs from); its threshold is ignored.`,
    );
    anchor.breakForce = 0;
  };
  for (const chain of chains) {
    unbreak(chain.rope.start.contact.obj);
    unbreak(chain.rope.end.contact.obj);
  }
  for (const vine of vines) {
    unbreak(vine.anchorContact.obj);
    if (vine.anchor2Contact) unbreak(vine.anchor2Contact.obj);
  }
}
