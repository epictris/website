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
// A chain is scenery in what it is drawn behind and in what may touch IT, and
// it is level geometry in what it bends around: its spans are solved against the
// level's wrappable bodies - the statics and the authored rigid bodies, the same
// scene the ball's chain scans (`BuiltBodies.wrapBodies`) - so a chain that
// swings across a post catches on the post's corner and hangs its load from
// there, exactly as the ball's chain would. What it is solved against is NOT
// the avatar or its hook: those are in the play space and a chain is not, so
// nothing the player does can snag on a chain. (There was briefly a
// "foreground" kind the whole scene, avatar included, was solved against, and
// it was dropped for that reason; and for a while after it a chain was solved
// against nothing at all but the bodies its wrap points named, which read as
// the chain being drawn through a pillar it plainly ran into - `session-497f`,
// a weight hung beside a post on a chain over a pulley, the chain cutting
// straight through the post's top as the weight fell past it.)
//
// A wrap point (`ChainData.via`) is the authored route: an anchor the chain is
// routed OVER, which at load becomes an ordinary wrap node on the corner of the
// piece it sits on. From then on it is the same wrap the ball's chain finds by
// scanning - regenerated as the bodies move, culled if the chain ever pulls
// straight past it - which is what a chain over a beam or a pulley does. The
// authoring exists because the scan cannot find it: a chain hung from a hub up
// over a beam and down to a load is, as a straight line, nowhere near the beam.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { RopeVineClamp } from "../lib/vineClamp";
import { RAIL_KINETIC_FRICTION, RAIL_STATIC_FRICTION, RopeClamp } from "../lib/rail";
import { creepSpeed } from "../lib/viscous";
import { MANACLE_REACH } from "../lib/manacle";
import { CHAIN_LINK_BAR } from "../render/chainMetrics";
import {
  AnimatableBody2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  type CollisionObject2D,
  type CollisionShape2D,
} from "../engine/body";
import { nearestShapeIndex, nearestSurfacePoint } from "../engine/shapes";
import {
  CONTACT_SLOP,
  GRAVITY,
  type ContactConstraint,
  type World,
} from "../engine/world";
import { Rope } from "../classes/rope";
import { RopeContact, RopeWrap } from "../lib/ropeContact";
import { Segment } from "../lib/segment";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Intersections } from "../lib/intersections";
import { RopeGeneration } from "../lib/ropeGeneration";
import { Calc } from "../lib/calc";
import { GenerationDirection, IntersectionStatus, WrapDirection } from "../lib/types";
import {
  DEFAULT_TIE_SUBSTEPS,
  MAX_TIE_SUBSTEPS,
  TieChain,
  TieTuning,
  TiePoint,
  invInertiaOf,
  invMassOf,
  islandOwns,
  ropeImpulse,
  type IslandRow,
  type IslandUnit,
  type Softness,
  type TieSolver,
} from "../engine/ties";
import type { RopeRowTerm } from "../classes/rope";
import { localPlacement, worldPlacement, type BuiltBodies } from "./buildBodies";
import {
  isAnchorObject,
  type AnchorObjectData,
  type ChainData,
  type LevelData,
} from "./levelFormat";

// The wrap-candidate list for a constraint that bends around nothing: a vine's
// pair chain, or a `SceneChain` built by hand with no scene to give it. A rope's
// two anchor bodies are already the ends of every span, and
// `Rope.regeneratePath` never wraps a span around the bodies that span starts
// and finishes on, so an empty scene is exactly "hangs between its two bodies
// and touches nothing else". An AUTHORED chain is not built with this: see
// `buildSceneChains`.
export const NOTHING: PhysicsBody2D[] = [];

// An authored chain: a `Rope` between two bodies, solved as a row of the
// world's island solver (`RopeRow`) with the bodies it holds, their contacts
// and any other row on them. Registered with the world's solver as it is
// built, so a chain is never without a solver: every caller that builds one -
// `buildSceneChains`, and the cases that hang a rig by hand - hands it the
// world it lives in.
export class SceneChain {
  readonly rope: Rope;
  // Authored fill for the links; null = the renderer's own chain colours.
  readonly color: string | null;
  // What this chain's spans may bend around: the level's wrappable bodies for
  // an authored chain (see `buildSceneChains`), `NOTHING` for a chain built
  // with no scene. The scan is broadphased (`World.segmentCandidates`), so
  // handing a chain the whole level costs a tree walk per span rather than a
  // segment test per shape.
  readonly wrapBodies: PhysicsBody2D[];
  readonly row: RopeRow;

  // Regenerations a chain built with no length may take to find the path it
  // is taut along. A chain wrapped round its own anchor body takes two.
  private static readonly BUILD_PASSES = 8;

  constructor(
    world: World,
    a: RopeContact,
    b: RopeContact,
    length: number | null,
    color: string | null,
    wrapBodies: PhysicsBody2D[] = NOTHING,
    wraps: RopeWrap[] = [],
  ) {
    this.rope = new Rope(a, b, wraps, length);
    this.color = color;
    this.wrapBodies = wrapBodies;
    // No length: exactly taut along the path the chain actually takes, its
    // wraps found against the scene first. Measured along the bare chord, a
    // chain to an anchor on its body's far face is short by the way round the
    // body, and the first frame's scan finds that as growth the row leases and
    // then reels in, hauling the body after it.
    // A regeneration resolves one corner of a span at a time, so the path is
    // regenerated until it stops changing.
    if (length === null) {
      for (let pass = 0; pass < SceneChain.BUILD_PASSES; pass++) {
        const nodes = this.rope.path().length;
        const before = this.rope.getCurrentLength();
        this.rope.syncWraps(wrapBodies);
        if (this.rope.path().length === nodes && this.rope.getCurrentLength() === before) break;
      }
      this.rope.maxRopeLength = this.rope.getCurrentLength();
      this.rope.takeTopologyGrowth();
    }
    this.row = new RopeRow(this.rope, wrapBodies);
    world.ties.addUnit(this.row);
  }

  // The island's sleep: the row sleeps with the bodies it holds.
  get asleep(): boolean {
    return this.row.asleep;
  }

  // Every rigid body on the chain's path as it currently stands.
  eachBody(fn: (body: RigidBody2D) => void): void {
    for (const node of this.rope.path()) {
      const body = node.contact.obj;
      if (body instanceof RigidBody2D) fn(body);
    }
  }

  holds(body: RigidBody2D): boolean {
    return this.rope.path().some((n) => n.contact.obj === body);
  }
}

// The rows of these chains brought up to what their paths run over now (see
// `RopeRow.sync`), before the world steps.
export function syncSceneChains(chains: readonly SceneChain[], world: World): void {
  for (const chain of chains) chain.row.sync(world.ties);
}

// How far over its length any chain may end a frame. This is the statement the
// sweep loop below is written against, and it is what "the chain does not
// stretch" means: 5 mm is half a pixel at PIXELS_PER_METER, i.e. under what the
// renderer can show.
export const CHAIN_TOLERANCE = 0.005;

// ...and the bar a VINE JOINT runs to instead - a pair chain, a bend, a
// per-link long-range attachment. Deliberately looser, and the looseness is a
// design decision rather than a solver concession: a vine is allowed a little
// visible stretch under load (it reads as vine flex), the per-link attachments
// bound the cumulative sag whatever the joints do locally, and the held link
// itself is bound by the load rope at `CHAIN_TOLERANCE`. What the looseness
// buys is the sweep count: a stiff vine's bends and pairs disagree by
// construction and converge at one link per sweep, so holding every joint to
// 5 mm cost a swinging vine 25-40 sweeps a frame (measured, `session-322f`)
// for millimetres nobody can see.
export const VINE_TOLERANCE = 0.015;

// The authored anchor point pushed onto the body's own surface - the nearest
// point of the nearest of its shapes. A chain is bolted to a surface, so this is
// what the anchor means; it is also what keeps the solver sane, since an anchor
// in a body's interior leaves the span starting *inside* that body and the wrap
// generator resolves that as a self-intersection, winding the chain around its
// own anchor (see `nearestOnOutline`). It is applied at load rather than trusted
// from the file so a hand-edited level cannot author the degenerate case.
// The pieces of a body a chain may be tied to or routed over: the wrappable
// ones. An unwrappable piece (`CollisionObjectData.wrappable: false`) is solid
// scenery the rope passes straight through, so an anchor authored on it lands on
// the nearest piece the rope CAN hold instead - the hub inside a wheel's rim, on
// the body that is the two of them welded together. Every piece, for a body
// with no wrappable one: a chain tied there is what was authored, and the rope
// simply never bends around it.
function tieablePieces(obj: CollisionObject2D): { shape: CollisionShape2D; index: number }[] {
  const all = obj.getShapes().map((shape, index) => ({ shape, index }));
  const wrappable = all.filter((p) => p.shape.wrappable);
  return wrappable.length > 0 ? wrappable : all;
}

// A chain END: the nearest point of the nearest tieable piece's surface, and
// which piece that is.
export function snapToSurface(obj: CollisionObject2D, world: Vec2): Vec2 {
  return tieToSurface(obj, world).point;
}

function tieToSurface(
  obj: CollisionObject2D,
  world: Vec2,
): { point: Vec2; shapeIndex: number } {
  const pieces = tieablePieces(obj);
  const p = pieces[nearestShapeIndex(pieces.map((q) => q.shape), world)];
  if (!p) return { point: world, shapeIndex: 0 };
  return { point: nearestSurfacePoint(p.shape, world), shapeIndex: p.index };
}

