// A berry plant the ball hangs from, as a unit of the island solver
// (`engine/ties.ts`): every constraint of the plant a row, substepped with the
// ball's chain row (`BallChainRow`) and the berry's contacts in one soft step.
//
// Why. A stalk is a spring (`StalkClamp`, `DEFAULT_STALK_STRETCH`), and the
// ball bouncing on it is a 0.7 s oscillation of the ball and the berry
// together. Solved in the chain phase that spring is XPBD at the frame's
// 1/60 s step, which is implicit Euler for its force, and implicit Euler
// damps a mode by `1 / (1 + (ω·dt)²)` of its energy a step: 37% over one
// half-period of that bounce, and the measured return of a drop onto a berry
// was 44% at 60 Hz, 65% with the same solve stepped at 120 and 83% at 240
// (2026-10-12, the drop rig in docs/vines.md). Nothing else was it: not the
// link damping (a held vine is undamped), not the stem joint's mass, not the
// aim's spin, and no phase in particular. The textbook answer is small steps
// (Macklin et al. 2019; Box2D v3's soft step), which the tied chains already
// run, so a held plant becomes rows of that solve while the ball holds it and
// goes back to the chain sweep when it lets go (`BallLevel.syncBallRow`).
//
// The rows are the plant's own constraints read at velocity level, each
// keeping the positional solve's geometry exactly: a joint (`VinePair`) and
// the stalk's ropes (`VineAnchor`) are ceilings on a distance, a stiff vine's
// strut (`VineStrut`) a floor, the load rope (`Vine.lra`) a ceiling with a
// torque arm on the anchor body, and a bend (`VineBend`) or a stalk clamp
// (`StalkClamp`) is a SPRING row: a linear three-point constraint driven by
// Catto's soft constraint at the frequency its compliance gives it in its own
// effective mass, with no damping ratio, so the energy a stroke puts into it
// comes back out - at the substep, where implicit Euler takes a thousandth of
// it a step rather than a third of it a bounce.
//
// Nothing here calls a platform `Math` transcendental: `Math.sqrt` is allowed
// (see `engine/dmath.ts`), and `softness` takes a frequency in hertz the row
// derives from `sqrt(k·w) / (2π)` with `Mathf.Pi`.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { PhysicsBody2D, RigidBody2D, type CollisionObject2D } from "../engine/body";
import {
  RIGID,
  invInertiaOf,
  islandOwns,
  knotVelocity,
  ropeImpulse,
  softness,
  type IslandRow,
  type IslandUnit,
  type Softness,
} from "../engine/ties";
import type { RopeContact } from "../lib/ropeContact";
import { VinePair, VineStrut } from "./vinePair";
import { VineAnchor } from "./vineAnchor";
import { StalkClamp, VineBend, type BendEnd } from "./vineBend";
import { VINE_LRA_GIVE, wakeVine, type Vine } from "./vines";
import type { VineLink } from "../engine/body";

// The velocity of the point a contact sits at, for a row's rate: a rigid
// body's as `knotVelocity` reads it (the steered ball's rim excepted), a
// moving static's at the point, and nothing for anything else.
function contactVelocity(contact: RopeContact): Vec2 {
  const body = contact.obj;
  if (body instanceof RigidBody2D) return knotVelocity(body, contact.globalPosition);
  return body instanceof PhysicsBody2D ? body.velocityAtPoint(contact.globalPosition) : Vec2.ZERO;
}

// A body's generalized inverse mass at arm `r` along `n`, as the island reads
// it (`invInertiaOf`: a kinematically turned body is locked to a row).
function effectiveInverse(body: CollisionObject2D, r: Vec2, n: Vec2): number {
  if (!(body instanceof RigidBody2D)) return 0;
  const rxn = r.cross(n);
  return body.inverseMass + invInertiaOf(body) * rxn * rxn;
}

