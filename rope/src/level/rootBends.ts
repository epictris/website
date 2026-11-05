// A BENDING root (docs/roots.md, "Bending roots"): one authored root whose
// branches bend at points along them (`RootBranchData.bends`), built as the
// root's own body for everything before the first bend and a body of its own
// for every stretch past one, each hinged to the stretch before it on a
// torsion spring. The hinges are rows of the island solver (`engine/ties.ts`),
// so the segments, their contacts with the scenery and the ball's chain on
// one of them are solved together, substep by substep, as a held plant is.
//
// A hinge is Box2D v3's revolute joint (Catto, Solver2D 2024;
// `b2SolveRevoluteJoint`): a POINT constraint holding the two bodies' anchors
// together, soft at the island's joint softness in the biased pass and rigid
// in the relax. Its ANGULAR spring is Box2D v2's soft spring instead (the
// wheel joint's: `gamma = 1/(h(c + hk))`, `bias = C·h·k·gamma`), from a
// stiffness and a damping coefficient the bend's frequency and ratio give
// about the HINGE: `k = I·ω²`, `c = 2·I·ζ·ω`, `I` the inertia about the hinge
// point of everything outboard of it (the segment past it and every segment
// hinged on beyond that). Box2D v3's own spring rates the frequency against the
// constraint's effective mass, which for a long segment is its inertia about
// its centre of mass - a twelfth of a rod's mass times its length squared,
// against a third about its end - so an authored 1.2 Hz hung a 2 m root 73°
// under its own weight and rang there undamped (2026-11-01). Rated on the one
// segment past the hinge, a bend near a branch's base held a 4.7 kg stub's
// 5 Hz, 371 N·m/rad, under the 12.5 kg segment beyond it and then the ball,
// and folded 89° (`session-79f`). About the hinge and over everything
// outboard, `freq` is what the part that swings on the bend swings at, the
// other bends held.
//
// The spring is LINEAR and the bend has no stop. Both were tried and removed
// (2026-11-01, Tris; docs/roots.md, "Bending roots"): a hard stop at a limit
// angle (Box2D's revolute limit) did not feel right, and a spring stiffening
// toward it (`k / (1 - x²)`) was a rule for the look, not the material - wood
// does not stiffen as it bends, it softens past its elastic range and then
// yields or breaks.
//
// Nothing here calls a platform `Math` transcendental: the anchors turn with
// `Vec2.rotated` (dmath), and `softness` takes hertz.

import { Vec2 } from "../engine/vec2";
import { PhysicsBody2D, RigidBody2D } from "../engine/body";
import { Mathf } from "../engine/mathf";
import {
  DEFAULT_TIE_SUBSTEPS,
  invInertiaOf,
  invMassOf,
  type IslandRow,
  type IslandUnit,
  type Softness,
} from "../engine/ties";

// One bend of a root: the hinge between the stretch before it (`a`, the
// root's own body, another segment, or a static) and the segment after it
// (`b`), at a world point given once, at build, in the authored pose.
export class RootHinge implements IslandRow {
  // The point constraint's accumulated impulse, N·s, and the spring's, N·m·s,
  // carried across substeps and frames (the warm start).
  linearImpulse = Vec2.ZERO;
  springImpulse = 0;
  // How far apart the two anchors ended the last frame, metres: the residual
  // the digests and the invariant read (`cli roots`).
  over = 0;
  // The two anchors in their bodies' own frames, and the relative turn the
  // bend rests at (its authored one).
  private readonly localA: Vec2;
  private readonly localB: Vec2;
  private readonly restAngle: number;
  // The spring's soft-constraint terms for this substep (`prepare`).
  private gamma = 0;
  private springBias = 0;
  // The spring's stiffness and damping coefficient about the hinge, N·m/rad
  // and N·m·s/rad: from the bend's frequency and ratio and the segment's
  // inertia about the hinge point, which is a constant of the build (the
  // segment is rigid and the hinge is fixed in it).
  readonly stiffness: number;
  private readonly dampingCoefficient: number;