// The wrap nodes a run of authored wrap points on one piece stands for,
// between the route's previous point and its next.
//
// A wrap node is a statement with a DIRECTION: the rope turns that way at it,
// and `cullDetachedNodes` lets it go the frame the rope stops turning that
// way. So the direction is read off the bend the authored route makes around
// the piece - clockwise on screen or counter - which is also what the scan's
// own chord-against-centre test comes to whenever a chord actually crosses a
// piece; it is only for a route the scan could never have produced (a chain
// that is nowhere near the beam it hangs over, as the crow flies) that the two
// differ, and there the bend is the one that is true of the chain.
//
// ONE direction per run, read at the run's middle between the points either
// side of the whole run, never per point. Read per point, a ring of seven
// points around a pulley gave each its direction from the bend between its
// two rim neighbours, which is next to no bend at all, and the last of them -
// between a rim neighbour and the far-off hub - came out the mirror of the
// other six: its exit tangent was then taken on the pulley's far side, and the
// chain went over the top, back under, and off to the hub (session-110f).
//
// One corner is not always a state the rope can hold. A chain hung over the
// near corner of a beam whose far side the load hangs down is, as one node,
// a chain that turns over the corner and dives back through the beam: the
// self-intersection resolver correctly refuses to continue a wrap whose next
// span circulates the other way, and the scan excludes the span's own shape, so
// nothing would ever mend it. That state is reachable in play only by HISTORY
// (the rope's end carried over the beam), and this is the history: from the
// authored corner, walk the piece's vertices in the bend's direction, adding
// each, until the span on to the next point no longer cuts the piece. A circle
// has no corners to walk and its wrap is two tangent points instead - where
// the rope from the previous point first touches it and where it leaves for
// the next - exactly the pair the scan and the resolver build between them.
function authoredWrap(
  obj: PhysicsBody2D,
  ties: readonly { point: Vec2; shapeIndex: number }[],
  prev: Vec2,
  next: Vec2,
): RopeWrap[] {
  const shapeIndex = ties[0]!.shapeIndex;
  const shape = obj.getShapes()[shapeIndex] ?? obj.primaryShape();
  // The run's middle: on a circle the rim point in the mean direction of its
  // points, which is where the chain crosses the piece; on a polygon its first
  // corner, which is where the walk below starts.
  const mean = ties.reduce((m, t) => m.add(t.point), Vec2.ZERO).div(ties.length);
  const middle = shape.shape.kind === "circle" ? nearestSurfacePoint(shape, mean) : ties[0]!.point;
  const bend = middle.sub(prev).cross(next.sub(middle));
  const wrapDir = bend >= 0 ? WrapDirection.Clockwise : WrapDirection.CounterClockwise;
  const node = (point: Vec2) =>
    new RopeWrap(new RopeContact(obj, point.sub(obj.globalPosition), shapeIndex), wrapDir);

  if (shape.shape.kind === "circle") {
    const radius = shape.shape.radius;
    const centre = shape.globalPosition;
    const tangent = (from: Vec2, dir: GenerationDirection): Vec2 =>
      from.distanceTo(centre) > radius
        ? RopeGeneration.calculateCircleTangentPoint(shape, wrapDir, from, dir)
        : middle;
    const entry = tangent(prev, GenerationDirection.Forward);
    const exit = tangent(next, GenerationDirection.Reversed);
    return entry.distanceTo(exit) < PX ? [node(entry)] : [node(entry), node(exit)];
  }

  const corners = ShapeGeometry.getGlobalCorners(shape);
  const n = corners.length;
  let i = 0;
  for (let k = 1; k < n; k++) {
    if (corners[k]!.distanceSquaredTo(middle) < corners[i]!.distanceSquaredTo(middle)) i = k;
  }
  const out = [node(corners[i]!)];
  for (let steps = 0; steps < n; steps++) {
    const span = new Segment(corners[i]!, next);
    if (Intersections.intersectsSegment(shape, span) !== IntersectionStatus.Overlap) break;
    i = Calc.mod(i + (wrapDir as number), n);
    out.push(node(corners[i]!));
  }
  return out;
}

// A chain WRAP POINT: the corner of the nearest tieable piece nearest the
// authored point - or, on a circle, the rim point - and which piece that is. A
// corner and not a face point, because a corner is what a rope bends around:
// a wrap node on the middle of a face is a node the rope hangs from with no
// geometry under the bend, which the detachment pass keeps for as long as the
// chain happens to bend there and which no scan would ever have produced. On a
// circle any rim point serves - the self-intersection resolvers slide a circle
// wrap to its tangent point every frame.
export function snapToCorner(
  obj: CollisionObject2D,
  world: Vec2,
): { point: Vec2; shapeIndex: number } {
  const pieces = tieablePieces(obj);
  let best: { point: Vec2; shapeIndex: number } | null = null;
  let bestSq = Infinity;
  for (const { shape, index } of pieces) {
    const candidates =
      shape.shape.kind === "circle"
        ? [nearestSurfacePoint(shape, world)]
        : ShapeGeometry.getGlobalCorners(shape);
    for (const c of candidates) {
      const d = c.sub(world).lengthSquared();
      if (d < bestSq) {
        bestSq = d;
        best = { point: c, shapeIndex: index };
      }
    }
  }
  return best ?? { point: world, shapeIndex: 0 };
}

// Build every chain in `data` (metres) against the bodies `buildLevelBodies`
// made. A chain naming an anchor that is not in the level, or one on a body that
// built nothing (decoration, a lone light), or the same body at both ends (which
// has nothing to constrain) is dropped rather than fed to a solver that has no
// meaning for it.
//
// Every chain is solved against the level's wrappable bodies (`wrapBodies`:
// the statics and the authored rigid bodies, areas and pass-through scenery
// excluded), which is the scene the ball's chain scans. It is the one list,
// shared by every chain rather than copied per chain, and it is the level's
// geometry and not the play space: the avatar, its hook and anything spawned
// in play are never in it.
//
// Each chain is a row of `world`'s island solver (`RopeRow`), solved at
// velocity level inside `World.integrate`.
export function buildSceneChains(data: LevelData, built: BuiltBodies, world: World): SceneChain[] {
  const anchors = collectAnchorSites(built);
  const chains: SceneChain[] = [];
  for (const c of data.chains ?? []) {
    // A chain with tie points is a `TieChain`, built by `buildTieChains`.
    if (isTieChain(c)) continue;
    const chain = buildOne(world, c, anchors, built.wrapBodies);
    if (chain) chains.push(chain);
  }
  return chains;
}

// An authored chain's `Rope` as a row of the island solver (`engine/ties.ts`),
// the plan's second stage (`plans/rope-bridge.md`). Parked at first
// (2026-10-10): two corpus bundles of the ball wound tight onto a chain-hung
// body went unhealthy while the ball's own chain was still a positional phase
// beside the island (`session-324f`). With the ball's chain a row too (stage
// 3) the two are one velocity solve, and every authored chain runs here
// (2026-10-19): the positional sweep hauled a lantern back after the ball's
// island had moved it, and a ball on the lantern's bail ended every frame
// over its length (`session-77f`).
//
// The constraint is `pathLength <= constraintLength`
// over the rope's whole wrap path, and its Jacobian is what the path objects
// already give the positional solve - direction, mechanical advantage and
// torque arm per path body (`Rope.rowTerms`) - so this is the existing
// projection moved from position level to velocity level, which is what warm
// starting and substeps need to work on. The wrap path is regenerated once a
// substep (`Rope.rowPrepare`: coil, uncross, scan, resolvers), eight times a
// frame against the sweep's up to sixty-four.
//
// What this replaced for an authored chain: the Gauss-Seidel sweep over
// independent ropes, with its cap, its stall gate and the coupled sweep with
// the ball's rope, the velocity credit over the phase, the static push-out and
// the blocked-length lease - because the bodies' contacts with the scenery are
// rows of the same solve, and a chain hauling a plank into a post is a tie and
// a contact iterated together rather than a correction and a refusal in two
// phases.
//
// The unit's BODIES - what the island integrates and sleeps - are the rigid
// bodies on the path as built, pivots and spring bodies among them
// (`islandOwns`): the two ends and the authored wrap points' bodies. A free
// body the chain wraps mid-play that was not on the built path keeps the
// world's step and takes the row's impulse as velocity until the next build -
// a crate a chain swings over is the ball's case, a free body coupled at
// velocity level.
export class RopeRow implements IslandRow, IslandUnit {
  impulse = 0;
  over = 0;
  asleep = false;
  readonly substeps = DEFAULT_TIE_SUBSTEPS;
  bodies: readonly RigidBody2D[] = [];
  private statics: readonly PhysicsBody2D[] = [];
  private sleptAtVersion: number[] = [];

  constructor(
    readonly rope: Rope,
    readonly scene: PhysicsBody2D[],
  ) {
    this.readPath();
    this.measure();
  }

  // The bodies the path runs over: the island's to integrate, and the
  // statics whose moving wakes it.
  private readPath(): void {
    const bodies: RigidBody2D[] = [];
    const statics: PhysicsBody2D[] = [];
    for (const node of this.rope.path()) {
      const obj = node.contact.obj;
      if (!(obj instanceof PhysicsBody2D)) continue;
      if (islandOwns(obj)) {
        if (!bodies.includes(obj)) bodies.push(obj);
      } else if (obj instanceof StaticBody2D && !statics.includes(obj)) {
        statics.push(obj);
      }
    }
    this.bodies = bodies;
    if (statics.length !== this.statics.length || statics.some((b, i) => b !== this.statics[i])) {
      this.statics = statics;
      this.sleptAtVersion = statics.map(() => -1);
    }
  }

  // Once a frame, before the world steps (`BallLevel`): the path's bodies as
  // they stand. A chain that has wrapped a free body mid-play - a lantern's
  // chain over a crate - holds it as one of the island's bodies from here,
  // rather than handing it the row's impulse as velocity after the world has
  // already stepped it (`TieSolver.retie`).
  sync(solver: TieSolver): void {
    if (this.asleep) return;
    const before = this.bodies;
    this.readPath();
    if (before.length !== this.bodies.length || before.some((b, i) => b !== this.bodies[i])) {
      solver.retie(this, before);
    }
  }

  get rows(): readonly IslandRow[] {
    return [this];
  }

  beginFrame(dt: number): void {
    this.rope.beginFrame(dt);
    // A row never reports a block, so its lease only ever reels back.
    this.rope.noteBlockedByGeometry(false);
  }

  // The wrap path regenerated against the bodies as they stand, and the growth
  // a wrap appearing put on it leased rather than charged as velocity: a
  // coil node appearing is a step in the constraint the soft bias would turn
  // into a yank (`Rope.topologyGrowth`), as `BallChainRow.prepare` leases it.
  prepare(): void {
    this.rope.rowPrepare(this.scene);
    this.rope.leaseLength(this.rope.takeTopologyGrowth());
    this.pins.reset();
  }

  // The friction where the chain hooks a body that turns (`PIN_FRICTION`).
  private readonly pins = new RopePins();

  warmStart(): void {
    if (this.impulse === 0) return;
    for (const t of this.rope.rowTerms().terms) applyTerm(t, this.impulse);
  }

  // The row: slack `L - pathLength`, its rate the path's rate of shortening,
  // `sum(ma * (dir . v + arm * w))`, and the effective inverse mass
  // `sum(ma^2 * (1/m + arm^2 / I))` - every term the positional solve's
  // `correctShapePositionAndRotation` splits a correction by, read at
  // velocity level (see `Rope.rowTerms`).
  solve(h: number, soft: Softness, useBias: boolean): void {
    const { length, constraint, terms } = this.rope.rowTerms();
    let w = 0;
    let slackRate = 0;
    for (const t of terms) {
      const invM = invMassOf(t.body);
      const invI = invInertiaOf(t.body);
      if (t.body instanceof RigidBody2D) {
        w += t.ma * t.ma * (invM + t.arm * t.arm * invI);
        slackRate += t.ma * (t.dir.dot(t.body.linearVelocity) + t.arm * t.body.angularVelocity);
      } else {
        // A static that moves (a mover's anchor) carries the rope with it.
        slackRate += t.ma * t.dir.dot(t.vel);
      }
    }
    if (w <= 0) return;
    const applied = ropeImpulse(this, constraint - length, slackRate, w, h, soft, useBias);
    for (const t of terms) if (applied !== 0) applyTerm(t, applied);
    this.pins.solve(this.rope, this.impulse);
  }

