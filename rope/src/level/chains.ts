// Scene chains - a chain strung between two authored bodies, solved by the same
// wrap-point rope the grapple and the ball & chain hang on.
//
// There is deliberately no new physics here. `Rope` already models a rope as a
// sequence of wrap points between two `RopeContact`s on arbitrary bodies, moves
// whatever dynamic bodies lie on its path and leaves statics alone as infinite
// mass, so a scene chain is that class with both ends pinned at load instead of
// one end being a hook in flight. A rigid body on either end therefore hangs,
// swings and is hauled by the chain; a static or an `anchor` simply holds it.
//
// What a chain is NOT is collision geometry: nothing stands on it, and another
// rope does not wrap it. It is a constraint between two bodies plus the drawing
// of that constraint. (Both would need the chain to be a body per link - see
// docs/game-design.md.)
//
// A chain is scenery, and scenery is all it is: it is solved against nothing but
// the two bodies it is tied to, so it hangs and swings and hauls those two and
// passes through everything else, and it is drawn behind the level's geometry to
// say so. There was briefly a second, "foreground" kind that the whole scene was
// solved against - the avatar and its hook could push into it and be held by it -
// and it was dropped: it bought little that a body does not already buy, and it
// paid for that by making every chain a thing the player might silently snag on.

import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D, PhysicsBody2D } from "../engine/body";
import { nearestShapeIndex, nearestSurfacePoint } from "../engine/shapes";
import { Rope } from "../classes/rope";
import { RopeContact } from "../lib/ropeContact";
import { type ChainData, type LevelData } from "./levelFormat";

// The wrap-candidate list a chain solves against: nothing. Its two anchor bodies
// are already the ends of every span, and `Rope.regeneratePath` never wraps a
// span around the bodies that span starts and finishes on, so an empty scene is
// exactly "hangs between its two bodies and touches nothing else".
const NOTHING: PhysicsBody2D[] = [];

export class SceneChain {
  readonly rope: Rope;
  // Authored fill for the links; null = the renderer's own chain colours.
  readonly color: string | null;

  constructor(a: RopeContact, b: RopeContact, length: number, color: string | null) {
    this.rope = new Rope(a, b, null, length);
    this.color = color;
  }

  // Open this chain's frame. Once per frame, however many solve passes follow.
  beginFrame(delta: number): void {
    this.rope.beginFrame(delta);
  }

  // One solve pass. Called after `World.integrate`, so the constraint has the
  // last word on where the bodies it holds end up - the same order the ball
  // controller runs its chain in, and for the same reason (solve before
  // integration ends every fast frame over-length by |v|·dt).
  solve(delta: number): void {
    this.rope.solvePass(NOTHING, delta);
  }
}

// How far over its length any chain may end a frame. This is the statement the
// sweep loop below is written against, and it is what "the chain does not
// stretch" means: 5 mm is half a pixel at PIXELS_PER_METER, i.e. under what the
// renderer can show.
const CHAIN_TOLERANCE = 0.005;

// Sweeps the tolerance may spend getting there. A ceiling, not a target - a rig
// that converges leaves the loop on the sweep it converges on, which for the
// single-chain rigs that are most of every level is the first one.
//
// Measured on the ball arena's hanging weight (a link on one chain, a 476 kg
// slab on two more), worst over-length over a settled 300-frame window, and the
// wall clock for 900 frames of all three chains:
//
//   sweeps   over-length   cost
//        1       125 mm      -
//        4        73 mm     84 ms
//       16        22 mm    125 ms
//       32        11 mm    208 ms
//       64       5.2 mm    394 ms
//      128       2.2 mm    786 ms
//
// It halves per doubling and does not stall, so the cap is a straight choice of
// how much to spend: 64 reaches the tolerance on that rig (4.99 mm) for 0.55 ms
// a frame, against a 16.7 ms budget.
//
// The cap and not the tolerance is therefore what a hard rig gets, and it is
// meant to be: convergence rate falls with the chains' angle, because a shallow
// V carries a far bigger tension for the same weight. `cli contacts`
// `chain-order` is one at 14 degrees off horizontal, and it wants ~200 sweeps
// for 5 mm - 1.7 ms a frame for a piece of scenery. It gets 64 and ends 15 mm
// over, against 191 mm at one sweep. Authoring the chains steeper is worth more
// there than any cap this side of sane, and a rig that will not converge is
// bounded rather than silently expensive.
const MAX_CHAIN_SWEEPS = 64;