  constructor(
    readonly a: PhysicsBody2D,
    readonly b: RigidBody2D,
    world: Vec2,
    // The spring's frequency, hertz, and damping ratio (`RootBendData`).
    readonly freq: number,
    readonly damping: number,
    // The inertia about the hinge point of everything OUTBOARD of it - `b`
    // and every segment hinged on past it, kg·m² - which the frequency is
    // rated against (see the file comment). `b`'s own alone when absent.
    outboardInertia?: number,
  ) {
    this.localA = world.sub(a.globalPosition).rotated(-a.globalRotation);
    this.localB = world.sub(b.globalPosition).rotated(-b.globalRotation);
    this.restAngle = b.globalRotation - a.globalRotation;
    const inertia = outboardInertia ?? b.inertia + b.mass * this.localB.dot(this.localB);
    const omega = 2 * Mathf.Pi * Math.max(0, freq);
    this.stiffness = inertia * omega * omega;
    this.dampingCoefficient = 2 * inertia * Math.max(0, damping) * omega;
  }

  // The energy the spring holds, J: what the energy invariant counts beside
  // the bodies' own (`mechanicalEnergy`, `sim/trace.ts`).
  get energy(): number {
    const d = this.bend;
    return 0.5 * this.stiffness * d * d;
  }

  // The hinge point as each body holds it, in the world.
  anchorA(): Vec2 {
    return this.a.globalPosition.add(this.localA.rotated(this.a.globalRotation));
  }

  anchorB(): Vec2 {
    return this.b.globalPosition.add(this.localB.rotated(this.b.globalRotation));
  }

  // The bend's turn away from its rest, radians: what the spring returns.
  get bend(): number {
    return this.b.globalRotation - this.a.globalRotation - this.restAngle;
  }

  beginFrame(): void {}

  prepare(h: number): void {
    this.gamma = 0;
    this.springBias = 0;
    if (!(this.stiffness > 0) || !(h > 0)) return;
    const k = this.stiffness;
    const c = this.dampingCoefficient;
    const g = h * (c + h * k);
    this.gamma = g > 0 ? 1 / g : 0;
    this.springBias = h * k * this.gamma;
  }

  warmStart(): void {
    const ra = this.anchorA().sub(this.a.globalPosition);
    const rb = this.anchorB().sub(this.b.globalPosition);
    applyHinge(this.a, this.linearImpulse.neg(), ra, -this.springImpulse);
    applyHinge(this.b, this.linearImpulse, rb, this.springImpulse);
  }