  measure(): void {
    this.over = this.rope.overLength;
  }

  fallAsleep(): void {
    this.asleep = true;
    for (let i = 0; i < this.statics.length; i++) {
      this.sleptAtVersion[i] = this.statics[i]!.transformVersion;
    }
  }

  anchorsMoved(): boolean {
    for (let i = 0; i < this.statics.length; i++) {
      if (this.statics[i]!.transformVersion !== this.sleptAtVersion[i]) return true;
    }
    return false;
  }
}

// The ball's chain as a row of the island (`plans/rope-bridge.md`, stage 3):
// the same length constraint `RopeRow` solves for an authored chain, plus the
// one thing an authored chain never has - the WINCH.
//
// The ball's aim writes its spin kinematically, so the coil on its rim takes
// chain at `lengthPerRadian` metres a radian with no body moving and no impulse
// able to change it. Fed to the length row as it stands, that is a demand with
// infinite force behind it: wound tight against a slat, the row drove the ball
// 48 mm into the slat against the softer contact row (the row at 60 Hz, the
// contact at 30), the length read as satisfied, the unwind found nothing to
// refund and the coil wound on - two slats pushed apart by the ball between
// them, 98 rad/s on one of them (`session-1118f` f850 on the first cut of this
// row). So the winding is modelled as a drum that takes in chain at the aim's
// rate for as long as there is chain to take in, and stops only where winding
// on is physically impossible: the ball against a body on its path, or wound
// up to within the cuff's reach of the next node.
//
// The row holds `free + coil0 <= constraintLength - realised`: the free span
// plus the coil as the frame began, less what the winch has REALISED this
// frame. `coilGrowth` is what the kinematic turn has wound onto the rim so far
// (`lengthPerRadian` times the rotation the substeps integrated), and each
// substep `realised` follows it while the ball is clear of its path
// (`touching`) and the free span leaving the ball has room (`WOUND_TIGHT`);
// jammed, or wound tight, it holds where it is. The row is then one
// accumulated impulse, unbounded and soft at `TieTuning`: a fall is arrested
// here, the weight hangs here, and in free air the shortening target hauls the
// ball at the winch's rate as the positional phase did. Against a contact the
// drum stops, and the ball rests on the slat rather than sinking into it.
//
// The drum is not bounded by the tension. It was, at five times the ball's
// weight, and a drum that stops on last substep's tension and pulls without
// bound when running cannot hold at its limit: it reeled at 8 g, read the
// 8 g, stopped for a substep at 0.5 g, read that, and reeled again - every
// other substep, so a ball swinging under a span took in exactly half of
// every turn and the unwind gave the other half back to the spin
// (`session-223f` f150-161, about 0.2 rad a frame). The ball fell behind the
// aim until the steering's error wrapped past half a turn and it spun the
// other way, unwinding everything (f162). The aim's turn is the player's,
// and only geometry may refuse it.
//
// Two shapes were tried before this one and both are recorded here so they
// are not re-tried. The coil's rate fed to one row as a rest-length rate is
// the embedding above. A separate bounded MOTOR row beside a limit row leased
// by `coilGrowth` (Box2D's limit-plus-motor) chattered on the taut gate every
// half substep, and in the off substeps the ball fell into the leased slack:
// winding a hanging ball LOWERED it 6 mm a frame (`bridge-ball-hangs`).
//
// The winding the drum did not realise - `coilGrowth - realised` - is
// over-length at the end of the frame, and the chain phase's unwind gives
// exactly that back to the spin, which is the positional phase's statement
// ("winding that stayed wound") made at velocity level. Only while the
// rotation IS kinematic: a ball that is not aiming turns under the chain's
// torque like any other body, `calculateTorqueArm` gives it the arm, the
// Jacobian's own `arm * w` is then the spool rate, and the row is the plain
// length constraint.
//
// The unit's bodies are the ball and every free body its path runs over, so
// it joins the island of whatever it is hooked to or wrapped round by sharing
// the body (`TieSolver.islands`), and the island integrates the ball while the
// row holds it (`BallLevel.syncBallRow` ties it for the frame).
//
// Topology: a wrap appearing between two regenerations lengthens the measured
// path with nothing having moved, and at velocity level that is a yank the
// soft bias would deliver (see `Rope.topologyGrowth`). The growth is leased
// to the constraint in `prepare`, before the substep's solve, and the lease
// reels it back at the lease's own rate.
export class BallChainRow implements IslandRow, IslandUnit {
  // The free span leaving the ball at which it is wound tight: the cuff's
  // reach, where its rim meets the ball's. A body on the path is met first
  // as a contact (`touching`); this is the end for a node the ball passes
  // through, a ring on a vine's cord, whose links touch nothing.
  static readonly WOUND_TIGHT = MANACLE_REACH;

  impulse = 0;
  over = 0;
  // Never: the ball cannot sleep, so neither can an island holding it.
  asleep = false;
  readonly substeps = DEFAULT_TIE_SUBSTEPS;
  // Re-read by `sync` each frame the row is active: the path changes.
  bodies: RigidBody2D[] = [];
  private endKey: unknown = null;
  // This frame's kinematic winding so far, in metres of path (see above), the
  // share of it the drum has realised, and the rotation the growth was last
  // measured at.
  private coilGrowth = 0;
  private realised = 0;
  private lastRotation = 0;
  // The substep the island last ran this row at, for `finishFrame`.
  private h = 0;
  // The frame's step and the substeps prepared in it so far, for the ride's
  // carry (`prepare`).
  private dt = 0;
  private substep = 0;

  // A RING ON A CORD (`RopeVineClamp`, the chain's end threaded onto a stiff
  // span): the row is a viscous slip, not a rigid length. The ring creeps
  // along the cord at the viscous law's speed for the tension's share along
  // it (`creepSpeed(|along|·T)`), and every metre it walks takes `|along|` of
  // a metre out of the path, so the length the bodies may open is not zero
  // but the creep's relief: `slackRate + |along|·creepSpeed(|along|·λ/h) = 0`,
  // the tension `λ/h` the one that makes the ball's outward speed and the
  // ring's give agree. `solve` finds that λ (`viscousRopeImpulse`), and the
  // ring walks by the λ the substep's integration was made with (the biased
  // pass's, `walkImpulse`), at the next substep's `prepare` or the frame's
  // `finishFrame` (`Rope.rowCreep`).
  //
  // This is the textbook way a velocity solver carries a velocity-dependent
  // force - Box2D's friction and motor rows are the same shape, an impulse
  // solved against a rate rather than a position - and it replaces five
  // drafts (2026-10-13) that walked the ring OUTSIDE the solve and told the
  // row afterwards, each from a reading of the tension that some case made
  // wrong: walked once a frame after the solve, a centimetre of slack a
  // frame the ball fell into and was caught from (`session-346f`, a jerky
  // slide); walked from last frame's tension, a bang-bang loop at the bottom
  // of a swing (`session-113f`); walked at a substep's scale of the
  // positional law, no slide at all under a wind-up along the cord
  // (`session-129f`); bounded by a reconstruction of the ball's free motion,
  // no slide for a ball with momentum along the cord and no winch
  // (`session-121f`). Inside the solve none of those readings exists: the
  // tension IS the one that lets the ball lengthen the path at the creep's
  // relief, whatever is driving it - weight, a swing's centripetal load, the
  // winch, or momentum.
  private walkImpulse = 0;

  constructor(
    readonly ball: RigidBody2D,
    readonly rope: Rope,
    // The level's bodies as they stand, for the wrap scan.
    readonly scene: () => PhysicsBody2D[],
    // Whether a contact's face is engaged as the island stands
    // (`TieSolver.engaged`), for `room`.
    private readonly engaged: (c: ContactConstraint) => boolean,
    // The ball's own dangling hook when it is the chain's end
    // (`BallPlayer.chainTip`), or null (see `dangling`).
    private readonly tip: () => RigidBody2D | null = () => null,
  ) {}

  // The chain's end is the ball's own dangling hook: a tip on a string, not a
  // tether. Nothing the tip meets may reach the ball - not the face it is
  // pinned on, not its weight, not its mass - so the row is one-way: the
  // ball's motion is read along the chain and the impulse goes to the tip
  // alone (`solve`), the drum takes in every turn the aim makes and gives
  // none of it back to the spin (`realiseTakeUp`, `finishFrame`), and the
  // chain's pull on the tip buys it no grip on what it rests on
  // (`tipPressInto`), so a pinned tip slides off rather than holding. Read
  // as a two-way row, a 0.26 kg tip pinned on a ledge was the anchor a 52 kg
  // ball wound itself 31 cm up a wall by (`session-373f` f211-331), and one
  // snagged under a box was a load the solve could not carry to the ball,
  // the chain standing 16 cm over while the ball fell on (`session-126f` f97).
  get dangling(): boolean {
    return this.tip() !== null;
  }

  // The free span left to take in before the tip reaches the rim, where the
  // ball stows it (`BallPlayer.stowIfWoundIn`).
  private freeRoom(): number {
    return Math.max(0, this.rope.leavingSpanLength(this.ball) ?? 0);
  }

  get rows(): readonly IslandRow[] {
    return [this];
  }

  // The level owns the rope's frame (`Rope.beginFrame`, the lease release).
  // What is read here is whether the ball is touching a slat on its path this
  // frame (a gathered contact, speculative ones included), which is the
  // winch's jam (see `touching`), and the faces that may bound the drum (see
  // `sceneryNormals`).
  beginFrame(dt: number, contacts: readonly ContactConstraint[]): void {
    this.dt = dt;
    this.substep = 0;
    this.driven = 0;
    const path = this.rope.path();
    const onPath = new Set<CollisionObject2D>();
    for (const node of path) onPath.add(node.contact.obj);
    // A body on the path that MOVES (a slat, a plank) jams the drum on any
    // touch (see `touching`). The scenery does not: a ball rolling along the
    // floor its chain is bolted to winds itself along that floor towards the
    // anchor, as the positional phase always let it, and stopping the drum
    // on the touch refunded the whole turn from the frame the ball landed
    // (`session-187f` f33 on). What the scenery refuses is length the ball
    // cannot reach (see `sceneryNormals`).
    // A body on the path the ball is against is answered as the scenery is,
    // by what it leaves reachable, not jammed on the touch: winding against a
    // pivot turns it, winding against a hung weight slides the ball along it,
    // and jammed on the touch neither could follow the aim at all - every
    // turn refunded, 0 rad of a half-turn sweep on a disc it rests on
    // (`point-blank-turn`) and 0.24 hanging against a chained weight
    // (`converged-aim-hang`), where the positional phase let both turn.
    //
    // A body of a TIED chain - a bridge's slat - keeps the jam on the touch
    // (see `touching`): wound against a slat the drum only rocks it, and
    // answered by the room the bridge's segments stretched 51-58 mm against
    // the invariant's 50 (`session-1118f-bridge` f967).
    const slat = (body: CollisionObject2D): boolean => body instanceof RigidBody2D && this.slats.has(body);
    // Within the slop: an island body's contacts are gathered out to its
    // frame's reach (`World.gatherReach`), and a slat that far off is not one
    // the ball is against.
    this.touching = contacts.some(
      (c) => c.depth > -CONTACT_SLOP && ((c.a === this.ball && slat(c.b)) || (c.b === this.ball && slat(c.a))),
    );
    this.sceneryFaces = [];
    // `b` is a static whenever it is not a rigid body, and the normal points
    // out of `b`, so a face the ball is `b` against is turned round.
    for (const c of contacts) {
      if (c.a === this.ball && (!(c.b instanceof RigidBody2D) || (onPath.has(c.b) && !slat(c.b)))) {
        this.sceneryFaces.push({ c, normal: c.normal });
      } else if (c.b === this.ball && onPath.has(c.a) && !slat(c.a)) {
        this.sceneryFaces.push({ c, normal: c.normal.neg() });
      }
    }
  }

