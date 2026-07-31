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

  // One frame of the chain. Called after `World.integrate`, so the constraint
  // has the last word on where the bodies it holds end up - the same order the
  // ball controller runs its chain in, and for the same reason (solve before
  // integration ends every fast frame over-length by |v|·dt).
  physicsStep(delta: number): void {
    this.rope.beginFrame(delta);
    this.rope.physicsStep(NOTHING, delta);
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