function apply(body: CollisionObject2D, impulse: Vec2, r: Vec2): void {
  if (!(body instanceof RigidBody2D)) return;
  body.linearVelocity = body.linearVelocity.add(impulse.mul(body.inverseMass));
  body.angularVelocity += r.cross(impulse) * invInertiaOf(body);
}

// How soft a plant's length rows are, and how many substeps a plant gets.
//
// The tied chains' own tuning (`TieTuning`, 60 Hz at eight substeps) is a
// spring per joint of `m_eff·(2π·60)²` - 570 kN/m between two 8 kg cord
// links - and a cord of fifteen such joints above the held berry is a 38 kN/m
// spring carrying the ball: 26 mm of stretch under its weight and 10 cm of
// bob as the bounce swings the tension through zero and back
// (`session-846f`, the stem's end "moving up and down" while the drawn stalk
// roots, which sit at an arc length from the anchor, stay put). The chain
// sweep held the same cord to 3 cm. A row's frequency is capped at a quarter
// of the substep rate, so stiffer rows need more substeps: eight allow
// 120 Hz, four times the stiffness, and measured on the drop rig the cord
// then swings 0 to 7 mm through a bounce and the root bobs 1 to 2 mm, the
// same as sixteen substeps at 240 Hz give at half again the cost (1.03
// against 1.45 ms a held frame in bun, the sweep's 0.99).
//
// `springDamping` is the damping ratio of the bends' and clamps' spring rows
// in their own mode, and it is the one trade the plant has: the bob of a
// hanging ball and the return of a bounce are the same mode, and a damping
// that settles the one takes from the other. At zero a held plant never
// settled (a 28 kg berry hung from bobbed 44 to 130 mm on its stalk for the
// whole of a five-second hang, the "berries jiggle" of `session-846f`, where
// the sweep's implicit step had it still within a second); measured on a
// 4 kg berry at sway 0.5 with the aim held still, the 0.5 m drop returned
// 66 and 91% at 0.1 and the hang still bobbed ±90 mm after five seconds,
// 56 and 63% at 0.3 with the bob under ±20 mm by then, 47% at 0.6 and 31%
// at 1.0. The ratio is in the ROW's own mode (the berry on its clamp, tens
// of radians a second), which is why it reads so high against the bounce it
// leaves: the ball and the berry together on the same spring is a slower
// mode, `sqrt(m_row / m_system)` as damped.
export const PlantTuning = {
  hertz: 120,
  damping: 2,
  substeps: 8,
  springDamping: 0.3,
};

// The substeps a FREE stiff span gets. Four, where the held plant takes
// eight: a span carries nothing but itself, and at four (60 Hz length rows,
// 30 Hz bends) BALL's six spans kicked at 3 m/s cost what the chain sweep
// cost them on the committed tree (0.90 against 0.83 ms a frame over the
// first two seconds, p95 1.76 against 1.99, 260 against 276 ms over ten) and
// sleep sooner (269 frames against 445), against 1.41 ms, 3.17 and 376 at
// eight. The 5 m span over 4 m settles at build at every stiffness either
// way; at four it rests 1.2% long (5061 mm) and sags 1.375 m against 1.34.
export const SPAN_SUBSTEPS = 4;

function plantSoftness(h: number): Softness {
  return softness(Math.min(PlantTuning.hertz, 0.25 / h), PlantTuning.damping, h);
}