  // The faces the ball's gathered contacts are on, outward normals at the
  // ball: what `sceneryNormals` reads the engaged ones of.
  private sceneryFaces: { c: ContactConstraint; normal: Vec2 }[] = [];

  // The normals of the scenery the ball is against, which bound what the
  // drum may take in (`room`): no more than the free span could lose with the
  // ball sliding along every face it allows, the positional phase's own
  // measure of a refusal (`Rope.unreachableShortening`, which returns the
  // shortening the surfaces leave REACHABLE, and the lease
  // `absorbBlockedLength` grants). A pull straight into a face leaves none:
  // `session-1052f`, the cuff struck point-blank through a wall's corner
  // (`p·n` = -1.00), where a drum that reeled on regardless carried 0.6 to
  // 4.9 kN·s a substep and the friction it bought let the kinematic spin roll
  // the ball up the wall away from its anchor. A pull along a face leaves
  // all of it, and so does anything in between short of square; friction is
  // not consulted, because the ball's grip (3.8) made the cone 75 degrees
  // wide and the drum stopped under any overhang (`session-187f`).
  //
  // Only the faces engaged as the island stands, closed or carrying load
  // (`TieSolver.engaged`), not every gathered contact: a speculative one may
  // be up to `CONTACT_SLOP` (10 mm) clear of its face, and read as a refusal
  // it bounded the drum, and had the turn refunded, by a face the ball never
  // touched.
  private get sceneryNormals(): Vec2[] {
    const normals: Vec2[] = [];
    for (const face of this.sceneryFaces) if (this.engaged(face.c)) normals.push(face.normal);
    return normals;
  }

  // The ball is against a body its chain runs over. Wound up to the body it
  // hangs from, the winch has nothing left to haul: every impulse the motor
  // could deliver reaches the body through the knot at one point and the ball
  // through the contact at another, a couple that rocks a slat rather than
  // shortening anything (the middle slat rocked at 10-14 rad/s under a ball
  // wound tight to its end, whatever the motor's bound, `bridge-ball-hangs`),
  // and a haul the frame then refunds nine tenths of keeps the steering
  // asking (`BallPlayer.windStall` wants the refund whole). So the motor does
  // not pull while the ball touches its path, the unwind hands the whole turn
  // back, and the latch closes - the positional phase's rule for a ridden
  // holder, made here.
  private touching = false;
  // The path's bodies that are a TIED CHAIN's - a bridge's slats - read by
  // membership in `chains` (see `sync`). Not by `tied`, which every island
  // unit sets for its bodies: a vine span's links and a held berry's plant
  // are tied too, and the jam is a bridge's rule, not theirs.
  private slats: Set<RigidBody2D> = new Set();

  // The bodies the path runs over now, and which of them are a tied chain's
  // (`TieSolver.chains`). A new far end carries no tension history, so the
  // warm start is dropped with it, as `Rope.end`'s setter drops the frame
  // correction.
  sync(chains: readonly TieChain[]): void {
    const bodies: RigidBody2D[] = [this.ball];
    this.slats = new Set();
    for (const node of this.rope.path()) {
      const obj = node.contact.obj;
      if (obj === this.ball || !(obj instanceof PhysicsBody2D) || !islandOwns(obj)) continue;
      if (!bodies.includes(obj)) bodies.push(obj);
      if (chains.some((chain) => chain.bodies.includes(obj))) this.slats.add(obj);
    }
    this.bodies = bodies;
    // A ring on a cord keeps its warm start across the links it crosses: the
    // constraint is the same cord, and the tension it carried a link ago is
    // the tension it carries now. Dropped at every crossing, the first
    // substep on each link started from nothing, the ball ran on into a taut
    // chain and was caught at twice the weight: a hitch every twenty
    // centimetres of slide (`session-346f`).
    const end = this.rope.end;
    const endKey: unknown = end instanceof RopeVineClamp ? end.vine : end.contact.obj;
    if (endKey !== this.endKey) {
      this.impulse = 0;
      this.motorImpulse = 0;
      this.walkImpulse = 0;
      this.endKey = endKey;
    }
    this.coilGrowth = 0;
    this.realised = 0;
    this.pending = 0;
    this.slackRef = this.lengthSlack();
    this.lastRotation = this.ball.globalRotation;
  }

  prepare(h: number): void {
    this.h = h;
    this.takeInTurn();
    // A ride stands where the substep's time has it (`Rope.carryRidesWithin`),
    // and a rail's ring where its own row moved it (`ring`).
    if (this.dt > 0) this.rope.carryRidesWithin((this.substep * h) / this.dt);
    const ringRelief = this.advanceRing();
    this.substep++;
    this.rope.rowPrepare(this.scene());
    // Read at the frame's first substep, with the drivers back where the frame
    // found them (`TieSolver.driven`, the ride's carry above).
    if (this.substep === 1) this.overAtStart = this.rope.overLength;
    this.driven += Math.max(0, -this.drivenRate()) * h;
    // The last substep's walk, over the integration it was solved with (see
    // the class comment), on the cord as that integration left it.
    this.walk();
    // A ring on a rail moved over the last substep at the speed its row
    // solved (see `ring`): chain taken in without a body moving, as a walk is.
    this.walkRelief += ringRelief + this.setupRing(h);
    this.ringTerm = this.findRingTerm();
    this.pins.reset();
    this.rope.leaseLength(this.rope.takeTopologyGrowth());
    this.realiseTakeUp();
    this.reel = this.reelRate();
    this.taking = this.reel > 0 ? this.closingRate() : 0;
  }

  // How fast the chain is actually being taken in as the substep opens, m/s:
  // the rate the bodies close the path along it (`slackRate`), read before
  // the solve so the motor's power bound does not chase its own answer.
  private closingRate(): number {
    let rate = this.beadRate;
    for (const t of this.rope.rowTerms().terms) rate += this.termRate(t);
    return rate;
  }

  // A RING ON A RAIL (`RopeClamp`, the chain's end clamped round a bar). The
  // cuff is a two-hundredth of the ball, and solved as a light body of the row
  // it was a stiff one: the row's impulse went into the ring and its friction
  // took it back, and a ring that should have trailed the ball at the kinetic
  // cone ran ahead of it to 6 m/s and stuck dead, over and over
  // (`rail-friction`). So it is the MASSLESS ring, which is exact rather than
  // stiff:
  //
  // - While the chain pulls and the ring SLIDES, the ring's force balance
  //   pins the chain at the kinetic cone, so where the ring stands is a
  //   function of the node pulling it: at the cone's edge on the bar from it
  //   (`Rope.rowSnapRing`, the positional slide's own rule), and the chain
  //   constrains only that node's motion ACROSS the bar. In the row that is
  //   the last span's direction `e` in the puller's rate replaced by
  //   `u = e − ((e·t)/(e⊥·t))·e⊥`, which is square to the bar with `u·e = 1`:
  //   the row's mass is unchanged and its impulse still acts along the chain.
  //   A ball sliding under the bar is then held at its distance below it and
  //   braked by the chain's lean, `μk·g`; held still in a substep it had been
  //   hauled round the ring as round a fixed pin, and the next substep's
  //   placement jumped the ring at it and left the chain slack. The ring stops
  //   sliding when its puller stops running along the bar.
  // - While the chain pulls and the ring is STUCK, the row is the plain length
  //   row; past the static cone the ring breaks away to the kinetic edge.
  // - While the chain is slack nothing pulls the ring, and it is a bead on the
  //   wire under its own weight - which cancels - braked by friction on the
  //   weight across the bar, as the positional coast (`RopeClamp.coast`) ran
  //   it: a ring on a vertical bar falls at `g`.
  private ring: { prev: PhysicsBody2D; e: Vec2; u: Vec2 } | null = null;
  // The path's shortening rate from an unpulled ring's own run along the bar,
  // as a bead (see `ring`): part of the row's rate, as a body's speed is.
  private beadRate = 0;
  // A slack substep moved the ring as a bead; it advances at the next
  // opening.
  private ringSolved = false;

  private advanceRing(): number {
    if (!this.ringSolved) return 0;
    this.ringSolved = false;
    return this.rope.rowAdvanceRing(this.h);
  }

