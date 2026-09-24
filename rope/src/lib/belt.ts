// Conveyor belts - a band wrapped round the outside of N wheels whose surface
// carries whatever rests on it.
//
// A belt is a list of WHEELS (centre, radius) and a band `thickness` deep lying
// on them, so its outer surface round wheel `i` is a circle of radius
// `r_i + thickness`. The surface is the CONVEX HULL of those discs - a taut
// band round pins - which alternates an arc on a wheel with a straight run
// along the external tangent to the next, and is smooth (tangent-continuous)
// everywhere. Two wheels are the old two-roller belt and fall out of the same
// code. Every wheel must lie ON the hull: one inside it would be an idler
// pressing the band inward, a different path that is not built. A disc inside
// another, a wheel of no size and a band of no thickness are not belts either
// (`buildBeltLoop` throws, naming the wheel).
//
// What a belt is NOT is a mover. Its geometry never moves - only its material
// does, and the straight runs cannot be expressed as any body's transform at
// all - so it is a static body with a SURFACE VELOCITY, which is what Box2D
// does for a conveyor (`b2SurfaceMaterial.tangentSpeed` in v3,
// `b2Contact::SetTangentSpeed` in v2). The engine's one hook for that is
// `PhysicsBody2D.velocityAtPoint`, which every carry path already reads, so
// `ConveyorBody` answering "belt speed along the loop's tangent at the nearest
// point of the loop" is the whole of the carry for the rigid paths. See
// docs/conveyors.md.
//
// The loop is parameterised by arc length `s` in [0, P) along its OUTER
// surface, in the body's local frame, over the segments `BeltLoop`
// (engine/shapes.ts) lists: the arc on wheel 0, the run to the next wheel round
// the hull, its arc, and so on back to wheel 0.
//
// THE SENSE CONVENTION, which is the one thing an author has to learn:
// increasing `s` turns the angle about each wheel up, which in this y-down
// frame is CLOCKWISE ON SCREEN. So on a two-wheel belt drawn left to right, a
// POSITIVE speed carries the TOP run toward the second wheel (rightward) and the
// bottom run back; a negative speed runs the other way. `cli belts` `sense`
// asserts it.
//
// Every function here is pure - no clock, no DOM - and every transcendental
// goes through `engine/dmath.ts`, since this is sim code (`cli dmath`).