// A distance between two contacts held under a length (a rope: a joint, a
// stalk's rope, the load rope) or over one (a strut), as a row:
// `TieSegment`'s solve with the contacts' own arms, and the strut its mirror,
// at the plant's own softness (`PlantTuning`).
export class LengthRow implements IslandRow {
  impulse = 0;
  over = 0;

  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    readonly length: number,
    // A floor under the distance rather than a ceiling over it.
    private readonly floor: boolean,
    // What the row is, for the digests and the rigs: "pair", "strut",
    // "stalk", "lra" or "anchor".
    readonly kind: string,
  ) {}

  // The distance as it stands, metres.
  get current(): number {
    return this.b.globalPosition.distanceTo(this.a.globalPosition);
  }

  beginFrame(): void {}

  prepare(): void {}

  measure(): void {
    const len = this.b.globalPosition.distanceTo(this.a.globalPosition);
    this.over = Math.max(0, this.floor ? this.length - len : len - this.length);
  }

  warmStart(): void {
    if (this.impulse === 0) return;
    const pa = this.a.globalPosition;
    const pb = this.b.globalPosition;
    const d = pb.sub(pa);
    const len = d.length();
    if (len < 1e-9) return;
    this.deliver(d.div(len), pa, pb, this.impulse);
  }

  solve(h: number, soft: Softness, useBias: boolean): void {
    const pa = this.a.globalPosition;
    const pb = this.b.globalPosition;
    const d = pb.sub(pa);
    const len = d.length();
    if (len < 1e-9) return;
    const n = d.div(len);
    const A = this.a.obj;
    const B = this.b.obj;
    const ra = A instanceof RigidBody2D ? pa.sub(A.globalPosition) : Vec2.ZERO;
    const rb = B instanceof RigidBody2D ? pb.sub(B.globalPosition) : Vec2.ZERO;
    const w = effectiveInverse(A, ra, n) + effectiveInverse(B, rb, n);
    if (w <= 0) return;
    // The rate the distance opens at.
    const opening = n.dot(contactVelocity(this.b).sub(contactVelocity(this.a)));
    const slack = this.floor ? len - this.length : this.length - len;
    const slackRate = this.floor ? opening : -opening;
    const applied = ropeImpulse(this, slack, slackRate, w, h, useBias ? plantSoftness(h) : soft, useBias);
    if (applied !== 0) this.deliver(n, pa, pb, applied);
  }

  // A rope pulls the two points together (`+n` on A, `-n` on B); a strut
  // pushes them apart.
  private deliver(n: Vec2, pa: Vec2, pb: Vec2, j: number): void {
    const A = this.a.obj;
    const B = this.b.obj;
    const impulse = n.mul(this.floor ? -j : j);
    apply(A, impulse, A instanceof RigidBody2D ? pa.sub(A.globalPosition) : Vec2.ZERO);
    apply(B, impulse.neg(), B instanceof RigidBody2D ? pb.sub(B.globalPosition) : Vec2.ZERO);
  }
}

// A three-point linear constraint `C = |offset(a, b, c)|` held to zero through
// a compliance, as a spring row: a bend (the middle point off the chord's
// midpoint) or a stalk clamp (the body off where the cord edge says it
// belongs). The gradient is `n` scaled per end by the constraint's own
// coefficients, so `Cdot = Σ gᵢ·vᵢ` and `w = Σ wᵢ|gᵢ|²`, and the spring's
// frequency in that effective mass is `sqrt(k·w)`, `k = 1 / compliance`.
//
// Always driven with its bias, in the relax pass too: a spring is not a rigid
// constraint softened for stability but the force itself, and Box2D's own
// spring (the distance joint's) applies in both passes the same way. A bend
// of no compliance is a rigid equality and takes the island's tie softness as
// a tie segment does.
export class SpringRow implements IslandRow {
  impulse = 0;
  over = 0;

  constructor(
    private readonly ends: readonly [BendEnd, BendEnd, BendEnd],
    // The offset the constraint holds to zero, and each end's gradient
    // coefficient for a unit offset direction `n`: `gᵢ = coef(n)[i]`.
    private readonly offset: () => Vec2,
    private readonly gradients: (n: Vec2) => readonly [Vec2, Vec2, Vec2],
    private readonly compliance: number,
    // "bend" or "clamp", for the digests and the rigs.
    readonly kind: string,
  ) {}

  beginFrame(): void {}

  prepare(): void {}

  measure(): void {
    this.over = this.offset().length();
  }