  // The ring at the substep's opening (see `ring`): returns the path its snap
  // took out.
  private setupRing(h: number): number {
    this.ring = null;
    this.beadRate = 0;
    const clamp = this.rope.end;
    if (!(clamp instanceof RopeClamp)) return 0;
    const t = clamp.tangent();
    const nodes = this.rope.path();
    const prevNode = nodes[nodes.length - 2];
    if (t === null || !prevNode) {
      clamp.speed = 0;
      clamp.sliding = false;
      return 0;
    }
    const grip = clamp.body.surfaceFriction;
    const mus = RAIL_STATIC_FRICTION * grip;
    const muk = RAIL_KINETIC_FRICTION * grip;
    // How fast the ring's own run along the bar shortens the path: the bar's
    // tangent along the last span, at its speed.
    const toPrev = prevNode.contact.globalPosition.sub(clamp.contact.globalPosition);
    const span = toPrev.length();
    this.beadRate = span > 1e-9 ? (clamp.speed * t.dot(toPrev)) / span : 0;
    const { length, constraint } = this.rope.rowTerms();
    // Pulling: the chain carried load over the last substep, or comes taut
    // within this one (the slack it has less what the bodies and the ring open
    // it by). The load and not the slack alone: a ring left to run as a bead
    // stood a couple of millimetres slack at every substep's opening while the
    // row carried the ball's whole weight inside it, and read as unpulled it
    // was never put back on its cone - the chain trailed at 27 degrees against
    // 18 (`rail-friction`).
    const pulling = this.impulse + this.motorImpulse > 0 || constraint - length + this.closingRate() * h <= 0;
    if (!pulling) {
      const gA = GRAVITY.dot(t);
      const gC = Math.abs(GRAVITY.cross(t));
      if (clamp.sliding && clamp.speed !== 0) {
        const sigma = Math.sign(clamp.speed);
        const v = clamp.speed + (gA - sigma * muk * gC) * h;
        clamp.speed = v * sigma > 0 ? v : 0;
        clamp.sliding = clamp.speed !== 0;
      } else if (Math.abs(gA) > mus * gC) {
        clamp.sliding = true;
        clamp.speed = (gA - Math.sign(gA) * muk * gC) * h;
      } else {
        clamp.speed = 0;
        clamp.sliding = false;
      }
      this.ringSolved = clamp.speed !== 0;
      this.beadRate = span > 1e-9 ? (clamp.speed * t.dot(toPrev)) / span : 0;
      return 0;
    }
    this.beadRate = 0;
    const prev = prevNode.contact.obj;
    const at = prevNode.contact.globalPosition;
    const runs = prev instanceof PhysicsBody2D ? prev.velocityAtPoint(at).dot(t) : 0;
    // A sliding ring stops when its puller stops running the way it slides.
    if (clamp.sliding && runs * Math.sign(clamp.speed) <= 0) clamp.sliding = false;
    const relief = this.rope.rowSnapRing(h, mus, muk);
    // Against an end that ends in something the ring cannot follow its puller
    // on, and is held there as a stuck ring is: read square to the bar there,
    // the row let the ball run on along it and the chain grew 43 mm
    // (`session-77f`, BALL's rail).
    if (clamp.sliding && clamp.atClosedEnd(Math.sign(runs))) clamp.sliding = false;
    clamp.speed = clamp.sliding ? runs : 0;
    if (!clamp.sliding || !(prev instanceof PhysicsBody2D)) return relief;
    const toRing = clamp.contact.globalPosition.sub(at);
    const reach = toRing.length();
    if (reach < 1e-9) return relief;
    const e = toRing.div(reach);
    const across = new Vec2(-e.y, e.x);
    const ta = across.dot(t);
    if (Math.abs(ta) < 1e-6) return relief;
    this.ring = { prev, e, u: e.sub(across.mul(e.dot(t) / ta)) };
    return relief;
  }

  // A path term's rate of shortening, with a sliding ring's puller read square
  // to the bar (see `ring`).
  private termRate(t: RopeRowTerm): number {
    const v =
      t.body instanceof RigidBody2D
        ? t.ma * (t.dir.dot(t.body.linearVelocity) + t.arm * t.body.angularVelocity)
        : t.ma * t.dir.dot(t.vel);
    const ring = this.ring;
    if (ring === null || t.body !== ring.prev || t !== this.ringTerm) return v;
    const bv = t.body instanceof RigidBody2D ? t.body.linearVelocity : t.vel;
    return v - ring.e.dot(bv) + ring.u.dot(bv);
  }

  // The term the ring's puller is on this substep: the last before the end's.
  private ringTerm: RopeRowTerm | null = null;

  private findRingTerm(): RopeRowTerm | null {
    const ring = this.ring;
    if (ring === null) return null;
    const terms = this.rope.rowTerms().terms;
    for (let i = terms.length - 1; i >= 0; i--) if (terms[i]!.body === ring.prev) return terms[i]!;
    return null;
  }

  // An impulse `j` along the chain, to every body on it - but the ball, while
  // the chain's end is its dangling tip (see `dangling`).
  private applyAll(terms: readonly RopeRowTerm[], j: number): void {
    if (j === 0) return;
    const skip = this.dangling ? this.ball : null;
    for (const t of terms) if (t.body !== skip) applyTerm(t, j);
  }

  // The chain's take-in speed this substep (see `closingRate`).
  private taking = 0;

  // The rate the DRIVEN nodes on the path - the scenery's, a mover's, a
  // ride's - close it at, m/s: the share of `closingRate` nothing the island
  // solves can change, read off the terms' node velocities (`RopeRowTerm.vel`).
  private drivenRate(): number {
    let rate = 0;
    for (const t of this.rope.rowTerms().terms) {
      if (!(t.body instanceof RigidBody2D)) rate += t.ma * t.dir.dot(t.vel);
    }
    return rate;
  }

  // Metres the driven nodes have opened the path by this frame (see
  // `drivenOpening`).
  private driven = 0;

  // How far the driven nodes opened the path over the frame: a ride's carry
  // or a mover taking the anchor away. Nothing the chain does slows a driver,
  // so where the ball is held - a wall it is carried into - this is length the
  // chain must give, and `BallLevel.closeBallRowFrame` leases it (see there).
  drivenOpening(): number {
    return this.driven;
  }

  // The chain's over-length as the frame's first substep found it, for what
  // the frame grew.
  private overAtStart = 0;

  // How much the chain's over-length GREW over the island's frame: what the
  // bodies did not follow of whatever opened the path. A ball dragged along
  // after a driver stands its lag at a steady over-length and grows none; one
  // the geometry holds grows a frame of the driver's travel a frame.
  overGrowth(): number {
    return this.rope.overLength - this.overAtStart;
  }

  // THE DRUM IS A MOTOR WITH A RATED PULL (`RATED_PULL`), solved as Box2D
  // solves a prismatic joint's motor beside its limit: the motor drives the
  // chain's shortening towards the drum's reel rate with its accumulated
  // impulse clamped to the rated pull every substep, and the length row -
  // the limit - holds whatever has been taken in without bound and has the
  // last word. So the drum stalls at its rating and never pays out under
  // load, and what it takes in is what the bodies actually let it take in:
  // the slack the motor opened (`realiseTakeUp`), the rest of the turn left
  // unrealised for the unwind to hand back, as a jammed drum's always was.
  // Unbounded, a drum reeling against a face it could not reach had no
  // ceiling on its tension at all, and every way the island found to spend
  // it was a launch or a buzz: 1000 J in one frame off a ceiling
  // (`session-85f` f51), a rigid anchor 45 mm into a wall (`session-427f`),
  // the ball whipped round an anchor across the face it rested on at 13 m/s
  // (`session-187f`). A ring on a cord is the same motor, its creep reading
  // the motor's pull with its own row's.
  //
  // The 5 g slip removed on 2026-10-15 was a GATE - it stopped the drum on
  // the last substep's tension and pulled without bound while running, so it
  // stopped and started every other substep (`session-223f`); a clamped
  // accumulated impulse saturates instead, and nothing switches.
  // Newtons: the most the drum can pull, which is also the fling's ceiling
  // by RADIUS - reeling a whirling ball in means out-pulling its centripetal
  // tension `m·v²/r`, so a drum rated `T` winds it no faster than
  // `sqrt(T·r/m)`: a short swing caps low and a long one high, as a hand
  // whirling a weight finds. 4 kN (Tris, 2026-10-18): unbounded (20 kN) the
  // power alone set the fling, and a short swing that keeps the drum at full
  // power out-flung the long ones (`session-144f`'s 0.54 m chain released at
  // 8.9 m/s against `session-197f`'s 7.8); at 4 kN it releases at 6.0, and
  // the long swings are untouched. A catch it cannot take spills into the
  // length row, which has no bound. A constant of the source, not a setting:
  // a bundle records the tree it ran on, not the ratings.
  static readonly RATED_PULL = 4000;
  // Watts: the drum's rated POWER, a winch's motor curve - it pulls no harder
  // than `RATED_POWER` over the speed the chain is actually coming in at, so
  // a jammed drum heaves up to its rated pull and one keeping up delivers its
  // rated power however fast it is asked to turn. The feel knob, Tris's: 2 kW
  // (11, then 8, felt too strong on the curve against the ASKED-for speed,
  // which starved a fast wind, and 5 and 4 on this one). At 5 kW it released
  // `session-197f`, the 226f post and `session-185f` at 9.0 / 6.7 / 8.3 m/s, where the positional phase's
  // integration loss left them at 8.4 / 6.4 / 9.0; unbounded the drum peaked
  // at 60-65 kW and flung 12.8 / 11.0 / 12.1. A constant of the source, as
  // `RATED_PULL` is.
  static readonly RATED_POWER = 3500;

  // The motor's accumulated impulse, this substep.
  private motorImpulse = 0;

  // The whole pull on the chain this substep, the drum's motor and the
  // length row together, as an impulse: what a ring on a cord creeps by.
  get pull(): number {
    return this.impulse + this.motorImpulse;
  }
  // Turn wound onto the rim since the motor last looked, not yet realised.
  private pending = 0;

  // Book as realised the winding the motor actually took in: the slack its
  // pull opened in the length row since the last look, no more than the turn
  // wound and no more than the room left (see `takeInTurn`).
  private realiseTakeUp(): void {
    const pending = this.pending;
    this.pending = 0;
    const slack = this.lengthSlack();
    if (pending > 0 && this.dangling) {
      // A dangling tip is reeled in by every turn, up to the rim (see
      // `dangling`): what it is against is its own problem, never the ball's.
      const realise = Math.min(pending, this.freeRoom());
      this.realised += realise;
      this.slackRef = slack - realise;
    } else if (pending > 0 && !this.touching) {
      // The closure the motor achieved since the last look: the slack the
      // turn wound off (`pending`) and what the bodies gave back since. Not
      // the slack itself: a chain standing over its length - squeezed
      // between the hold and a face the ball rests on - has negative slack
      // whatever the motor does, and booked against it nothing was ever
      // realised and every turn refunded (`converged-aim-hang`, 6 mm over).
      const closed = slack - this.slackRef + pending;
      // And no more than the bodies actually came together along the chain
      // over the substep, read from their velocities: the turn is booked at
      // the spool rate, and where the path did not grow by it - a chain
      // straight from the cuff to a root, no coil on the ball, the rim
      // carrying the cuff round - the slack it seemed to open was booked as
      // the motor's closure, the length row's target shrank 5.5 mm a substep
      // with the bodies opening, and the row, which has no rating, hauled the
      // ball round the root to 50 m/s (`session-166f` f60-85).
      const came = Math.max(0, this.closingRate()) * this.h + this.walkRelief;
      const realise = Math.max(0, Math.min(closed, pending, this.room(), came));
      this.realised += realise;
      this.slackRef = slack - realise;
    } else {
      this.slackRef = slack;
    }
  }

  // The length row's slack as the bodies stand: the length, less the winding
  // not realised, less the path.
  private lengthSlack(): number {
    const { length, constraint } = this.rope.rowTerms();
    return constraint + Math.max(this.coilGrowth, 0) - this.realised - length;
  }

  // The slack as `realiseTakeUp` last left it.
  private slackRef = 0;