import { Vec2 } from "../engine/vec2";
import { Mathf, mod } from "../engine/mathf";
import { dmath } from "../engine/dmath";
import { StaticBody2D, bumpTransformEpoch, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import type { BeltLoop, BeltSegment } from "../engine/shapes";
import { PATH_FLATTEN_STEP } from "./path";
import { RopeAttachment, RopeContact } from "./ropeContact";

const TAU = Math.PI * 2;

// A wheel as the geometry takes it: a centre in whatever frame the loop is
// built in, and the WHEEL's radius (the band's inner surface).
export interface BeltWheel {
  readonly c: Vec2;
  readonly r: number;
}

// How near a disc may come to the far side of a hull tangent and still count
// as on it, relative to the size of the whole belt. It is what makes a wheel
// that exactly TOUCHES the band - three equal wheels in a row - part of the
// loop (with an arc of no sweep) rather than an idler the rounding put a
// femtometre inside it.
const HULL_TOLERANCE = 1e-9;

// The external tangent from disc `i` to disc `j` that keeps both on the loop's
// inner side in its positive sense: the line `n·x = h`, touching disc i at
// `from` and disc j at `to`, travelled from i to j. `n` is the outward normal.
//
// The tangent points sit where the outward normal n satisfies
// n·u = (R_i - R_j)/d, the same for both discs (that is what makes the line
// tangent to both), so n is u turned by -beta with cos(beta) = k - turned
// without trig, from k and its partner. -beta rather than +beta is the side the
// loop's positive sense runs along from i to j: on a two-wheel belt drawn left
// to right it is the TOP run (y being down).
interface Tangent {
  readonly n: Vec2;
  readonly h: number;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly length: number;
}

function tangentBetween(ci: Vec2, ri: number, cj: Vec2, rj: number): Tangent {
  const e = cj.sub(ci);
  const d = e.length();
  const u = e.div(d);
  const k = (ri - rj) / d;
  const sn = Mathf.sqrt(1 - k * k);
  const n = new Vec2(u.x * k + u.y * sn, -u.x * sn + u.y * k);
  const from = ci.add(n.mul(ri));
  const to = cj.add(n.mul(rj));
  return { n, h: n.dot(from), from, to, length: d * sn };
}

// The loop round `wheels` with a band `thickness` deep, in whatever frame the
// centres are given in. `pieceAt` names the mounted piece under each segment;
// the default is the order `makePieces` builds them in (every wheel's disc in
// authored order, then every run's quad in loop order), for a loop that is not
// yet mounted.
//
// THE HULL. For each ordered pair of discs (radius `r + thickness`) the one
// external tangent that runs from i to j in the loop's sense is a hull edge iff
// every other disc lies on its inner side. Brute force over the pairs - N² lines
// each tested against N discs - which at the handful of wheels a belt drive has
// is nothing, and is far easier to get right than rotating calipers. Each disc
// on the hull has exactly one outgoing edge; where several qualify (collinear
// discs of one size, the middle one just touching the band) the SHORTEST wins,
// so the band visits the touching wheel with an arc of no sweep rather than
// skipping it. The loop is then followed from wheel 0 until it closes.
//
// Refused, loudly and naming the wheel, as a curve of one node is refused at
// the build: fewer than two wheels, a wheel of no size, a band of no
// thickness, a disc inside (or touching the inside of) another - which has no
// external tangent - and a wheel strictly inside the hull, which no edge
// touches.
export function buildBeltLoop(
  wheels: readonly BeltWheel[],
  thickness: number,
  pieceAt?: readonly number[],
): BeltLoop {
  const n = wheels.length;
  if (n < 2) throw new Error(`a belt needs at least two wheels (it has ${n})`);
  if (!(thickness > 0)) throw new Error(`a belt's thickness must be positive (it is ${thickness})`);
  const describe = (i: number): string => {
    const w = wheels[i]!;
    return `wheel ${i} (${w.c.x}, ${w.c.y}, r ${w.r})`;
  };
  wheels.forEach((w, i) => {
    if (!(w.r > 0)) throw new Error(`belt ${describe(i)} has no size`);
  });
  const R = wheels.map((w) => w.r + thickness);
  let extent = 0;
  for (let i = 0; i < n; i++) {
    extent = Mathf.max(extent, Mathf.abs(wheels[i]!.c.x) + Mathf.abs(wheels[i]!.c.y) + R[i]!);
    for (let j = i + 1; j < n; j++) {
      const d = wheels[j]!.c.sub(wheels[i]!.c).length();
      // No external tangent: one disc inside (or touching the inside of) the
      // other. Named as the smaller inside the larger.
      if (!(d > Mathf.abs(R[i]! - R[j]!))) {
        const [inner, outer] = R[i]! < R[j]! ? [i, j] : [j, i];
        throw new Error(`belt ${describe(inner)} lies inside ${describe(outer)}`);
      }
    }
  }
  const tol = HULL_TOLERANCE * extent;
  // Every hull edge, by the disc it leaves: the external tangents with every
  // other disc on their inner side.
  const edges: { to: number; t: Tangent; angle: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const out: { to: number; t: Tangent; angle: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const t = tangentBetween(wheels[i]!.c, R[i]!, wheels[j]!.c, R[j]!);
      let supports = true;
      for (let m = 0; m < n && supports; m++) {
        if (m === i || m === j) continue;
        if (t.n.dot(wheels[m]!.c) + R[m]! > t.h + tol) supports = false;
      }
      if (supports) out.push({ to: j, t, angle: dmath.atan2(t.n.y, t.n.x) });
    }
    edges.push(out);
  }
  // How far the normal turns, in the loop's sense, from `from` to `to`: a
  // turn a hair under a whole one is two normals a rounding apart the wrong way
  // round, and is no turn at all.
  const turn = (from: number, to: number): number => {
    const a = mod(to - from, TAU);
    return a > TAU - 1e-9 ? 0 : a;
  };
  // Walk the hull from a disc certainly on it - the one reaching furthest in
  // +x, whose rim at angle 0 is on the loop - leaving each disc by the edge its
  // normal turns LEAST to from the one it arrived along (ties to the shorter
  // run). The turning rule rather than "the one edge out of each disc" is what
  // walks a degenerate drive right: a wheel that only touches the band - the
  // middle of three in a row - has an edge out on each side, and is visited
  // once going each way.
  let start = 0;
  for (let i = 1; i < n; i++) {
    const a = wheels[i]!.c.x + R[i]!;
    const b = wheels[start]!.c.x + R[start]!;
    if (a > b || (a === b && wheels[i]!.c.y > wheels[start]!.c.y)) start = i;
  }
  const visits: { wheel: number; arriving: number; leaving: { to: number; t: Tangent; angle: number } }[] = [];
  let cur = start;
  let arriving = 0;
  for (let step = 0; ; step++) {
    let best: { to: number; t: Tangent; angle: number } | null = null;
    let bestTurn = Infinity;
    for (const e of edges[cur]!) {
      const a = turn(arriving, e.angle);
      if (a < bestTurn - 1e-12 || (a <= bestTurn + 1e-12 && best !== null && e.t.length < best.t.length)) {
        best = e;
        bestTurn = a;
      }
    }
    if (best === null) throw new Error(`belt hull has no way out of ${describe(cur)}`);
    // Closed: about to leave the start disc by the edge the walk began with.
    if (visits.length > 0 && cur === start && best === visits[0]!.leaving) break;
    if (step > 2 * n + 2) throw new Error("belt hull did not close");
    visits.push({ wheel: cur, arriving, leaving: best });
    arriving = best.angle;
    cur = best.to;
  }
  // The walk began at an arbitrary angle on the start disc; its first arc
  // really begins where the band arrives there, off the last edge.
  visits[0]!.arriving = visits[visits.length - 1]!.leaving.angle;
  for (let i = 0; i < n; i++) {
    if (!visits.some((v) => v.wheel === i)) {
      throw new Error(
        `belt ${describe(i)} lies inside the loop the other wheels make: every wheel must touch the band (an idler pressing it inward is not built)`,
      );
    }
  }
  // `s = 0` where the band arrives on wheel 0 - on its first visit with an
  // arc, when it is visited twice.
  const m = visits.length;
  let first = visits.findIndex((v) => v.wheel === 0 && turn(v.arriving, v.leaving.angle) > 0);
  if (first < 0) first = visits.findIndex((v) => v.wheel === 0);

  // Arc on each visited wheel from the normal it arrives along to the one it
  // leaves along, then the run to the next.
  const segments: BeltSegment[] = [];
  const pieces: number[] = [];
  let turned = 0;
  for (let k = 0; k < m; k++) {
    const v = visits[(first + k) % m]!;
    const theta = v.arriving;
    const sweep = turn(theta, v.leaving.angle);
    turned += sweep;
    segments.push({ kind: "arc", wheel: v.wheel, centre: wheels[v.wheel]!.c, radius: R[v.wheel]!, theta, sweep });
    pieces.push(v.wheel);
    const leaving = v.leaving.t;
    const run = leaving.to.sub(leaving.from);
    segments.push({
      kind: "run",
      from: leaving.from,
      to: leaving.to,
      dir: run.div(leaving.length),
      normal: leaving.n,
      length: leaving.length,
    });
    pieces.push(n + k);
  }
  if (Mathf.abs(turned - TAU) > 1e-6) {
    throw new Error(`belt hull turned ${turned} rad rather than one turn`);
  }
  const cum = [0];
  for (const seg of segments) cum.push(cum[cum.length - 1]! + segmentLength(seg));
  return {
    wheels: wheels.map((w) => ({ c: w.c, r: w.r })),
    thickness,
    segments,
    cum,
    total: cum[cum.length - 1]!,
    pieceAt: pieceAt ? [...pieceAt] : pieces,
  };
}

function segmentLength(seg: BeltSegment): number {
  return seg.kind === "arc" ? seg.radius * seg.sweep : seg.length;
}

// `s` reduced into [0, P). Only the point, tangent and normal reduce; an arc
// length handed around is otherwise a running total (see docs/conveyors.md).
function reduce(loop: BeltLoop, s: number): number {
  const r = mod(s, loop.total);
  return r >= loop.total ? 0 : r;
}

// Which segment a reduced `s` is on: the last one starting at or before it. An
// arc of no sweep starts where the run after it does and is never answered.
function segmentOf(loop: BeltLoop, s: number): number {
  const c = loop.cum;
  let lo = 0;
  let hi = loop.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The segment under arc length `s`, and how far along it `s` is.
export function beltSegmentAt(loop: BeltLoop, s: number): { index: number; segment: BeltSegment; along: number } {
  const r = reduce(loop, s);
  const index = segmentOf(loop, r);
  return { index, segment: loop.segments[index]!, along: r - loop.cum[index]! };
}

// The point of the loop at arc length `s`.
export function beltPointAt(loop: BeltLoop, s: number): Vec2 {
  const { segment: seg, along } = beltSegmentAt(loop, s);
  if (seg.kind === "run") return seg.from.add(seg.dir.mul(along));
  const t = seg.theta + along / seg.radius;
  return seg.centre.add(new Vec2(Mathf.cos(t), Mathf.sin(t)).mul(seg.radius));
}

// The unit tangent at `s`, in the direction of increasing `s`.
export function beltTangentAt(loop: BeltLoop, s: number): Vec2 {
  const { segment: seg, along } = beltSegmentAt(loop, s);
  if (seg.kind === "run") return seg.dir;
  const t = seg.theta + along / seg.radius;
  return new Vec2(-Mathf.sin(t), Mathf.cos(t));
}

// The outward unit normal at `s`: the tangent's Godot orthogonal, as for a
// polygon edge, since the loop winds the way every polygon here does.
export function beltNormalAt(loop: BeltLoop, s: number): Vec2 {
  return beltTangentAt(loop, s).orthogonal();
}

// The arc length of the point of the loop nearest `p`, and the squared
// distance to it.
//
// Closed form: project onto each run (clamped to it) and onto each arc (only
// when the angle lands inside the arc's range - an angle outside it is nearer
// one of the arc's ends, and both ends are ends of a run too), and take the
// nearest. On the tangent seams two candidates coincide, so the answer is
// continuous across them. Ties go to the earlier segment.
export function beltNearest(loop: BeltLoop, p: Vec2): { s: number; distSq: number } {
  let bestS = 0;
  let bestSq = Infinity;
  loop.segments.forEach((seg, i) => {
    const s0 = loop.cum[i]!;
    if (seg.kind === "run") {
      const t = Mathf.clamp(p.sub(seg.from).dot(seg.dir), 0, seg.length);
      const dSq = seg.from.add(seg.dir.mul(t)).sub(p).lengthSquared();
      if (dSq < bestSq) {
        bestSq = dSq;
        bestS = s0 + t;
      }
      return;
    }
    const q = p.sub(seg.centre);
    const len = q.length();
    // A point at a wheel's very centre is equidistant from its whole rim, so
    // any answer is right; the arc's start is a deterministic one.
    const delta = len > 1e-12 ? mod(dmath.atan2(q.y, q.x) - seg.theta, TAU) : 0;
    if (delta > seg.sweep) return;
    const on = len > 1e-12 ? seg.centre.add(q.mul(seg.radius / len)) : beltPointAt(loop, s0);
    const dSq = on.sub(p).lengthSquared();
    if (dSq < bestSq) {
      bestSq = dSq;
      bestS = s0 + seg.radius * delta;
    }
  });
  return { s: bestS >= loop.total ? bestS - loop.total : bestS, distSq: bestSq };
}

// The arc length of the point of the loop nearest `p`.
export function beltClosestS(loop: BeltLoop, p: Vec2): number {
  return beltNearest(loop, p).s;
}

// The surface's velocity where `p` touches it: the loop's tangent at the
// nearest point, times the signed speed. In the loop's own frame.
export function beltSpeedAt(loop: BeltLoop, speed: number, p: Vec2): Vec2 {
  return beltTangentAt(loop, beltClosestS(loop, p)).mul(speed);
}

// The band along each run as the convex quad it collides as, in loop order:
// the outer run line from its exit to its entry tangent point, and the same
// line `thickness` inside it, which is the inner run - tangent to the two
// wheels themselves. Wound as every polygon is.
export function beltRunQuads(loop: BeltLoop): Vec2[][] {
  const out: Vec2[][] = [];
  for (const seg of loop.segments) {
    if (seg.kind !== "run") continue;
    const inward = seg.normal.mul(-loop.thickness);
    out.push([seg.from, seg.to, seg.to.add(inward), seg.from.add(inward)]);
  }
  return out;
}

// Which mounted piece is under arc length `s` (see `BeltLoop.pieceAt`).
export function beltPieceAt(loop: BeltLoop, s: number): number {
  return loop.pieceAt[segmentOf(loop, reduce(loop, s))]!;
}

// The loop flattened for drawing: every arc at `step` or finer, the runs as
// their two ends. Wound as every polygon is, starting where the band arrives on
// wheel 0, with no point repeated.
//
// `inset` draws the loop that far INSIDE the surface: each arc at its radius
// less the inset and each run moved in along its normal, the same tangents
// offset. At the band's thickness that is the band's inner surface, which lies
// on the wheels themselves.
export function beltOutline(loop: BeltLoop, step = PATH_FLATTEN_STEP, inset = 0): Vec2[] {
  const out: Vec2[] = [];
  const segs = loop.segments;
  segs.forEach((seg, i) => {
    if (seg.kind === "run") return;
    const radius = seg.radius - inset;
    const at = (t: number): Vec2 => seg.centre.add(new Vec2(Mathf.cos(t), Mathf.sin(t)).mul(radius));
    if (seg.sweep > 0) {
      const n = Math.max(1, Math.ceil((radius * seg.sweep) / step));
      for (let k = 0; k < n; k++) out.push(at(seg.theta + (seg.sweep * k) / n));
    }
    // The arc's end, which is where the run after it starts.
    const run = segs[i + 1];
    out.push(run && run.kind === "run" ? run.from.sub(run.normal.mul(inset)) : at(seg.theta + seg.sweep));
  });
  return out;
}

// A static body whose surface runs: the body a level builds for any static
// that authors a belt (`buildLevelBodies`).
//
// Its transform never moves, so `isMobile` stays false - the AABB tree, the
// rope's sweep baselines and the ledge states all see a static, which it is.
// What it adds is `surfaceMoves` and a `velocityAtPoint` that answers the
// belt's surface speed, and a belt authored at speed 0 answers neither: it is
// then exactly the plain static its pieces would be, down to returning
// the same `Vec2.ZERO`.
export class ConveyorBody extends StaticBody2D {
  // Set once at build (`attachBelts`), when the pieces' speeds are known: does
  // any belt on this body run at all? A static's pieces never change speed, so
  // this is a fact about the body rather than a question to re-ask per call.
  running = false;

  override get surfaceMoves(): boolean {
    return this.running;
  }

  // The velocity of the nearest belt's surface at `worldPoint`: the point is
  // taken into the body's frame, projected onto each belt this body carries,
  // and the nearest one's tangent speed is turned back into the world. One
  // belt per body is the normal case; the loop is for a body that authored two.
  override velocityAtPoint(worldPoint: Vec2): Vec2 {
    if (!this.running) return Vec2.ZERO;
    const local = worldPoint.sub(this.globalPosition).rotated(-this.globalRotation);
    let bestSq = Infinity;
    let best: Vec2 = Vec2.ZERO;
    let last: BeltLoop | null = null;
    for (const shape of this.getShapes()) {
      const loop = shape.belt;
      // The pieces of one belt hold the same loop and arrive together.
      if (loop === null || loop === last) continue;
      last = loop;
      if (shape.beltSpeed === 0) continue;
      const near = beltNearest(loop, local);
      if (near.distSq < bestSq) {
        bestSq = near.distSq;
        best = beltTangentAt(loop, near.s).mul(shape.beltSpeed);
      }
    }
    return best.rotated(this.globalRotation);
  }
}

// The chain's end anchored to a running belt: carried round the loop with the
// surface it bit (docs/conveyors.md, "The ride").
//
// The third moving attachment beside a rail's clamp and a mud embed, and the
// simplest, because it is DRIVEN rather than solved: nothing the chain does
// moves it, and where it stands is a pure function of the frame,
//
//   s(frame) = s0 + speed · ((frame − frame0) · dt),
//
// never accumulated and never reduced here - `beltPointAt` reduces it. The
// running total is the rotor's argument (docs/movers.md): a reduced `s` would
// be a whole lap's jump on the seam frame to anything that differenced it, and
// an accumulated one would be a replay that lands the anchor by the bits of
// every frame before it rather than by the frame.
//
// The contact stands `standoff` off the surface along the cuff's facing - the
// manacle's hinge pin for the ball's chain, nothing for the grapple's hook -
// and the facing keeps the angle to the surface's outward normal it arrived
// at (`phi`), so a cuff carried round a wheel turns with the wheel rather
// than keeping its world angle. The cuff piece mounted on the belt's body
// (`BallPlayer.mountCuff`) is carried and turned with it, and the contact's
// piece index follows `s` (`beltPieceAt`), so the wrap resolvers walk the
// wheel's disc while the anchor is on an arc and that run's quad on a run.
//
// The anchor's velocity is not stored: `Rope.velocityAt` asks the body, and a
// `ConveyorBody` answers the belt's surface speed at the pin, which is the
// carry itself on a run.
export class RopeRide extends RopeAttachment {
  // The frame whose position the contact holds, so a second call in the same
  // frame is free. Not state the answer depends on.
  private carriedFrame: number;
  // The cuff's facing where it was last carried, in the body's frame: what the
  // renderers draw the cuff at (`BallPlayer.manacleFacing`).
  facingLocal: Vec2;
  // The mounted cuff piece, carried with the contact; null for the grapple's
  // hook and for a bite where the ball already stood (`mountCuff`).
  cuff: CollisionShape2D | null = null;

  private constructor(
    contact: RopeContact,
    readonly loop: BeltLoop,
    readonly speed: number,
    readonly s0: number,
    readonly frame0: number,
    readonly dt: number,
    readonly phi: number,
    readonly standoff: number,
    facingLocal: Vec2,
  ) {
    super(contact);
    this.carriedFrame = frame0;
    this.facingLocal = facingLocal;
  }

  // A ride starting where `bite` (world) touches `piece`'s belt on frame
  // `frame`, the cuff facing `facing` (world; the surface's own normal when
  // null) and the contact `standoff` out along it. The bite is snapped onto
  // the loop, which it already lies on to within a rounding - the pieces'
  // outline IS the loop - so the first carry is continuous with the bite.
  static at(
    body: CollisionObject2D,
    piece: CollisionShape2D,
    bite: Vec2,
    facing: Vec2 | null,
    frame: number,
    dt: number,
    standoff: number,
  ): RopeRide {
    const loop = piece.belt;
    if (loop === null) throw new Error("RopeRide.at: the piece is not a belt");
    const rot = body.globalRotation;
    const s0 = beltClosestS(loop, bite.sub(body.globalPosition).rotated(-rot));
    const n = beltNormalAt(loop, s0);
    const f = facing === null ? n : facing.rotated(-rot);
    const phi = dmath.atan2(n.cross(f), n.dot(f));
    const contact = new RideContact(body, Vec2.ZERO, beltPieceAt(loop, s0));
    const ride = new RopeRide(
      contact,
      loop,
      piece.beltSpeed,
      s0,
      frame,
      dt,
      phi,
      standoff,
      f,
    );
    contact.ride = ride;
    ride.place(s0);
    return ride;
  }

  // Where the contact is drawn at render fraction `alpha` of the frame: the
  // same pure function of the frame, asked between the last frame and this
  // one, so the drawn anchor runs smoothly along the loop (round a wheel
  // too) rather than hopping 60 times a second on a static body whose
  // render transform never moves. Never earlier than the bite. Render-only.
  renderPoint(alpha: number): Vec2 {
    const frame = Math.max(this.frame0, this.carriedFrame - 1 + alpha);
    const s = this.s(frame);
    const local = beltPointAt(this.loop, s).add(
      beltNormalAt(this.loop, s).rotated(this.phi).mul(this.standoff),
    );
    const body = this.body;
    return body.renderPosition(alpha).add(local.rotated(body.renderRotation(alpha)));
  }

  // The cuff's facing and the surface's normal under it, drawn at `alpha`
  // exactly as `renderPoint` places the pin. Render-only.
  renderFacing(alpha: number): Vec2 {
    const s = this.s(Math.max(this.frame0, this.carriedFrame - 1 + alpha));
    return beltNormalAt(this.loop, s).rotated(this.phi).rotated(this.body.renderRotation(alpha));
  }

  renderNormal(alpha: number): Vec2 {
    const s = this.s(Math.max(this.frame0, this.carriedFrame - 1 + alpha));
    return beltNormalAt(this.loop, s).rotated(this.body.renderRotation(alpha));
  }

  // The same ride rebuilt from what defines it - the arc length it bit at, the
  // frame it bit on and the angle the cuff keeps - and placed at `frame`: what
  // a replay landing mid-ride has to reproduce to the bit (`ride-pure`).
  static restore(
    body: CollisionObject2D,
    piece: CollisionShape2D,
    s0: number,
    frame0: number,
    dt: number,
    phi: number,
    standoff: number,
    frame: number,
  ): RopeRide {
    const loop = piece.belt;
    if (loop === null) throw new Error("RopeRide.restore: the piece is not a belt");
    const contact = new RideContact(body, Vec2.ZERO, beltPieceAt(loop, s0));
    const ride = new RopeRide(contact, loop, piece.beltSpeed, s0, frame0, dt, phi, standoff, Vec2.ZERO);
    contact.ride = ride;
    ride.place(s0);
    ride.carry(frame);
    return ride;
  }

  override genIdentifier(): string {
    return "Riding " + this.contact.genIdentifier();
  }

  get body(): CollisionObject2D {
    return this.contact.obj;
  }

  // The arc length the bite stands at on `frame`.
  s(frame: number): number {
    return this.s0 + this.speed * ((frame - this.frame0) * this.dt);
  }

  // Where the bite is on the loop right now, in the world.
  bite(): Vec2 {
    return this.body.globalPosition.add(this.biteLocal().rotated(this.body.globalRotation));
  }

  // The surface's outward normal under the bite right now, in the world.
  normal(): Vec2 {
    return beltNormalAt(this.loop, this.s(this.carriedFrame)).rotated(this.body.globalRotation);
  }

  private biteLocal(): Vec2 {
    return beltPointAt(this.loop, this.s(this.carriedFrame));
  }

  // How fast the contact is being carried, in the world: the derivative of the
  // pure function at the frame it was last carried to. On a run it is the
  // belt's own speed along it; on an arc the standoff swings round with the
  // surface, so a pin standing `h` off an arc of (outer) radius `r` also
  // turns at `speed / r` about the bite - `speed · (t + t.rotated(phi) · h /
  // r)`. The body's own `velocityAtPoint` answers the surface at the point of
  // the loop nearest the pin instead, which on an arc is 5-7% off this and a
  // few degrees behind it (measured on a 20 cm roller with the manacle's pin).
  velocity(): Vec2 {
    const s = this.s(this.carriedFrame);
    const t = beltTangentAt(this.loop, s);
    const { segment } = beltSegmentAt(this.loop, s);
    const local = segment.kind === "run" ? t : t.add(t.rotated(this.phi).mul(this.standoff / segment.radius));
    return local.mul(this.speed).rotated(this.body.globalRotation);
  }

  // Put the anchor where `frame` has it. Idempotent within a frame.
  carry(frame: number): void {
    if (frame === this.carriedFrame) return;
    this.carriedFrame = frame;
    this.place(this.s(frame));
  }

  private place(s: number): void {
    const bite = beltPointAt(this.loop, s);
    const facing = beltNormalAt(this.loop, s).rotated(this.phi);
    this.facingLocal = facing;
    // A FRESH Vec2: the contact's world-position cache is keyed on its
    // identity (`RopeContact.globalPosition`).
    this.contact.position = bite.add(facing.mul(this.standoff));
    this.contact.shapeIndex = beltPieceAt(this.loop, s);
    if (this.cuff !== null) {
      // Centred on the bite and turned to the facing, as `mountCuff` put it.
      this.body.moveShape(this.cuff, bite, facing.angle());
    } else {
      // The memoized span list is keyed on the epoch; a contact that moves
      // without a body moving has to bump it (as `RopeClamp.setParam` does).
      bumpTransformEpoch();
    }
  }
}

// A ride's contact: an ordinary `RopeContact` in every sim respect, whose
// DRAWN position is the ride's own interpolation along the loop
// (`RopeRide.renderPoint`) - every renderer draws the chain's end from
// `renderGlobalPosition`, so the chain, the drape and the cuff agree.
class RideContact extends RopeContact {
  ride: RopeRide | null = null;

  override renderGlobalPosition(alpha: number): Vec2 {
    return this.ride !== null ? this.ride.renderPoint(alpha) : super.renderGlobalPosition(alpha);
  }
}