  warmStart(): void {
    if (this.impulse === 0) return;
    const offset = this.offset();
    const c = offset.length();
    if (c < 1e-12) return;
    this.deliver(this.gradients(offset.div(c)), this.impulse);
  }

  solve(h: number, soft: Softness, useBias: boolean): void {
    const offset = this.offset();
    const c = offset.length();
    // Dead on: no direction, and the impulse kept as `VineBend.solve` keeps
    // its multiplier through a joint that passes through straight.
    if (c < 1e-12) return;
    const n = offset.div(c);
    const g = this.gradients(n);
    let w = 0;
    let cdot = 0;
    for (let i = 0; i < 3; i++) {
      const end = this.ends[i]!;
      w += end.inverseMass * g[i]!.lengthSquared();
      cdot += g[i]!.dot(end.velocity);
    }
    if (w <= 0) return;
    let spring: Softness;
    let bias: number;
    if (this.compliance > 0) {
      const omega = Math.sqrt(w / this.compliance);
      // Capped at HALF the length rows' frequency (`plantSoftness`, itself a
      // quarter of the substep rate, the island's rule for its ropes and
      // contacts and Box2D's for its joints). A bend's own frequency runs
      // far past that - 113 Hz at stiffness 0.5 and 3.6 kHz at 1 on a
      // span's joints - and driven at it, with its bias in both passes, a
      // stiffness-1 span left the build at 1e100 J. Capped at the length
      // rows' own frequency it was stable but EQUAL to the floors it argues
      // with on a span (`VineStrut`), and two rows at one frequency pulling
      // opposite ways chatter: the 5 m span over 4 m of `cli vines`
      // `span-stiffness` rang at 5 J for ever at 0.5 with eight substeps,
      // and at 0.6 with sixteen, buckled above its anchors. Half, and the
      // floor is always the stiffer row - which is the physical statement:
      // a rod's axial stiffness is orders above its bending stiffness, so a
      // span of surplus length bows and never shortens, at any stiffness.
      // Past the cap a stiffer bend is the same row.
      spring = softness(
        Math.min(omega / (2 * Mathf.Pi), 0.5 * Math.min(PlantTuning.hertz, 0.25 / h)),
        PlantTuning.springDamping,
        h,
      );
      bias = spring.biasRate * c;
    } else if (useBias) {
      spring = soft;
      bias = soft.biasRate * c;
    } else {
      spring = RIGID;
      bias = 0;
    }
    const inc = (-spring.massScale * (cdot + bias)) / w - spring.impulseScale * this.impulse;
    if (inc === 0) return;
    this.impulse += inc;
    this.deliver(g, inc);
  }

  private deliver(g: readonly [Vec2, Vec2, Vec2], j: number): void {
    for (let i = 0; i < 3; i++) {
      const end = this.ends[i]!;
      const w = end.inverseMass;
      if (!end.link || w === 0) continue;
      end.link.linearVelocity = end.link.linearVelocity.add(g[i]!.mul(j * w));
    }
  }
}

// The rows of one bend: `∇b = n`, `∇a = ∇c = -n/2` (see `VineBend.solve`).
function bendRow(bend: VineBend): SpringRow {
  const [a, b, c] = bend.ends;
  return new SpringRow(
    bend.ends,
    () => b.position.sub(a.position.add(c.position).mul(0.5)),
    (n) => [n.mul(-0.5), n, n.mul(-0.5)],
    bend.springCompliance,
    "bend",
  );
}

// The rows of one stalk clamp: `∇c = n`, `∇a = conj(k)⊗n`, `∇b = -(n + ∇a)`
// (see `StalkClamp.solve`).
function clampRow(clamp: StalkClamp): SpringRow {
  const [a, b, c] = clamp.ends;
  return new SpringRow(
    clamp.ends,
    () => {
      const u = b.position.sub(a.position);
      const k = clamp.ratio;
      return c.position.sub(b.position).sub(new Vec2(k.x * u.x - k.y * u.y, k.x * u.y + k.y * u.x));
    },
    (n) => {
      const k = clamp.ratio;
      const ga = new Vec2(k.x * n.x + k.y * n.y, k.x * n.y - k.y * n.x);
      return [ga, n.add(ga).mul(-1), n];
    },
    clamp.springCompliance,
    "clamp",
  );
}