  // Walk a ring on the cord by the tension the last biased pass solved for,
  // over one substep (`Rope.rowCreep`).
  private walk(): void {
    this.walkRelief = 0;
    if (this.walkImpulse > 0 && this.h > 0) {
      const before = this.rope.rowTerms().length;
      if (this.rope.rowCreep(this.h, this.walkImpulse / this.h) !== 0) {
        this.walkRelief = Math.max(0, before - this.rope.rowTerms().length);
      }
    }
    this.walkImpulse = 0;
  }

  // The path the ring's last walk took out of the chain, metres: chain the
  // drum takes in without a body moving (see `realiseTakeUp`).
  private walkRelief = 0;

  // What the substeps have turned the ball by since the last look, as path:
  // the spool rate at the pose the coil was last brought to, times the turn.
  // The drum takes it in while the ball is clear of its path, up to the free
  // span it has left (see the class comment).
  private takeInTurn(): void {
    if (this.ball.kinematicRotation) {
      const wound =
        this.rope.lengthPerRadian(this.ball) * (this.ball.globalRotation - this.lastRotation);
      this.coilGrowth += wound;
      if (wound > 0) this.pending += wound;
      if (this.realised > this.coilGrowth) this.realised = Math.max(this.coilGrowth, 0);
    }
    this.lastRotation = this.ball.globalRotation;
  }


  // How much more chain the drum may take in before the ball is wound tight:
  // the free span leaving it, less the cuff's reach, and no more than the
  // scenery it is against lets that span lose (see `sceneryNormals`).
  private room(): number {
    const free = this.rope.leavingSpanLength(this.ball);
    if (free === null) return 0;
    // The cuff's reach is the end only where nothing on the path can be
    // touched, a ring on a vine's cord (see `WOUND_TIGHT`); against a body,
    // its contact says when the ball is wound tight. Applied everywhere, a
    // point-blank anchor - born closer than the cuff's reach - could never
    // wind at all (`converged-aim-hang`: 26 mm free, every turn refunded).
    const reach = this.rope.end instanceof RopeVineClamp ? BallChainRow.WOUND_TIGHT : 0;
    const room = Math.max(0, free - reach);
    const normals = this.sceneryNormals;
    if (normals.length === 0) return room;
    return Math.min(room, this.rope.unreachableShortening({ body: this.ball, normals }));
  }

  // The drum's take-up over the substep about to be solved, metres a second
  // (see `solve`'s viscous branch): the spool rate at the ball's present turn,
  // on the terms `takeInTurn` will realise it on once the substep has turned
  // the ball. A motor's target speed, read before the step it drives.
  private reelRate(): number {
    if (!this.ball.kinematicRotation || this.h <= 0) return 0;
    const dangling = this.dangling;
    if (this.touching && !dangling) return 0;
    const rate = this.rope.lengthPerRadian(this.ball) * this.ball.angularVelocity;
    return rate > 0 ? Math.min(rate, (dangling ? this.freeRoom() : this.room()) / this.h) : 0;
  }

  private reel = 0;

  // The ball's own terms of the row as last solved, for `pressInto`.
  private ballTerms: RopeRowTerm[] = [];

  // How hard the chain is pressing the ball into a face with outward normal
  // `normal`, as an impulse this substep: the hold's and the motor's tension
  // along each of the ball's terms, where that term pulls into the face (see
  // `TieSolver.chainPress`).
  pressInto(normal: Vec2): number {
    return this.pressOf(this.ballTerms, normal);
  }

  // The same for the dangling tip (see `dangling`): its contacts take no grip
  // from the chain's pull, so a tip the chain drags across a face slides on
  // it whatever its friction, and only its own weight grips.
  tipPressInto(normal: Vec2): number {
    return this.pressOf(this.tipTerms, normal);
  }

  private pressOf(terms: readonly RopeRowTerm[], normal: Vec2): number {
    let press = 0;
    for (const t of terms) press += t.ma * Math.max(0, -t.dir.dot(normal));
    return (this.impulse + this.motorImpulse) * press;
  }

  // The dangling tip's terms of the row as last solved, for `tipPressInto`.
  private tipTerms: RopeRowTerm[] = [];


  // After the island's last substep: the turn that substep integrated, taken
  // in on the same terms, and the winding the drum did NOT realise this frame
  // - the one share of the chain's over-length that is the spin's to give
  // back (`Rope.unwindOverLength`). The rest of the over-length is the soft
  // row's stretch under load, and charging THAT to the spin is a ball that
  // cannot wind: a loaded chain sits a few millimetres over all frame, and
  // with no coil yet on the rim the spool rate is a few millimetres a radian,
  // so the stretch was worth more than the frame's whole turn and every turn
  // was refunded (`session-247f`, winding ignored for 230 frames).
  finishFrame(): number {
    this.rope.carryRidesWithin(1);
    const ringRelief = this.advanceRing();
    this.takeInTurn();
    this.walk();
    this.walkRelief += ringRelief;
    this.realiseTakeUp();
    // A dangling tip refuses the spin nothing (see `dangling`).
    if (this.dangling) return 0;
    return Math.max(0, this.coilGrowth - this.realised);
  }

  // The row's own stretch under the tension its last substep carried, the
  // one over-length that is not the spin's: a soft constraint at `ω`
  // carrying `λ` a substep stands `λ·w / (h·ω²)` over (the steady state of
  // `ropeImpulse`'s soft step), 1.2 mm under `session-197f`'s 9 kN against
  // the 1-2 mm it is measured at.
  stretch(): number {
    if (this.h <= 0 || this.w <= 0) return 0;
    const omega = 2 * Math.PI * Math.min(TieTuning.hertz, 0.25 / this.h);
    return (this.impulse * this.w) / (this.h * omega * omega);
  }

  // The row's effective inverse mass as last solved, for `stretch`.
  private w = 0;

  warmStart(): void {
    const impulse = this.impulse + this.motorImpulse;
    if (impulse === 0) return;
    this.applyAll(this.rope.rowTerms().terms, impulse);
  }

  solve(h: number, soft: Softness, useBias: boolean): void {
    const { length, constraint, terms } = this.rope.rowTerms();
    let w = 0;
    let slackRate = 0;
    this.ballTerms = [];
    this.tipTerms = [];
    // Dangling, the ball is an infinite mass to this row (see `dangling`):
    // its motion along the chain is the rate the tip must follow, and none of
    // the row's impulse is its.
    const dangling = this.dangling;
    const tip = dangling ? this.tip() : null;
    for (const t of terms) {
      slackRate += this.termRate(t);
      if (t.body === tip) this.tipTerms.push(t);
      if (t.body === this.ball) {
        if (dangling) continue;
        this.ballTerms.push(t);
      }
      if (t.body instanceof RigidBody2D) w += t.ma * t.ma * (invMassOf(t.body) + t.arm * t.arm * invInertiaOf(t.body));
    }
    slackRate += this.beadRate;
    this.w = w;
    if (w <= 0) return;
    // The length, less the frame's winding the drum has not realised (see the
    // class comment): `constraint + coilGrowth - realised - path`.
    const slack = constraint + Math.max(this.coilGrowth, 0) - this.realised - length;
    // A ring on a cord gives way at the creep's relief (see the class comment).
    //
    // And there the drum's take-up this substep is a RATE the row reels at,
    // not a length the row is short by: the motor's velocity target, as a
    // velocity solver carries any motor. Handed over as position error (the
    // rigid row's way, below), the take-up is corrected by the soft bias,
    // which the biased pass pays as tension and the relax pass takes back:
    // under a wind-up on `session-171f` the biased pass pulled 2-5 kN on a
    // 30-44 mm error and the relax pass left the ball 0.4-1.5 kN, while the
    // ring crept by the biased figure - several times the tension the ball
    // felt, squared by the law. The ring gave way where the chain should
    // have held the ball, and winding felt far less resisted than a fall did.
    // As a rate, both passes carry the one tension that reels the ball and
    // drives the creep, and the error left is the drift the bias is for. The
    // rate is the take-up the substep is about to make (`reelRate`, read at
    // `prepare` from the ball's present turn), so the take-up `takeInTurn`
    // then books into `realised` is already paid by the motion it drove and
    // leaves no error behind; booked after the fact instead, every frame's
    // last substep of winding carried into the next frame as error, ten
    // millimetres of it under a steady wind-up.
    // The motor first, the limit after it with the last word (see
    // `RATED_PULL`), for a plain chain and a ring on a cord alike. As a rate
    // the take-up stands 1-2 mm over under `session-197f`'s 9 kN wind-up, the
    // soft row's own stretch; handed over as position error it trailed the
    // winding by a frame of it, 34-62 mm, one frame of `R·ω·dt`.
    let rate = slackRate;
    if (this.reel > 0) {
      // Speculative, as a contact is: slack the chain still has absorbs the
      // reel before the motor pulls on anything, so a drum reeling a slack
      // chain takes up slack and hauls nothing.
      //
      // The power bound is the chain's ACTUAL take-in speed's, a motor's
      // curve: a drum keeping up delivers its rated power however fast the
      // aim asks it to turn, and one bogged down heaves harder, up to its
      // rated pull. Bounded by the speed the aim ASKED for instead, a fast
      // wind capped itself at 1.3 kN, could not haul the ball at that speed,
      // and delivered 0.1-2.7 kW of the 5 - a fast whirl put half the energy
      // of a slow one into the ball (`session-86f` 535 J against
      // `session-130f`'s 1128).
      const power = BallChainRow.RATED_POWER / Math.max(this.taking, 1e-6);
      const max = Math.min(BallChainRow.RATED_PULL, power) * h;
      const ask = slackRate + Math.max(slack, 0) / h - this.reel;
      const next = Math.min(max, Math.max(0, this.motorImpulse - ask / w));
      const driven = next - this.motorImpulse;
      this.motorImpulse = next;
      this.applyAll(terms, driven);
      rate += driven * w;
    } else if (this.motorImpulse !== 0) {
      // A drum that has stopped reeling - the ball touching a slat, the aim
      // let go - takes its warm-started pull back off the bodies before it
      // lets go of it. Zeroed alone, the impulse `warmStart` applied stayed in
      // the bodies with nothing to answer it, since the hold row clamps at
      // zero and cannot push: up to a substep of rated pull, 8.3 N·s, handed
      // to the bodies for nothing.
      this.applyAll(terms, -this.motorImpulse);
      rate -= this.motorImpulse * w;
      this.motorImpulse = 0;
    }
    // A ring on a cord gives way at the creep's relief (see the class
    // comment), by the whole pull on it, the motor's as well as the hold's.
    const law = this.rope.rowCreepLaw();
    let applied: number;
    if (law !== null && law.along !== 0) {
      applied = viscousRopeImpulse(
        this,
        slack,
        rate,
        w,
        h,
        soft,
        useBias,
        Math.abs(law.along),
        law.viscosity,
        this.motorImpulse,
      );
    } else {
      applied = ropeImpulse(this, slack, rate, w, h, soft, useBias);
    }
    this.applyAll(terms, applied);
    this.pins.solve(this.rope, this.impulse + this.motorImpulse);
    if (useBias) this.walkImpulse = this.impulse + this.motorImpulse;
  }