// One frame of every scene chain, as ONE system rather than as a list of
// independent ropes.
//
// Each chain is a full PBD solve that writes positions and credits itself
// velocity, so a single pass in list order is Gauss-Seidel with one iteration:
// the first chain solves against the state gravity left, moves both of its
// bodies, and the next solves against a scene the first has already displaced.
// Its correction is then the last word, and the residual is whatever the earlier
// chains wanted and did not get.
//
// That residual is not small and it does not wash out. A weight hung from a link
// by two chains - one pair of bodies, two constraints, which is what any bridle
// or swing seat is - leaned 18 cm off centre with its link tilted 18 degrees, in
// a rig symmetrical to the millimetre. Swapping the two chains' order in the
// level file mirrored the result exactly, digit for digit, which is the whole
// diagnosis: nothing about the geometry chose that side, the array order did.
// Worse, the residual is re-injected every frame, so the rig also rang at
// 0.085 m/s for ever instead of settling.
//
// Sweeping the set repeatedly is the standard answer (this is what iteration
// count is FOR in every impulse or PBD solver), and the direction alternates so
// the order bias of one sweep is the mirror of the next's rather than the same
// one compounded. The bias stays order-driven at any sweep count - swapping the
// file's chains still mirrors the answer - but a converged set leaves it the
// size of a solver residual rather than the size of the level, and the rig
// settles instead of ringing.
//
// The same residual is what the chains look like they are made of. Each solve
// pins its own chain to exactly its length (`relaxationFactor` is 1, and a lone
// chain measures 0.00 mm of stretch under any load at all), but the chain solved
// after it moves the bodies they share and stretches the first one back out. On
// the ball arena's hanging weight that was 73 mm on a 1.03 m chain - 7%, read
// from the game as the chain being made of elastic. It is not: it is the set
// being left unconverged, and it does not care how heavy the weight is (the same
// rig at 4x the mass stretches by the same 72.72 mm, since a PBD position
// correction is written in mass ratios).
//
// So the loop runs to the RESIDUAL rather than to a count: sweep until no chain
// is more than `CHAIN_TOLERANCE` over its length, up to `MAX_CHAIN_SWEEPS`. What
// that buys over a fixed count is both ends at once - the single-chain rigs that
// are most of every level converge on the first sweep and pay for one, and a
// coupled rig spends what it actually needs instead of what looked reasonable
// when the constant was written.
//
// `beginFrame` stays outside the loop: it releases the blocked-length lease, and
// a lease released once per PASS would be handed back a sweep's worth faster
// than the geometry that bought it can re-earn it.
export function stepSceneChains(chains: readonly SceneChain[], delta: number): void {
  if (chains.length === 0) return;
  for (const chain of chains) chain.beginFrame(delta);
  sweepChains(chains, null, delta);
}