// One vine as a unit of the island: its bodies the cord and every stalk, its
// rows every joint, strut, stalk rope, bend and clamp in the sweep's own
// order, and the load rope last.
//
// Two vines are solved this way, and the unit is the same for both.
//
// A HELD berry plant (`berry` the fruit the ball's chain holds): built when
// the chain takes the berry and dropped when it lets go, so the rows'
// accumulated impulses warm-start the next substep and the next frame for as
// long as the hold lasts (`BallLevel.syncPlantUnit`).
//
// A STIFF SPAN while nothing holds it (`berry` null, `syncSpanUnits` in
// `level/vines.ts`): its floors (`VineStrut`) and its bends argue by
// construction - a bend pass shortens every joint it straightens, and a span
// of surplus length can never be straight at any scale - and the chain
// sweep's Gauss-Seidel compromise between them was never a fixed point.
// Swept, BALL's 2.5 m span over a 2.19 m gap let go by the chain ran to the
// sweep's cap on one frame in twenty as its bow swung in, and that frame's
// displacement was paid out as velocity (0.7 J to 27.5 J, `session-294f`),
// so it rang for three seconds; the 5 m span over 4 m of `cli vines`
// `span-stiffness` never settled at all at 0.3. The island solves the floors
// and the bends in one soft substepped velocity solve, where there is no
// last word and nothing to pay out: a row has no order to care about. Every
// hold of a span is positional (the ball's hook threads onto a cord as a
// ring, the grapple level's rope is the sweep's), so for the hold the unit
// is dropped and the span is swept as it always was, and the unit comes
// back the frame the hold ends, with the velocities the sweep left
// (`syncSpanUnits`) - except the ball's ring, which the ball level makes a
// ROW of this island (`BallLevel.syncBallRow`): the span keeps its unit
// through that hold, with the load ropes among its rows, and nothing
// changes hands at either end of it. Pinning the held link to the sweep
// instead, the rest of the cord staying rows, was measured out: the rope
// hauled a 3.7 kg link at 5.7 m/s and the soft rows lagged it, 190 mm of
// stretch on a 2.5 m span and a 140 J twang at the release
// (`session-294f`).
export class PlantUnit implements IslandUnit {
  readonly bodies: readonly RigidBody2D[];
  readonly rows: readonly IslandRow[];
  // A held plant takes the plant's eight (`PlantTuning`: 120 Hz rows under a
  // 52 kg ball); a free span takes `SPAN_SUBSTEPS`.
  get substeps(): number {
    return this.berry ? PlantTuning.substeps : SPAN_SUBSTEPS;
  }
  // The vine's own rest rule is the unit's (`stepVines`: net displacement
  // over a window, the links' flags with it), because a link never satisfies
  // the world's (`VineLink.canSleep` is false) and the island's rest pass
  // therefore never sleeps one. A held plant is awake by that rule as well:
  // the ball cannot sleep, and neither can what it hangs from. The island
  // writes `false` here when something disturbs a sleeping unit; a link is
  // only ever woken by its vine, and a span's anchors are watched by the
  // vine too (`anchorsMoved` below), so that write never has anything to do
  // that `wakeVine` has not already done.
  get asleep(): boolean {
    return this.vine.asleep;
  }
  set asleep(value: boolean) {
    if (!value && this.vine.asleep) wakeVine(this.vine);
  }
  // A held berry plant is never damped by the island (nor by `stepVines`:
  // a held vine is not), the bounce being exactly the energy the damping
  // would take. A free span takes the vine's own `LINK_DAMPING` in
  // `stepVines` like every awake vine, so the island leaves it alone too; a
  // span the ball's ring holds as a row of this island is damped here as a
  // tied chain's bodies are (`TIE_BODY_DAMPING`), being damped nowhere else.
  get undamped(): boolean {
    return this.berry !== null || this.vine.lra === null;
  }