  // The friction where the chain hooks a body that turns (`PIN_FRICTION`).
  private readonly pins = new RopePins();

  measure(): void {
    this.over = this.rope.overLength;
  }

  fallAsleep(): void {}

  anchorsMoved(): boolean {
    return false;
  }
}

// `ropeImpulse` for a rope whose end creeps along a viscous cord: the same
// soft row, with the path's own shortening by the creep added to the rate it
// drives to zero. The creep's relief at an accumulated impulse λ is
// `along·creepSpeed(along·λ/h)`, so the impulse solves
//
//   λ = max(0, λ₀ − m·(slackRate + relief(λ) + bias)/w − i·λ₀)
//
// where `m`, `i` and `bias` are `ropeImpulse`'s own (`massScale`,
// `impulseScale`, the slack's or the softness's bias). The right side falls as
// λ rises (the relief grows with the tension), so there is one root and it lies
// between 0 and the rigid row's answer; forty halvings of that bracket put it
// within a millionth of a newton-second, past anything the sim can measure.
// Bisection rather than Newton because the square law's slope is zero at no
// tension, where Newton's first step is undefined.
const VISCOUS_ROW_BISECTIONS = 40;

export function viscousRopeImpulse(
  row: { impulse: number },
  slack: number,
  slackRate: number,
  w: number,
  h: number,
  soft: Softness,
  useBias: boolean,
  along: number,
  viscosity: number,
  // Impulse another row is pulling the ring with this substep (the drum's
  // motor), which the creep feels as much as this row's own.
  pull = 0,
): number {
  let bias = 0;
  let massScale = 1;
  let impulseScale = 0;
  if (slack > 0) {
    bias = slack / h;
  } else if (useBias) {
    bias = soft.biasRate * slack;
    massScale = soft.massScale;
    impulseScale = soft.impulseScale;
  }
  const start = row.impulse;
  const target = (lambda: number): number => {
    const relief = along * creepSpeed((along * (lambda + pull)) / h, viscosity);
    return Math.max(start - (massScale * (slackRate + relief + bias)) / w - impulseScale * start, 0);
  };
  let hi = target(0);
  let next = 0;
  if (hi > 0) {
    let lo = 0;
    for (let k = 0; k < VISCOUS_ROW_BISECTIONS; k++) {
      const mid = 0.5 * (lo + hi);
      if (target(mid) > mid) lo = mid;
      else hi = mid;
    }
    next = 0.5 * (lo + hi);
  }
  const applied = next - start;
  row.impulse = next;
  return applied;
}

// PIN FRICTION (Tris, 2026-10-19): where a chain hooks a body that turns -
// a lamp's ring on its chain, a ball's ring on a lamp's bail, the cuff's
// hinge on the loop of a ball that is not being steered - the link turns on
// a pin of its own bar's radius (`CHAIN_LINK_BAR`), and dry steel on steel
// resists that turn with a torque of `PIN_FRICTION·T·r`, the chain's tension
// pressing the link onto the pin. Without it the rows held such a chain
// losslessly: a ball hung from a lamp hung on a chain rocked the lamp at
// 3 Hz and ±7 rad/s for as long as anyone watched, where the positional
// sweep's own numerical loss had always settled it (`session-547f`). It
// bites the relative turn only, so a body swinging with its chain loses
// nothing to it, and in proportion to the load, so a chain under a heavy
// swing loses a few joules a radian of bend.
export const PIN_FRICTION = 0.57;

// One pin's friction row (see `PIN_FRICTION`): the accumulated impulse of a
// substep, against the turn of body `a` at the near node relative to the span
// to the far node - `ω_a − n·(v_far − v_near)/L`, the span's own turn rate -
// bounded by the substep's tension impulse `load` times `μ·r`.
class PinRow {
  private impulse = 0;

  reset(): void {
    this.impulse = 0;
  }

  solve(a: PhysicsBody2D, pa: Vec2, b: PhysicsBody2D, pb: Vec2, load: number): void {
    // A steered ball's own turn is the aim's to pay (see `RopePins`).
    if (load <= 0 || (a instanceof RigidBody2D && a.kinematicRotation)) return;
    const span = pb.sub(pa);
    const length = span.length();
    if (length < 1e-6) return;
    const d = span.div(length);
    const n = new Vec2(-d.y, d.x);
    const ja = 1 + d.dot(pa.sub(a.globalPosition)) / length;
    const invMa = invMassOf(a);
    const invIa = invInertiaOf(a);
    // A static pin turns with whatever moves it (a mover), and resists the
    // span's turn alone.
    let rate =
      a instanceof RigidBody2D
        ? ja * a.angularVelocity + n.dot(a.linearVelocity) / length
        : (a instanceof AnimatableBody2D ? a.angularVelocity : 0) + n.dot(a.velocityAtPoint(pa)) / length;
    let k = ja * ja * invIa + invMa / (length * length);
    let jb = 0;
    let invMb = 0;
    let invIb = 0;
    if (k <= 0 && !(b instanceof RigidBody2D)) return;
    if (b instanceof RigidBody2D) {
      // A steered ball's knot is read at its centre, as every row reads it
      // (`knotVelocity`): the spin is the aim's, not the pin's to answer.
      jb = b.kinematicRotation ? 0 : -d.dot(pb.sub(b.globalPosition)) / length;
      invMb = invMassOf(b);
      invIb = invInertiaOf(b);
      rate += jb * b.angularVelocity - n.dot(b.linearVelocity) / length;
      k += invMb / (length * length) + jb * jb * invIb;
    } else {
      rate -= n.dot(b.velocityAtPoint(pb)) / length;
    }
    if (k <= 0) return;
    const bound = PIN_FRICTION * CHAIN_LINK_BAR * load;
    const next = Math.min(bound, Math.max(-bound, this.impulse - rate / k));
    const p = next - this.impulse;
    this.impulse = next;
    if (p === 0) return;
    if (a instanceof RigidBody2D) {
      a.angularVelocity += ja * p * invIa;
      a.linearVelocity = a.linearVelocity.add(n.mul((p * invMa) / length));
    }
    if (b instanceof RigidBody2D) {
      b.linearVelocity = b.linearVelocity.sub(n.mul((p * invMb) / length));
      b.angularVelocity += jb * p * invIb;
    }
  }
}

// The two pins of a rope (see `PIN_FRICTION`): at each end, the span leaving
// the end's own node. A static end is a pin like any other: a chain swinging
// from a hook in the ceiling turns on it. Not where the chain wraps the end's
// body before it leaves - a coil on the ball, a chain wound round a slat's
// edge to its knot: the chain bends at the wrap there, sliding over the edge,
// and the link on the pin no longer turns against that body; counted, a ball
// wound round a slat had the slat's turn locked to its chain's at 4 kN and
// the bridge stretched 55 mm against the 50 it may (`session-394f-bridge`).
// And not a steered ball's cuff: its turn there is the aim's, driven, and paid
// by the steering.
class RopePins {
  private readonly head = new PinRow();
  private readonly tail = new PinRow();

  reset(): void {
    this.head.reset();
    this.tail.reset();
  }

  solve(rope: Rope, load: number): void {
    if (load <= 0) return;
    const nodes = rope.path();
    if (nodes.length < 2) return;
    const first = nodes[0]!.contact.obj;
    const second = nodes[1]!.contact.obj;
    if (first instanceof PhysicsBody2D && second instanceof PhysicsBody2D && second !== first) {
      this.head.solve(first, nodes[0]!.contact.globalPosition, second, nodes[1]!.contact.globalPosition, load);
    }
    const n = nodes.length;
    const last = nodes[n - 1]!.contact.obj;
    const before = nodes[n - 2]!.contact.obj;
    if (last instanceof PhysicsBody2D && before instanceof PhysicsBody2D && before !== last) {
      this.tail.solve(last, nodes[n - 1]!.contact.globalPosition, before, nodes[n - 2]!.contact.globalPosition, load);
    }
  }
}

// Impulse `j` along the rope, delivered to one path body through its term.
function applyTerm(t: RopeRowTerm, j: number): void {
  const body = t.body;
  if (!(body instanceof RigidBody2D)) return;
  body.linearVelocity = body.linearVelocity.add(t.dir.mul(j * t.ma * body.inverseMass));
  body.angularVelocity += j * t.ma * t.arm * invInertiaOf(body);
}

// Every anchor in the level, by id. A chain names its two ends and nothing else
// - which body an end is on is a question about where its anchor lives, and this
// is where that is answered once for the whole list rather than by scanning the
// bodies per chain. A vine names ONE end the same way, and reads the same map.
export function collectAnchorSites(built: BuiltBodies): Map<number, AnchorSite> {
  const anchors = new Map<number, AnchorSite>();
  for (const b of built.bodies) {
    for (const o of b.data.objects) {
      if (!isAnchorObject(o)) continue;
      // First id wins. Ids are unique by construction, and a file that has been
      // hand-edited into a collision gets the earlier anchor rather than a
      // silently-last-one-wins that depends on body order.
      if (!anchors.has(o.id)) anchors.set(o.id, { built: b, anchor: o });
    }
  }
  return anchors;
}

// An anchor and the body it is on, which is the pair every chain end resolves to.
export interface AnchorSite {
  readonly built: BuiltBodies["bodies"][number];
  readonly anchor: AnchorObjectData;
}

// Where the anchor IS, on the body as it stands now. The authored placement is
// written in the authored frame, and a sprung body spawns displaced from it
// (`applyRestPose`), so on a displaced body the material point is resolved
// through `localPlacement` - the authored-frame correspondence `BuiltBody`
// records - and then carried by the body's own transform, exactly as
// decoration and geometry objects ride it. Resolved through the authored
// placement instead, the anchor lands at the authored SPOT on a body that is
// no longer there, a point off the intended one by the whole droop.
//
// The undisplaced path keeps the plain `worldPlacement` answer deliberately:
// the local round trip costs two rotations of float noise, and every level
// with no sprung body must stay bit-identical.
export function anchorWorldPoint(site: AnchorSite): Vec2 {
  const b = site.built;
  const body = b.body;
  const authored = worldPlacement(b.data, site.anchor).pos;
  if (
    !body ||
    (body.globalPosition.x === b.origin.x &&
      body.globalPosition.y === b.origin.y &&
      body.globalRotation === b.rotation)
  ) {
    return authored;
  }
  const local = localPlacement(b, site.anchor);
  return body.globalPosition.add(local.pos.rotated(body.globalRotation));
}