// The sweep itself, over a set whose frames are already open, plus optionally
// one more rope that is NOT scenery: the ball's chain, when it is anchored to a
// body a scene chain also holds.
//
// That rope belongs in this loop for exactly the reason the scene chains belong
// in it with each other - they share a body, so each one's solve is the last
// word on where that body ends up and the other's correction is the residual.
// Left out of it, the ball's chain solved once, after the set had converged, and
// the two spent every frame undoing each other: the ball arena's link block was
// moved 10 mm and 0.15 rad one way by its three chains and 11 mm and 0.17 rad
// back by the ball's, frame after frame, for ever (session-521f).
//
// The cost of that is not the shaking, which nets out in position. It is that a
// PBD correction is split between the bodies on the path by their INVERSE MASS,
// and the ball's chain, solving alone, split it against the link's own 11 kg
// rather than against what the link is actually tied to. Four fifths of every
// winch correction was therefore spent moving an anchor that three other chains
// put straight back, and the ball - which is what winding chain onto yourself is
// supposed to haul - kept a fifth. Swept together, the scene chains refuse the
// anchor within the frame and the next pass puts the correction where it can
// still go, which is the ball: a light anchor on a chain went from 7 cm of winch
// travel to 137 cm (`playtests/ball-winch-hung-anchor.json`), against 136 cm for
// the same rig anchored to a static, which is the statement - how far a winch
// hauls must not depend on what is holding the far end.
export function sweepChains(
  chains: readonly SceneChain[],
  extra: { rope: Rope; bodies: PhysicsBody2D[] } | null,
  delta: number,
): void {
  for (let sweep = 0; sweep < MAX_CHAIN_SWEEPS; sweep++) {
    if (sweep % 2 === 0) {
      for (let i = 0; i < chains.length; i++) chains[i]!.solve(delta);
    } else {
      for (let i = chains.length - 1; i >= 0; i--) chains[i]!.solve(delta);
    }
    if (extra) {
      // What the scene's pass has just done to the rope being coupled in, and
      // the ONLY thing this loop measures convergence by: the two are done
      // arguing once the scenery stops disturbing the rope, whatever the
      // scenery's own residual is.
      //
      // Gating on that residual instead is gating on a property of the LEVEL,
      // not of the coupling. The ball arena's rig wants ~200 sweeps for 5 mm and
      // gets 64 (see above), so the set is over its tolerance on essentially
      // every frame - 1616 of 1618 - and a loop waiting for it always spends the
      // whole cap. What it spends it on is a ball chain solve, which regenerates
      // a wrap path and is an order dearer than a scene chain's: it doubled the
      // arena's physics frame (p50 2.3 ms to 3.7, p99 5.2 to 8.9, peaks at
      // 15.3 against a 16.7 ms budget the renderer also draws inside) for sweeps
      // that had stopped changing the answer after the first (session-1618f).
      const disturbed = extra.rope.overLength;
      // Solved last, so the frame ends on the rope whose books the caller takes:
      // `BallLevel` credits the ball for the position the chain phase leaves it
      // at, and a scene chain solving after it would move the anchor out from
      // under that measurement.
      extra.rope.solvePass(extra.bodies, delta);
      if (disturbed <= CHAIN_TOLERANCE) break;
      continue;
    }
    // Measured after the sweep, so a set that is already satisfied still pays
    // one solve - the sweep is what discovers that, and gravity has moved the
    // bodies since the last one.
    let worst = 0;
    for (const chain of chains) worst = Math.max(worst, chain.rope.overLength);
    if (worst <= CHAIN_TOLERANCE) break;
  }
}

// The authored anchor point pushed onto the body's own surface - the nearest
// point of the nearest of its shapes. A chain is bolted to a surface, so this is
// what the anchor means; it is also what keeps the solver sane, since an anchor
// in a body's interior leaves the span starting *inside* that body and the wrap
// generator resolves that as a self-intersection, winding the chain around its
// own anchor (see `nearestOnOutline`). It is applied at load rather than trusted
// from the file so a hand-edited level cannot author the degenerate case.
function snapToSurface(obj: CollisionObject2D, world: Vec2): Vec2 {
  const shapes = obj.getShapes();
  const s = shapes[nearestShapeIndex(shapes, world)];
  return s ? nearestSurfacePoint(s, world) : world;
}

// Build every chain in `data` (metres) against the bodies `buildLevelBodies`
// made. A chain naming a body index that built nothing, or naming the same
// engine body at both ends (a chain tied to itself - which two members of one
// compound group are), is dropped rather than fed to a solver that has no
// meaning for it.
export function buildSceneChains(
  data: LevelData,
  byIndex: readonly (CollisionObject2D | null)[],
): SceneChain[] {
  const chains: SceneChain[] = [];
  for (const c of data.chains ?? []) {
    const chain = buildOne(c, byIndex);
    if (chain) chains.push(chain);
  }
  return chains;
}

function buildOne(
  c: ChainData,
  byIndex: readonly (CollisionObject2D | null)[],
): SceneChain | null {
  const objA = byIndex[c.a.body] ?? null;
  const objB = byIndex[c.b.body] ?? null;
  if (!objA || !objB || objA === objB) return null;
  const worldA = snapToSurface(objA, new Vec2(c.a.x, c.a.y));
  const worldB = snapToSurface(objB, new Vec2(c.b.x, c.b.y));
  // Absent length = exactly taut as authored, which is what dragging a chain out
  // between two bodies in the editor means - measured between the anchors as
  // they actually land, so "taut" is taut.
  const length = c.length ?? worldA.distanceTo(worldB);
  // `RopeContact.at`: the anchor names the piece of the body it lands on, which
  // is what the wrap resolvers walk when the chain has to bend around it.
  return new SceneChain(
    RopeContact.at(objA, worldA),
    RopeContact.at(objB, worldB),
    length,
    c.color ?? null,
  );
}