  solve(_h: number, soft: Softness, useBias: boolean): void {
    const A = this.a;
    const B = this.b;
    const mA = invMassOf(A);
    const mB = invMassOf(B);
    const iA = invInertiaOf(A);
    const iB = invInertiaOf(B);
    const wA = A instanceof RigidBody2D ? A.angularVelocity : 0;
    const wB = B.angularVelocity;
    // The spring on the relative turn, in the biased pass: it is a force over
    // the substep, and the relax only takes back what a bias put in.
    const axial = iA + iB + this.gamma;
    if (useBias && this.gamma > 0 && axial > 0) {
      const cdot = wB - wA;
      const impulse = -(cdot + this.springBias * this.bend + this.gamma * this.springImpulse) / axial;
      this.springImpulse += impulse;
      applyHinge(A, Vec2.ZERO, Vec2.ZERO, -impulse);
      applyHinge(B, Vec2.ZERO, Vec2.ZERO, impulse);
    }
    // The point: the two anchors held together.
    const pa = this.anchorA();
    const pb = this.anchorB();
    const ra = pa.sub(A.globalPosition);
    const rb = pb.sub(B.globalPosition);
    const va = A instanceof RigidBody2D ? A.linearVelocity : Vec2.ZERO;
    const wa = A instanceof RigidBody2D ? A.angularVelocity : 0;
    const cdot = B.linearVelocity
      .add(new Vec2(-rb.y, rb.x).mul(B.angularVelocity))
      .sub(va.add(new Vec2(-ra.y, ra.x).mul(wa)));
    let bias = Vec2.ZERO;
    let massScale = 1;
    let impulseScale = 0;
    if (useBias) {
      bias = pb.sub(pa).mul(soft.biasRate);
      massScale = soft.massScale;
      impulseScale = soft.impulseScale;
    }
    const k11 = mA + mB + ra.y * ra.y * iA + rb.y * rb.y * iB;
    const k12 = -ra.y * ra.x * iA - rb.y * rb.x * iB;
    const k22 = mA + mB + ra.x * ra.x * iA + rb.x * rb.x * iB;
    const det = k11 * k22 - k12 * k12;
    if (!(det > 0)) return;
    const rx = cdot.x + bias.x;
    const ry = cdot.y + bias.y;
    const bx = (k22 * rx - k12 * ry) / det;
    const by = (k11 * ry - k12 * rx) / det;
    const impulse = new Vec2(
      -massScale * bx - impulseScale * this.linearImpulse.x,
      -massScale * by - impulseScale * this.linearImpulse.y,
    );
    this.linearImpulse = this.linearImpulse.add(impulse);
    applyHinge(A, impulse.neg(), ra, 0);
    applyHinge(B, impulse, rb, 0);
  }

  measure(): void {
    this.over = this.anchorB().distanceTo(this.anchorA());
  }
}

// An impulse at arm `r` plus an angular impulse, to a body (a static, and a
// pivot's translation, take nothing: `invMassOf` reads its 0).
function applyHinge(body: PhysicsBody2D, impulse: Vec2, r: Vec2, angular: number): void {
  if (!(body instanceof RigidBody2D)) return;
  const iI = invInertiaOf(body);
  body.linearVelocity = body.linearVelocity.add(impulse.mul(body.inverseMass));
  body.angularVelocity += (r.cross(impulse) + angular) * iI;
}

// A bending root's hinges as one unit of the island: the segments it holds
// (and the root's own body, when that is a sprung one), which sleep and wake
// together.
export class RootBendUnit implements IslandUnit {
  readonly bodies: readonly RigidBody2D[];
  readonly substeps = DEFAULT_TIE_SUBSTEPS;
  // Left undamped by the island (`TIE_BODY_DAMPING`): every bend has its own
  // damping ratio, and that is the author's to set.
  readonly undamped = true;
  asleep = false;
  private readonly statics: readonly PhysicsBody2D[];
  private readonly sleptAtVersion: number[];

  constructor(readonly hinges: readonly RootHinge[]) {
    const bodies: RigidBody2D[] = [];
    const statics: PhysicsBody2D[] = [];
    for (const h of hinges) {
      for (const body of [h.a, h.b]) {
        if (body instanceof RigidBody2D) {
          if (!bodies.includes(body)) bodies.push(body);
        } else if (!statics.includes(body)) statics.push(body);
      }
    }
    this.bodies = bodies;
    this.statics = statics;
    this.sleptAtVersion = statics.map(() => -1);
  }

  get rows(): readonly IslandRow[] {
    return this.hinges;
  }

  // The widest any hinge's two anchors ended the last frame apart, metres.
  get over(): number {
    let worst = 0;
    for (const h of this.hinges) if (h.over > worst) worst = h.over;
    return worst;
  }

  fallAsleep(): void {
    this.asleep = true;
    for (let i = 0; i < this.statics.length; i++) this.sleptAtVersion[i] = this.statics[i]!.transformVersion;
  }

  anchorsMoved(): boolean {
    for (let i = 0; i < this.statics.length; i++) {
      if (this.statics[i]!.transformVersion !== this.sleptAtVersion[i]) return true;
    }
    return false;
  }
}