function buildOne(
  world: World,
  c: ChainData,
  anchors: Map<number, AnchorSite>,
  scene: PhysicsBody2D[],
): SceneChain | null {
  const siteA = anchors.get(c.a);
  const siteB = anchors.get(c.b);
  if (!siteA || !siteB) return null;
  const objA = siteA.built.body;
  const objB = siteB.built.body;
  if (!objA || !objB || objA === objB) return null;
  // The anchor is placed in its BODY's frame, so its world point is the body's
  // transform applied to it - the same `worldPlacement` every other object goes
  // through. The surface snap that follows is unchanged: an anchor left in a
  // body's interior leaves the chain's span starting INSIDE that body, and the
  // wrap generator resolves that as a self-intersection.
  const tieA = tieToSurface(objA, anchorWorldPoint(siteA));
  const tieB = tieToSurface(objB, anchorWorldPoint(siteB));
  // The contact names the piece of the body it lands on, which is what the wrap
  // resolvers walk when the chain has to bend around it.
  const contact = (obj: CollisionObject2D, tie: { point: Vec2; shapeIndex: number }) =>
    new RopeContact(obj, tie.point.sub(obj.globalPosition), tie.shapeIndex);
  const start = contact(objA, tieA);
  const end = contact(objB, tieB);

  // The wrap points, in order from `a` to `b`. Each is an anchor on a body
  // that builds; one that is not there, or is on a body that does not build,
  // is skipped rather than dropping the chain - a chain with its two ends is
  // still a chain, as a vine with a dead second anchor is still a vine.
  const vias: { obj: PhysicsBody2D; tie: { point: Vec2; shapeIndex: number } }[] = [];
  for (const id of c.via ?? []) {
    const site = anchors.get(id);
    const obj = site?.built.body;
    // A wrap point is on a body a rope can bend around, which an area is not.
    if (!site || !(obj instanceof PhysicsBody2D)) continue;
    vias.push({ obj, tie: snapToCorner(obj, anchorWorldPoint(site)) });
  }
  // Consecutive wrap points on ONE piece are one wrap of it - a pulley an
  // author ringed with seven points is still a chain going over a pulley once
  // - and each run becomes the wrap nodes the scan would have left had the
  // chain been dragged over that piece (see `authoredWrap`). The run's
  // neighbours are the authored points either side of it.
  const runs: { obj: PhysicsBody2D; ties: { point: Vec2; shapeIndex: number }[] }[] = [];
  for (const v of vias) {
    const last = runs[runs.length - 1];
    if (last && last.obj === v.obj && last.ties[0]!.shapeIndex === v.tie.shapeIndex) {
      last.ties.push(v.tie);
    } else {
      runs.push({ obj: v.obj, ties: [v.tie] });
    }
  }
  const wraps: RopeWrap[] = [];
  runs.forEach((run, i) => {
    const prev = i === 0 ? tieA.point : runs[i - 1]!.ties[runs[i - 1]!.ties.length - 1]!.point;
    const next = i === runs.length - 1 ? tieB.point : runs[i + 1]!.ties[0]!.point;
    for (const w of authoredWrap(run.obj, run.ties, prev, next)) wraps.push(w);
  });
  // ...and its body is in the set this chain is solved against - the level's
  // wrappable bodies, which every solid body that builds is in - so the corner
  // is re-found as the bodies move and a sibling corner of the same body
  // catches the chain the way it would catch the ball's. A wrap point on a
  // body that is NOT in that set (pass-through scenery) is a node the scan
  // could never re-find; it is seeded all the same and culled the first time
  // the chain pulls straight past it, which is what a wrap on a body the rope
  // cannot hold means.

  // Absent length = exactly taut as authored, which is what dragging a chain out
  // between two bodies in the editor means - measured along the path as the
  // anchors and wrap points actually land, so "taut" is taut (see
  // `SceneChain`).
  return new SceneChain(world, start, end, c.length ?? null, c.color ?? null, scene, wraps);
}

// ---------------------------------------------------------------------------
// Tied chains (`ChainData.through`): one rope knotted through many bodies,
// solved by the island solver in `engine/ties.ts` rather than by `Rope`. The
// reasoning and the measurements are in `plans/rope-bridge.md`; what this half
// does is turn the authored list of anchors into knots on bodies and
// segment lengths, refuse what cannot be simulated, and settle the result at
// build so a level arrives with its bridge hanging and asleep.
// ---------------------------------------------------------------------------

export function isTieChain(c: ChainData): boolean {
  return (c.through?.length ?? 0) > 0;
}

// Build every tied chain in `data` against the bodies `buildLevelBodies` made
// and register each with the world's island solver. The same tolerances as
// `buildOne`: an END naming an anchor that is not there, or on a body that
// builds nothing, drops the chain; a TIE that does is skipped and the segments
// either side are joined, as a dead wrap point is skipped.
export function buildTieChains(data: LevelData, built: BuiltBodies, world: World): TieChain[] {
  const anchors = collectAnchorSites(built);
  const chains: TieChain[] = [];
  for (const c of data.chains ?? []) {
    if (!isTieChain(c)) continue;
    const chain = buildTie(c, anchors);
    if (!chain) continue;
    chains.push(chain);
    world.ties.add(chain);
  }
  return chains;
}

function buildTie(c: ChainData, anchors: Map<number, AnchorSite>): TieChain | null {
  const ids = [c.a, ...(c.through ?? []), c.b];
  const points: TiePoint[] = [];
  for (let i = 0; i < ids.length; i++) {
    const site = anchors.get(ids[i]!);
    const obj = site?.built.body;
    if (!site || !(obj instanceof PhysicsBody2D)) {
      if (i === 0 || i === ids.length - 1) return null;
      continue;
    }
    // The knot is on the body's surface, as a chain end is (`tieToSurface`),
    // and is carried in the body's own frame from then on.
    const tie = tieToSurface(obj, anchorWorldPoint(site));
    const local = tie.point.sub(obj.globalPosition).rotated(-obj.globalRotation);
    points.push(new TiePoint(obj, local));
  }
  // A pivot turns on a bearing and a spring body hangs on its stem. The
  // island steps both as the world does (`islandOwns`), but no tied chain
  // knotted to one has ever been built or measured - a bridge slung from a
  // sprung branch - so one is refused until it has a rig.
  for (const p of points) {
    const body = p.body;
    if (body instanceof RigidBody2D && (body.pivot || body.spring !== null)) {
      console.warn(`chain ${c.a}-${c.b}: tied to a pivot or spring body; not built`);
      return null;
    }
  }
  const gaps: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a.body === b.body) continue;
    gaps.push(a.world().distanceTo(b.world()));
  }
  // Every knot on one body is nothing to constrain.
  if (gaps.length === 0) return null;
  const slack = c.slack ?? 0;
  const lengths = gaps.map((gap, k) => {
    const authored = c.lengths?.[k];
    return authored !== undefined && authored > 0 ? authored : gap * (1 + slack);
  });
  // A straight bridge with no slack is a cable under transverse load, whose
  // tension is unbounded as the sag goes to zero; it builds all the same,
  // because the rows are soft and bound it (`bridge-taut` measures how far
  // it stretches), where the chain phase spent its sweep cap on it for ever.
  // It is said once, since a level that looks taut and hangs stretched is
  // an authoring mistake with nothing on screen to say why.
  if (lengths.every((l, k) => l <= gaps[k]! + 1e-9) && gaps.length > 1) {
    console.warn(
      `chain ${c.a}-${c.b}: a tied chain with no slack hangs on the softness of its rows; ` +
        `give it \`slack\` or a length per segment to hang as authored`,
    );
  }
  const substeps = Math.max(
    1,
    Math.min(MAX_TIE_SUBSTEPS, Math.round(c.substeps ?? DEFAULT_TIE_SUBSTEPS)),
  );
  return new TieChain(points, lengths, substeps, c.color ?? null);
}

// Settle the island solver's units at build - the authored chains' rows and
// the tied chains: up to `SETTLE_AT_BUILD_CAP` frames of the island solver
// with sleep on, so a level arrives with its lanterns hanging and its bridge
// sagging, asleep, rather than spending the first seconds of play finding its
// rest. Left to settle live, every lantern in the ball arena swung itself out
// over the first five seconds of play (180 to 330 frames to sleep on
// `session-392f`), which is the whole of a short session spent paying for
// scenery.
//
// The same clearance rule: only a unit whose every body hangs clear of
// anything that can move and of every area is settled here, because the loop
// runs the islands and nothing else - a slat under a crate would be solved
// against a crate nothing is stepping. Static scenery near a body is allowed,
// since the island solves its own contacts with the scenery; that is how a
// bridge whose end slats rest on their posts settles here. Units sharing a
// body with one that cannot be settled are left with it.
const SETTLE_AT_BUILD_CAP = 600;
const CLEAR_MARGIN = 0.05;

export function settleTiesAtBuild(world: World, units: readonly IslandUnit[]): void {
  const clear = new Set<IslandUnit>();
  for (const unit of units) if (tieClearAtBuild(world, unit)) clear.add(unit);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of clear) {
      for (const other of units) {
        if (other === unit || clear.has(other)) continue;
        if (unit.bodies.some((b) => other.bodies.includes(b))) {
          clear.delete(unit);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  if (clear.size === 0) return;
  const dt = 1 / 60;
  const bodies: RigidBody2D[] = [];
  for (const unit of clear) {
    for (const body of unit.bodies) if (!bodies.includes(body)) bodies.push(body);
  }
  for (let frame = 0; frame < SETTLE_AT_BUILD_CAP; frame++) {
    let awake = false;
    for (const unit of clear) if (!unit.asleep) awake = true;
    if (!awake) break;
    world.stepTiesStandalone(dt, clear);
    world.settleSleep(bodies);
  }
}

function tieClearAtBuild(world: World, chain: IslandUnit): boolean {
  for (const body of chain.bodies) {
    if (!body.canSleep) return false;
    for (const s of body.getShapes()) {
      const c = s.globalPosition;
      const e = s.extents();
      const minX = c.x - e.x - CLEAR_MARGIN;
      const minY = c.y - e.y - CLEAR_MARGIN;
      const maxX = c.x + e.x + CLEAR_MARGIN;
      const maxY = c.y + e.y + CLEAR_MARGIN;
      for (const o of world.queryShapes(minX, minY, maxX, maxY)) {
        const owner = o.owner;
        if (owner === body || !(owner instanceof PhysicsBody2D)) continue;
        // Another tied body is in the same solve and is fine; anything else
        // that can move is not.
        if (owner instanceof RigidBody2D && owner.tied) continue;
        if (owner.isMobile || !(owner instanceof StaticBody2D)) return false;
      }
      for (const area of world.areas) {
        if (area.removed) continue;
        for (const a of area.getShapes()) {
          const ac = a.globalPosition;
          const ae = a.extents();
          if (ac.x + ae.x >= minX && ac.x - ae.x <= maxX && ac.y + ae.y >= minY && ac.y - ae.y <= maxY) {
            return false;
          }
        }
      }
    }
  }
  return true;
}