  // The load rope the rows were built with (`Vine.lra` at construction), so
  // `syncSpanUnits` can tell a unit whose hold has changed since: a span's
  // load rope is born when the ring takes it, reborn when the ring crosses a
  // link and dropped when it lets go, and the rows are built once.
  readonly lra: VineAnchor | null;

  constructor(
    readonly vine: Vine,
    // The fruit the ball's chain holds, or null for a stiff span (free, or
    // held by a ring the ball level makes a row of this island).
    readonly berry: VineLink | null,
  ) {
    this.lra = vine.lra;
    this.bodies = vine.allLinks.filter(islandOwns);
    const rows: IslandRow[] = [];
    const stalkBodies = new Set<VineLink>();
    for (const b of vine.berries) {
      stalkBodies.add(b.joint);
      stalkBodies.add(b.fruit);
    }
    // A hanging vine's cord joints are built `VINE_LRA_GIVE` short of the
    // spacing and rest that much OVER their ceilings, inside the sweep's loose
    // exit bar, against the attachments on the drawn arc (`jointLength` in
    // `buildOne`). A row has no loose bar: it holds its ceiling, so the joints
    // as built contracted the cord by a give a joint - 22 joints, 103 mm on
    // BALL's plant, the whole plant rising under the hanging ball (the stem's
    // end "moving up and down" against roots drawn at an arc length,
    // `session-846f`), and the more the stiffer the rows. The rows take the
    // joints at the spacing, so the cord rests on its drawn arc here as it
    // does in the sweep, and the attachments and the joints hold it together.
    const give = vine.anchor2Contact ? 0 : VINE_LRA_GIVE;
    for (const chain of vine.chains) {
      if (chain instanceof VinePair) {
        const [a, b] = chain.ends;
        const stalk = stalkBodies.has(a.obj as VineLink) || stalkBodies.has(b.obj as VineLink);
        rows.push(new LengthRow(a, b, chain.constraintLength + (stalk ? 0 : give), false, stalk ? "stalk" : "pair"));
      } else if (chain instanceof VineAnchor) {
        const [a, b] = chain.ends;
        const stalk = stalkBodies.has(b.obj as VineLink);
        // The anchor's own joint is the one to the first link; the others are
        // the long-range attachments, already on the drawn arc.
        const joint = !stalk && b.obj === vine.links[0];
        rows.push(new LengthRow(a, b, chain.constraintLength + (joint ? give : 0), false, stalk ? "stalk" : "anchor"));
      } else {
        throw new Error(`a plant's chain set holds a ${chain.constructor.name}, which has no row`);
      }
    }
    // The joint floors, the mirror of the pairs' ceilings. A row has no order
    // to care about, so where the sweep takes them (after the bends) is
    // nothing to the island.
    for (const strut of vine.struts) {
      if (!(strut instanceof VineStrut)) throw new Error(`a plant's strut set holds a ${strut.constructor.name}, which has no row`);
      const [a, b] = strut.ends;
      rows.push(new LengthRow(a, b, strut.minLength, true, "strut"));
    }
    for (const bend of vine.bends) {
      if (bend instanceof VineBend) rows.push(bendRow(bend));
      else if (bend instanceof StalkClamp) rows.push(clampRow(bend));
      else throw new Error(`a plant's bend set holds a ${bend.constructor.name}, which has no row`);
    }
    for (const lra of [vine.lra, vine.lra2]) {
      if (!lra) continue;
      const [a, b] = lra.ends;
      rows.push(new LengthRow(a, b, lra.constraintLength, false, "lra"));
    }
    this.rows = rows;
  }

  fallAsleep(): void {}

  anchorsMoved(): boolean {
    return false;
  }
}
