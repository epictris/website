// Physics world / space-state substitute. Owns the body list, answers the
// space queries the game issues (IntersectRay, IntersectShape, moveAndCollide)
// and integrates dynamic bodies. Semantics approximate Godot's 2D physics
// closely enough for the character controller and rope; it is self-consistent
// (deterministic replay), not bit-compatible with Godot.

import { Vec2 } from "./vec2";
import { circleShape } from "./shapes";
import type { ShapeTransform } from "./shapes";
import {
  Area2D,
  CharacterBody2D,
  CollisionObject2D,
  ForceArea,
  KinematicCollision2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "./body";
import {
  circleOverlap,
  outwardDirection,
  rayVsShape,
  shapeRadius,
  sweepCircle,
} from "./collision";
import { shapeContacts } from "./manifold";
import { PhaseTrace } from "./phaseTrace";
import { PhysTrace } from "./physTrace";

// Trace helper: one record per moveAndCollide hit.
function traceContact(
  mode: "overlap" | "sweep",
  body: CharacterBody2D,
  collider: PhysicsBody2D,
  normal: Vec2,
  position: Vec2,
  testOnly: boolean,
): void {
  if (!PhysTrace.enabled) return;
  PhysTrace.emit({
    t: "contact",
    mode,
    body: body.name || body.constructor.name,
    hit: collider.name || collider.constructor.name,
    mobile: collider.isMobile,
    n: [Number(normal.x.toFixed(4)), Number(normal.y.toFixed(4))],
    ...(collider.isMobile
      ? {
          cvel: (({ x, y }) => [Number(x.toFixed(2)), Number(y.toFixed(2))])(
            collider.velocityAtPoint(position),
          ),
        }
      : {}),
    test: testOnly,
  });
}

// Gravity in m/s² — the ported Godot default (980 px/s² at 100 px/m) reads as
// real-world 9.8. dt is 1/60, so ≈0.00272 m/frame².
export const GRAVITY = new Vec2(0, 9.8);
// Contact skin: the sliver of penetration left after depenetration, in metres.
const SKIN = 0.0008;
// Scale on the impulse a pushing character imparts to a rigid circle.
const CHARACTER_PUSH_FACTOR = 0.5;
// Gauss-Seidel iterations over the whole contact constraint list.
//
// Above Box2D's default of 8, and the reason is the load path. A four-box pile
// has to carry the top box's weight down through four interfaces and the floor's
// reaction back up, one interface per iteration, so 8 leaves the top of the pile
// holding a residual spin it never sheds (0.017 rad/s, against a 0.01 bound).
// At 20 the same pile converges to exactly zero.
//
// That this responds to the iteration count AT ALL is the point. While static
// contacts were solved in their own system the pile could not converge on any
// budget - 8, 32 and 128 landed within 5 cm of each other - so a number that now
// buys convergence is the signature of a system that is actually coupled.
// The cost is nothing at this scene scale: a few dozen constraints, once a frame.
const VELOCITY_ITERATIONS = 20;
// How close two shapes must be for the constraint gather to call it a contact,
// in metres. Larger than one frame of gravity (2.7 mm) on purpose.
//
// A pile at rest is pushed to exactly zero overlap, and then every body in it
// falls by the same gravity step, so the interfaces between them never
// re-penetrate: at a strict "overlap > 0" a resting stack's own contacts vanish
// from the set on the frames it needs them most. Contacts inside the band are
// kept as SPECULATIVE ones - they carry a negative depth, ask for no impulse
// unless something is approaching fast enough to close the gap within the step,
// and above all they persist, which is what gives warm starting something to
// hold on to.
const CONTACT_SLOP = 0.01;
// Approach speed (m/s) below which a contact earns no bounce at all.
//
// Without it, any restitution above zero makes resting contacts micro-bounce for
// ever on the velocity gravity re-adds each frame - the contact reflects it, the
// next frame's gravity puts it back, and a body that should be asleep hums.
// Every engine gates restitution this way. Default restitution is 0 and
// rigid-rigid contacts have never had any, so with the shipped defaults this
// costs nothing; it is here so that turning restitution on is not a trap.
const RESTITUTION_THRESHOLD = 1;
// Sweeps of the scene-wide positional recovery per physics step. Each sweep gives
// every rigid body one depenetration pass, so a pile settles together instead of
// whichever body the loop reached last winning its overlap outright.
const DEPENETRATION_PASSES = 3;
// Static friction only grabs a body moving slower than this (m/s) and spinning
// slower than this (rad/s); a faster body slides/rolls under kinetic friction
// until it slows into the grip. The spin gate also lets a steered ball roll:
// while the aim actively sweeps the ball (high ω) it rolls, and it only grips
// once the aim settles (ω → 0).
const STICK_SPEED = 0.3;
const STICK_SPIN = 0.5;
// Consecutive frames without a gripping contact before the stick anchor is
// dropped. The grip flickers frame to frame on the spin gate, and releasing the
// anchor on a single miss re-seeds it wherever the body has drifted to.
const STICK_RELEASE_FRAMES = 6;
// Static-friction slip threshold (m/s): a steered contact grips (no-slip roll)
// only while the relative velocity between the ball's contact point and the
// surface stays below this. Rotate/move slowly and the contact sticks — precise
// placement; rotate or travel fast and the slip exceeds it, so the contact
// falls through to the slippery, Coulomb-capped kinetic friction instead.
const SLIP_STICK = 0.15;
// Fraction of the along-surface error a pin removes per frame.
const PIN_RELAX = 0.15;

export interface RayResult {
  collider: PhysicsBody2D;
  position: Vec2;
  normal: Vec2;
}

export interface RayOptions {
  collisionMask?: number;
  exclude?: CollisionObject2D[];
  hitFromInside?: boolean;
}

// Does the world resolve collisions against this body? The allowlist every
// collision path is written as (see AnchorBody, which is outside it by
// construction rather than by a special case per site).
function isSolidTarget(body: PhysicsBody2D): boolean {
  return body instanceof StaticBody2D || body instanceof RigidBody2D;
}

// One manifold point, solved once for the PAIR that shares it.
//
// The contact routines this replaces are written per body: each visits the pair
// A-B on its own pass, writes only to itself, and takes `RIGID_PAIR_SHARE` of the
// contact in ignorance of what the other pass will do. Two independent one-sided
// solves are not an impulse pair - nothing makes them equal and opposite - so
// momentum is not conserved and none of it is transferred. A constraint is the
// unit that fixes that: one impulse, computed once, applied both ways.
export interface ContactConstraint {
  // Always dynamic. `b` may be dynamic or static, and a static `b` is simply one
  // with zero inverse mass and inertia, which is what lets the same solver handle
  // both without a branch.
  readonly a: RigidBody2D;
  readonly b: PhysicsBody2D;
  // Which shape of each body the contact is on. Part of the warm-start key: a
  // compound body's pieces meet quite different contacts.
  readonly shapeA: number;
  readonly shapeB: number;
  readonly point: Vec2;
  // Out of `b`, toward `a` — the same orientation `circleOverlap` and
  // `shapeContacts` report, fixed here so the solver never has to ask which way
  // round a given pair came out.
  readonly normal: Vec2;
  readonly depth: number;
  // Stable frame to frame while the same features are meeting: the warm-start
  // matching key (see `Contact.featureId`).
  readonly featureId: number;
  // Solver state, accumulated during the solve.
  normalImpulse: number;
  tangentImpulse: number;
  // Did the tangential solve ask for more than the Coulomb cone could give? Then
  // this contact is SLIDING, which is what decides whether a body resting on
  // static geometry earns the position pin (see `applyStaticGrip`).
  slipping: boolean;
}

// A circle pair has no faces to key on and produces exactly one point, so every
// contact between one given pair of circles is the same feature. Distinct from
// `CIRCLE_FEATURE` (a circle against a vertex shape) only for tidiness; the two
// can never be produced for the same shape pair.
const CIRCLE_PAIR_FEATURE = -2;

// A constraint with everything the iteration loop needs precomputed. Positions
// do not change during a velocity solve, so the lever arms, the effective masses
// and the restitution target are all constant across the iterations.
interface SolverContact {
  readonly c: ContactConstraint;
  readonly bRigid: RigidBody2D | null;
  readonly rA: Vec2;
  readonly rB: Vec2;
  readonly invIA: number;
  readonly invIB: number;
  readonly tangent: Vec2;
  readonly invEffN: number;
  readonly invEffT: number;
  // Separation speed this contact is owed, captured pre-solve.
  readonly bounce: number;
  // Approach speed a still-separated contact may take without closing its gap
  // within the step. Zero for a touching or penetrating one.
  readonly approach: number;
  readonly friction: number;
  // Coulomb cone scales for the two halves of the tangent direction. 1 unless a
  // body on this contact is an aiming ball (see `contactBrakeScale`).
  readonly brakePos: number;
  readonly brakeNeg: number;
  readonly key: string;
}

// Accumulated impulses carried from one frame to the next.
interface CachedImpulses {
  n: number;
  t: number;
}

// ---- contact bookkeeping audit --------------------------------------------
// Off in play, on under `cli contacts`: every velocity change the contact phase
// writes must be accounted for by an impulse applied to a PAIR.
//
// The `momentum` case already pins the aggregate at machine precision, and this
// is the same statement made per body, which is what catches the defect that
// aggregate cannot see: a one-sided write. Rigid-rigid friction used to be
// exactly that - a routine that wrote only to `body`, sized from the other
// body's motion, with nothing making the two directions equal and opposite - and
// it became a motor the moment level scenery stopped being frictionless
// (session-611f, a hanging ball walking its anchor 3.6 m across the level). An
// aggregate check misses it whenever the other side of the scene is a static
// body, because the floor absorbs the discrepancy silently.
export const ContactAudit = {
  enabled: false,
  violations: [] as string[],
  // Impulse and angular impulse each body was handed this solve.
  applied: new Map<number, { p: Vec2; l: number }>(),

  reset(): void {
    this.violations.length = 0;
    this.applied.clear();
  },

  record(body: PhysicsBody2D, impulse: Vec2, angular: number): void {
    const e = this.applied.get(body.id);
    if (e) {
      this.applied.set(body.id, { p: e.p.add(impulse), l: e.l + angular });
    } else {
      this.applied.set(body.id, { p: impulse, l: angular });
    }
  },
};

export class World {
  readonly bodies: PhysicsBody2D[] = [];
  readonly areas: Area2D[] = [];

  // Last frame's accumulated impulses, by contact. Looked up only - never
  // iterated - so it cannot put a map's ordering anywhere near the solve.
  private contactCache = new Map<string, CachedImpulses>();

  // Names bodies for the full-world digest: assignment order in this world, not
  // the process-global `id`, so two builds of the same level agree.
  private nextBuildIndex = 0;

  add(body: CollisionObject2D): void {
    body.world = this;
    body.removed = false;
    if (body instanceof Area2D) {
      if (!this.areas.includes(body)) this.areas.push(body);
      else return;
    } else if (body instanceof PhysicsBody2D) {
      if (!this.bodies.includes(body)) this.bodies.push(body);
      else return;
    } else {
      return;
    }
    // Only on the add that actually appends: re-adding a body it already holds
    // must not renumber it, and a body removed and re-added takes a fresh index
    // because it is, as far as the digest is concerned, a new body.
    body.buildIndex = this.nextBuildIndex++;
  }

  // Snapshot every body's transform for render interpolation. Called at the top
  // of a level's physics step, before anything moves; render-only state, so it
  // cannot affect the simulation (see CollisionObject2D.captureRenderTransform).
  captureRenderTransforms(): void {
    for (const b of this.bodies) b.captureRenderTransform();
    for (const a of this.areas) a.captureRenderTransform();
  }

  remove(body: CollisionObject2D): void {
    body.removed = true;
    const i = this.bodies.indexOf(body as PhysicsBody2D);
    if (i >= 0) this.bodies.splice(i, 1);
    const j = this.areas.indexOf(body as Area2D);
    if (j >= 0) this.areas.splice(j, 1);
  }

  private matchesMask(body: PhysicsBody2D, mask: number | undefined): boolean {
    return mask === undefined || (body.collisionLayer & mask) !== 0;
  }

  // ---- CharacterBody2D.moveAndCollide -----------------------------------

  moveAndCollide(
    body: CharacterBody2D,
    motion: Vec2,
    testOnly: boolean,
  ): KinematicCollision2D | null {
    const shape = body.primaryShape().shape;
    if (shape.kind !== "circle") return null; // characters are circles here
    const r = shape.radius;
    const start = body.globalPosition;

    let overlapHit: { normal: Vec2; depth: number; collider: PhysicsBody2D } | null = null;
    let sweepHit: { t: number; normal: Vec2; collider: PhysicsBody2D } | null = null;

    for (const target of this.bodies) {
      if (target === body || target.removed) continue;
      if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
      if (body.exceptions.has(target.id)) continue;
      if (!target.hasShape()) continue;
      // Every shape the target carries. A compound body (a concave form built
      // from convex pieces) blocks with all of them; a single-shape body is the
      // one-iteration case this has always been.
      for (const ts of target.getShapes()) {
        const ov = circleOverlap(start, r, ts);
        if (ov && ov.depth > SKIN) {
          if (!overlapHit || ov.depth > overlapHit.depth) {
            overlapHit = { normal: ov.normal, depth: ov.depth, collider: target };
          }
          continue;
        }

        const sweep = sweepCircle(start, motion, r, ts);
        if (sweep) {
          // Phantom-contact guards for grazing sweeps that start within the
          // skin of a thin shape (a rotating blade): the reported normal can
          // belong to the far face — "hit from inside" — which misclassifies
          // the surface and resets the player's state.
          // 1. A real contact opposes the motion.
          if (sweep.normal.dot(motion) > 1e-9) continue;
          // 2. The normal must agree with the side of the shape the sweep
          //    starts on.
          if (sweep.normal.dot(outwardDirection(start, ts)) < -1e-6) continue;
        }
        if (sweep && sweep.t <= 1 && (!sweepHit || sweep.t < sweepHit.t)) {
          sweepHit = { t: sweep.t, normal: sweep.normal, collider: target };
        }
      }
    }

    // Depenetration takes priority over a forward sweep. Recover against ALL
    // overlapping bodies, not just the deepest: pushing out of one body may
    // push into another (a mover advancing into a static wedge), and a
    // single-body pushout ping-pongs deeper into the pair every call —
    // whichever body the last pass handled wins, and the rope solver turns
    // the leftover displacement into velocity spikes. Godot's recovery
    // resolves the full shape set at once; mirror that with bounded passes.
    // Each pass gathers the two deepest overlaps at the recovered position:
    // one overlap is a plain pushout, two with converging normals (dot < 0)
    // are solved simultaneously — the translation d with d·n1 = depth1 and
    // d·n2 = depth2 escapes through the wedge mouth instead of oscillating.
    // A true crush (near-opposite normals) falls back to the deepest pushout
    // and leaves a residual at the cap.
    if (overlapHit) {
      let finalPos = start;
      for (let pass = 0; pass < 4; pass++) {
        // Gather the two deepest contacts INCLUDING within-skin ones: a full
        // pushout of one wedge face re-embeds the other, so scanning only for
        // depth > SKIN sees one face per pass and ping-pongs. The shallow
        // second face must join the solve before the first pushout runs.
        let a: { normal: Vec2; depth: number } | null = null;
        let b: { normal: Vec2; depth: number } | null = null;
        for (const target of this.bodies) {
          if (target === body || target.removed) continue;
          if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
          if (body.exceptions.has(target.id)) continue;
          if (!target.hasShape()) continue;
          for (const ts of target.getShapes()) {
            const ov = circleOverlap(finalPos, r, ts);
            if (!ov) continue;
            if (!a || ov.depth > a.depth) {
              b = a;
              a = { normal: ov.normal, depth: ov.depth };
            } else if (!b || ov.depth > b.depth) {
              b = { normal: ov.normal, depth: ov.depth };
            }
          }
        }
        if (!a || a.depth <= SKIN) break;
        const c = b ? a.normal.dot(b.normal) : 1;
        // Converging pair: translate so BOTH faces end flush (d·n1 = depth1,
        // d·n2 = depth2) — the exit through the wedge mouth. Guarded away
        // from a degenerate crush (denominator 1-c² explodes as c → -1),
        // which falls back to the deepest pushout and accepts a residual.
        if (b && c < 0 && c > -0.98) {
          const inv = 1 / (1 - c * c);
          const ka = (a.depth - c * b.depth) * inv;
          const kb = (b.depth - c * a.depth) * inv;
          finalPos = finalPos.add(a.normal.mul(ka)).add(b.normal.mul(kb));
        } else {
          finalPos = finalPos.add(a.normal.mul(a.depth));
        }
      }
      const travel = finalPos.sub(start);
      const position = finalPos.sub(overlapHit.normal.mul(r));
      traceContact("overlap", body, overlapHit.collider, overlapHit.normal, position, testOnly);
      if (!testOnly) {
        body.globalPosition = finalPos;
        this.applyCharacterPush(body, overlapHit.collider, overlapHit.normal, position);
      }
      return new KinematicCollision2D(
        overlapHit.normal,
        travel,
        motion,
        overlapHit.collider,
        position,
      );
    }

    if (!sweepHit) {
      if (!testOnly) body.globalPosition = start.add(motion);
      return null;
    }

    // Stop at contact, backing off by the skin so the body rests just clear.
    const contact = start.add(motion.mul(sweepHit.t));
    const finalPos = contact.add(sweepHit.normal.mul(SKIN));
    const travel = finalPos.sub(start);
    const remainder = motion.mul(1 - sweepHit.t);
    const position = contact.sub(sweepHit.normal.mul(r));
    traceContact("sweep", body, sweepHit.collider, sweepHit.normal, position, testOnly);
    if (!testOnly) {
      body.globalPosition = finalPos;
      this.applyCharacterPush(body, sweepHit.collider, sweepHit.normal, position);
    }
    return new KinematicCollision2D(
      sweepHit.normal,
      travel,
      remainder,
      sweepHit.collider,
      position,
    );
  }

  // Circles are the only physics-driven shape and "move when collided with by
  // the player" (game-design.md) — impart a modest mass-aware impulse.
  private applyCharacterPush(
    body: CharacterBody2D,
    collider: PhysicsBody2D,
    normal: Vec2,
    position: Vec2,
  ): void {
    if (!body.pushesRigidBodies || !(collider instanceof RigidBody2D)) return;
    const rel = body.velocity.sub(collider.velocityAtPoint(position));
    const vn = rel.dot(normal); // normal points toward the character
    if (vn >= 0) return;
    const mEff = (body.mass * collider.mass) / (body.mass + collider.mass);
    collider.applyImpulse(
      normal.mul(vn * mEff * CHARACTER_PUSH_FACTOR),
      position.sub(collider.globalPosition),
    );
  }

  // ---- space-state IntersectRay -----------------------------------------

  intersectRay(from: Vec2, to: Vec2, opts: RayOptions = {}): RayResult | null {
    const excludeIds = new Set((opts.exclude ?? []).map((b) => b.id));
    let best: RayResult | null = null;
    let bestT = Infinity;
    for (const body of this.bodies) {
      if (body.removed || excludeIds.has(body.id)) continue;
      if (!this.matchesMask(body, opts.collisionMask)) continue;
      if (!body.hasShape()) continue;
      for (const s of body.getShapes()) {
        const hit = rayVsShape(from, to, s, opts.hitFromInside ?? false);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          best = { collider: body, position: hit.position, normal: hit.normal };
        }
      }
    }
    return best;
  }

  // ---- space-state IntersectShape (circle overlap query) ----------------

  intersectCircle(center: Vec2, radius: number, maxResults = 64): PhysicsBody2D[] {
    const probe: ShapeTransform = {
      globalPosition: center,
      globalRotation: 0,
      shape: circleShape(radius),
    };
    const out: PhysicsBody2D[] = [];
    for (const body of this.bodies) {
      if (body.removed || !body.hasShape()) continue;
      // Overlap test: does the probe circle intersect the body's shape?
      if (body.getShapes().some((s) => shapesOverlap(probe, s))) {
        out.push(body);
        if (out.length >= maxResults) break;
      }
    }
    return out;
  }

  // ---- dynamic-body integration -----------------------------------------

  integrate(dt: number): void {
    this.applyAreaForces(dt);
    PhaseTrace.mark("areas", this);
    for (const body of this.bodies) {
      if (body instanceof RigidBody2D && !body.removed) {
        body.linearVelocity = body.linearVelocity.add(GRAVITY.mul(body.gravityScale * dt));
        body.globalPosition = body.globalPosition.add(body.linearVelocity.mul(dt));
        body.globalRotation += body.angularVelocity * dt;
      }
    }
    PhaseTrace.mark("gravity", this);
    this.resolveDynamicCollisions(dt);
    this.notifyAreas();
  }

  // Constant-acceleration areas (a river current, wind). Runs before gravity
  // so a body entering the area is already carried on its first frame inside.
  // Both velocity-carrying body types are pushed — the grapple avatar and the
  // hook are CharacterBody2D, the ball, its hook and loose debris are
  // RigidBody2D — so a current moves everything that can move. A level with no
  // force areas touches nothing here, keeping recorded replays bit-identical.
  private applyAreaForces(dt: number): void {
    for (const area of this.areas) {
      if (!(area instanceof ForceArea) || area.removed || !area.hasShape()) continue;
      if (area.magnitude === 0) continue;
      const dv = area.acceleration.mul(dt);
      const ashape = area.primaryShape();
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (!body.getShapes().some((s) => shapesOverlap(ashape, s))) continue;
        if (body instanceof RigidBody2D) {
          body.linearVelocity = body.linearVelocity.add(dv);
        } else if (body instanceof CharacterBody2D) {
          // The character's state machine reads this velocity next frame; the
          // grounded basis discards the into-surface component, so a current
          // pushes along a floor rather than through it.
          body.velocity = body.velocity.add(dv);
        }
      }
    }
  }

  // Positional-only push-out of one rigidbody's shapes from the solid geometry
  // around it.
  // Velocity and rotation are untouched — this is not a contact solve but the
  // "geometry wins" pass a constraint solver that runs AFTER integrate needs.
  // Rope writes its positional correction straight onto a rigid body (only the
  // grapple avatar sweeps, see Rope.applyCorrectionMotion, which is written
  // assuming the world depenetrates everything else); the ball's chain solves
  // after World.integrate, so nothing else in its frame can undo a correction
  // that pulls the ball into a surface. Iterated so a body wedged in a corner
  // settles out of both faces rather than sliding along one into the other.
  //
  // "Solid" here is any body the world collides with — a StaticBody2D *or*
  // another RigidBody2D — and not only the statics it used to mean. The
  // narrower version was sufficient only while rects and polygons were never
  // physics-driven, so the sole thing a rope could haul the ball into was static
  // scenery. A rigid polygon's surface is exactly as solid, and the failure it
  // leaves is the one this guard exists to prevent, in the same words: a chain
  // anchored to one of its faces hauls the ball a little deeper every frame,
  // because the rope writes position last and wins. Left unguarded the ball
  // buried itself ~16 cm into a rigid polygon over ~20 frames, and when it
  // finally emerged the wrap path it should have been taking all along appeared
  // at full size in a single frame — half a metre of length error, which the
  // solver converted straight into a 96 m/s launch (session-1474f).
  //
  // Returns the outward normals it pushed along. A surface a body had to be
  // pushed out of is a surface that body is resting against, and a caller that
  // derives velocity from the frame's displacement (see BallLevel) needs that
  // set to refuse itself credit for driving into one.
  depenetrateRigid(body: RigidBody2D, iterations = 2): Vec2[] {
    const pushedOutOf: Vec2[] = [];
    if (body.removed || !body.hasShape()) return pushedOutOf;
    for (let pass = 0; pass < iterations; pass++) {
      const [a, b] = this.gatherDepenetration(body);
      if (!a) return pushedOutOf;
      // Resolve the two deepest overlaps *together* rather than one after the
      // other. Pushing fully out of one surface can push straight into another,
      // and a sequential pushout then ping-pongs deeper into the pair every pass
      // — whichever surface was handled last wins. `moveAndCollide` already
      // solves this for the character sweep, and this is the same solve: for a
      // converging pair, the translation d with d·n1 = depth1 and d·n2 = depth2
      // leaves both faces flush, escaping through the wedge mouth.
      //
      // A ball resting on the floor beneath a rigid polygon is exactly such a
      // wedge — floor pushing up, polygon pushing down — and resolved
      // sequentially it drove the ball ~10 cm into the floor over four frames,
      // the polygon's push landing last every time (session-284f).
      const c = b ? a.normal.dot(b.normal) : 1;
      if (b && c < 0 && c > -0.98) {
        const inv = 1 / (1 - c * c);
        body.globalPosition = body.globalPosition
          .add(a.normal.mul((a.depth - c * b.depth) * inv))
          .add(b.normal.mul((b.depth - c * a.depth) * inv));
        pushedOutOf.push(a.normal, b.normal);
      } else if (b && c <= -0.98) {
        // A true crush: two near-opposite faces, whose simultaneous solve has no
        // finite answer (the denominator explodes as c → -1). The two demands are
        // mutually exclusive, so the best available position is the one that
        // **equalises** them: moving along `a.normal` by half the difference
        // leaves both faces at the mean depth, and leaves a body already centred
        // between them exactly where it is.
        //
        // This used to resolve the deepest face in full and accept a residual,
        // which is the very thing the simultaneous solve above exists to prevent
        // - "pushing fully out of one surface can push straight into another, and
        // whichever was handled last wins" - reintroduced in the one branch where
        // both surfaces are certain to be real. And it is iterated, so the last
        // pass wins and the error compounds: a ball resting on the floor with a
        // falling slab on top of it was shoved 33 mm up out of the floor, which
        // buried it 47 mm in the slab, which shoved it 47 mm back down, net
        // deeper than it began. Every frame, until it was a quarter of a metre
        // inside the ground (session-326f).
        body.globalPosition = body.globalPosition.add(a.normal.mul((a.depth - b.depth) * 0.5));
        // Held by both, so both are surfaces this frame drove the body out of -
        // callers deriving velocity from the frame (see BallLevel) must refuse
        // themselves credit for driving into either.
        pushedOutOf.push(a.normal, b.normal);
      } else {
        // A single overlap: push out of it.
        body.globalPosition = body.globalPosition.add(a.normal.mul(a.depth));
        pushedOutOf.push(a.normal);
      }
    }
    return pushedOutOf;
  }

  // The two deepest overlaps of `body` against the solid geometry around it, at
  // its current position. Rotation never changes during a depenetration pass, so
  // each shape's offset from the body centre is fixed and the overlaps can simply
  // be re-gathered after every push.
  private gatherDepenetration(
    body: RigidBody2D,
  ): [{ normal: Vec2; depth: number } | null, { normal: Vec2; depth: number } | null] {
    let a: { normal: Vec2; depth: number } | null = null;
    let b: { normal: Vec2; depth: number } | null = null;
    const consider = (ov: { normal: Vec2; depth: number }): void => {
      if (!a || ov.depth > a.depth) {
        b = a;
        a = ov;
      } else if (!b || ov.depth > b.depth) {
        b = ov;
      }
    };
    for (const bshape of body.getShapes()) {
      for (const other of this.bodies) {
        if (other === body || other.removed || !other.hasShape()) continue;
        if (body.exceptions.has(other.id)) continue;
        if (!isSolidTarget(other)) continue;
        for (const oshape of other.getShapes()) {
          if (bshape.shape.kind === "circle") {
            const ov = circleOverlap(bshape.globalPosition, bshape.shape.radius, oshape);
            if (ov) consider(ov);
          } else {
            // A vertex shape contributes its manifold points, same as the
            // dynamic solver reads them.
            for (const ct of shapeContacts(bshape, oshape)) consider(ct);
          }
        }
      }
    }
    return [a, b];
  }

  // Every contact in the scene, as one constraint per manifold point.
  //
  // Three things this has to get right, and each of them is a defect in the
  // per-body routines it replaces:
  //
  // **Each pair appears once.** The ordered loop (`i < j`) is the whole point.
  // Iterating "every body against every other" visits A-B twice, once with each
  // as the subject, and each visit solves half the contact with no knowledge of
  // the other — which is exactly why `RIGID_PAIR_SHARE` had to exist and exactly
  // why it does not need to any more.
  //
  // **The order is a pure function of body index, shape index and point index.**
  // Nothing here is ordered by a map or a set. The sim is deterministic and
  // `replay selftest` must stay bit-identical, so the solve order has to be
  // reproducible; the warm-start cache is keyed lookup only, never iteration.
  //
  // **`a` is chosen without reference to list order.** It is the dynamic body,
  // or the lower id when both are. If it were "whichever came first in
  // `this.bodies`", adding or removing a body mid-run would flip the roles of an
  // existing pair, and every warm-start key for that pair would miss.
  //
  // Statics stay in the list as one-sided constraints rather than being split
  // off: with zero inverse mass and inertia they fall out of the same arithmetic,
  // which is what removes the static/dynamic branch split rather than doubling
  // it. The O(n²) loop stays too — at this scene scale a broadphase is complexity
  // with no payoff.
  collectContacts(): ContactConstraint[] {
    const out: ContactConstraint[] = [];
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      const bi = this.bodies[i]!;
      if (bi.removed || !bi.hasShape() || !isSolidTarget(bi)) continue;
      for (let j = i + 1; j < n; j++) {
        const bj = this.bodies[j]!;
        if (bj.removed || !bj.hasShape() || !isSolidTarget(bj)) continue;
        if (bi.exceptions.has(bj.id)) continue;
        const iLeads =
          bi instanceof RigidBody2D && (!(bj instanceof RigidBody2D) || bi.id < bj.id);
        const a = iLeads ? bi : bj;
        const b = iLeads ? bj : bi;
        // Neither side can move: two statics touching is not a contact.
        if (!(a instanceof RigidBody2D)) continue;
        const as = a.getShapes();
        const bs = b.getShapes();
        for (let si = 0; si < as.length; si++) {
          for (let sj = 0; sj < bs.length; sj++) {
            this.gatherShapePair(out, a, si, as[si]!, b, sj, bs[sj]!);
          }
        }
      }
    }
    return out;
  }

  // The constraints for one (shape, shape) pair, with normals normalised to the
  // out-of-`b`-toward-`a` convention.
  private gatherShapePair(
    out: ContactConstraint[],
    a: RigidBody2D,
    shapeA: number,
    sa: ShapeTransform,
    b: PhysicsBody2D,
    shapeB: number,
    sb: ShapeTransform,
  ): void {
    // EVERY contact comes here, circles against static geometry included. That
    // one was the last exclusion, and what it excluded was a load path: a rigid
    // slab resting on the ball was solved against a ball the solver believed was
    // free to move, because the floor holding the ball up was being solved in a
    // different system afterwards. The slab pressed, the ball gave way on paper,
    // the circle pass then stopped the ball against the floor, and the slab kept
    // a permanent 0.229 m/s into a ball that was not going anywhere - for as long
    // as it sat there, with the depenetration sweep quietly absorbing the
    // difference every frame.
    //
    // What `resolveRigidCircle` is left with is the ball & chain avatar's
    // STEERING, which is not a contact solve at all: a kinematic control input
    // that overrides the tangential velocity the solver just wrote.
    const push = (normal: Vec2, depth: number, point: Vec2, featureId: number): void => {
      out.push({
        a,
        b,
        shapeA,
        shapeB,
        point,
        normal,
        depth,
        featureId,
        normalImpulse: 0,
        tangentImpulse: 0,
        slipping: false,
      });
    };
    if (sa.shape.kind !== "circle") {
      // `shapeContacts(x, y)` reports normals out of `y` toward `x`, which is
      // already the convention.
      for (const c of shapeContacts(sa, sb, CONTACT_SLOP)) {
        push(c.normal, c.depth, c.point, c.featureId);
      }
      return;
    }
    if (sb.shape.kind !== "circle") {
      // The vertex shape has to lead, so the normals come out the other way.
      for (const c of shapeContacts(sb, sa, CONTACT_SLOP)) {
        push(c.normal.neg(), c.depth, c.point, c.featureId);
      }
      return;
    }
    // Two circles. Written out rather than routed through `circleOverlap`,
    // which reports nothing at all once the two are apart; inside the slop band
    // this still has to answer with a negative depth.
    const ra = sa.shape.radius;
    const delta = sa.globalPosition.sub(sb.globalPosition);
    const dist = delta.length();
    const depth = ra + sb.shape.radius - dist;
    if (depth <= -CONTACT_SLOP) return;
    const normal = dist > 1e-9 ? delta.div(dist) : Vec2.UP;
    // A circle's contact point is on its own rim, back along the normal.
    push(normal, depth, sa.globalPosition.sub(normal.mul(ra)), CIRCLE_PAIR_FEATURE);
  }

  // Solve a list of constraints as a sequential-impulse system: one impulse per
  // contact, computed once for the pair, applied equal and opposite.
  //
  // This is Catto's formulation (GDC 2006), the one Box2D uses and effectively
  // every 2D engine has converged on. Nothing about these rigid bodies is novel,
  // so the answer to every design question here is "what does Box2D do"; the
  // novel mechanic is the rope, and the rope is exactly what this does not touch.
  // It runs before `Rope`/`BallLevel` as the contact solve always has, and hands
  // them a scene whose velocities are physically sane.
  //
  // Velocity only. Position is recovered by the scene-wide `depenetrateRigid`
  // sweep that closes the step, plus the per-pair push below.
  private solveContacts(constraints: ContactConstraint[], dt: number): void {
    const previous = this.contactCache;
    this.contactCache = new Map<string, CachedImpulses>();
    if (constraints.length === 0) return;
    // Velocities as the solve found them, so the audit can ask whether every
    // change it left is explained by an impulse the pair actually applied.
    const before = ContactAudit.enabled ? this.snapshotVelocities() : null;
    if (before) ContactAudit.applied.clear();

    const solved: SolverContact[] = [];
    for (const c of constraints) {
      const bRigid = c.b instanceof RigidBody2D ? c.b : null;
      const rA = c.point.sub(c.a.globalPosition);
      const rB = c.point.sub(c.b.globalPosition);
      const invMassA = c.a.inverseMass;
      const invMassB = bRigid ? bRigid.inverseMass : 0;
      // A body whose rotation is driven externally (the ball's aim steering
      // overwrites `angularVelocity` every frame) is rotationally locked as far
      // as a contact is concerned: an impulse poured into its spin would be
      // discarded, and the waste is what let a steered ball slide instead of
      // braking. A static `b` is the same statement with both terms zero, which
      // is what lets one solver handle both without a branch.
      const invIA = c.a.kinematicRotation ? 0 : c.a.inverseInertia;
      const invIB = bRigid ? (bRigid.kinematicRotation ? 0 : bRigid.inverseInertia) : 0;

      const rAxN = rA.cross(c.normal);
      const rBxN = rB.cross(c.normal);
      const invEffN = invMassA + invMassB + rAxN * rAxN * invIA + rBxN * rBxN * invIB;
      if (invEffN <= 1e-9) continue;
      const tangent = new Vec2(-c.normal.y, c.normal.x);
      const rAxT = rA.cross(tangent);
      const rBxT = rB.cross(tangent);
      const invEffT = invMassA + invMassB + rAxT * rAxT * invIA + rBxT * rBxT * invIB;

      // Restitution, captured once from the PAIR-relative approach at the point -
      // both bodies' `velocityAtPoint`, not `a`'s alone - and never re-derived
      // per iteration. Re-applying a bounce to a velocity that already contains
      // it is how an iterated solver invents energy.
      const vn = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(c.normal);
      const restitution = Math.max(c.a.restitution, bRigid ? bRigid.restitution : 0);
      const bounce = vn < -RESTITUTION_THRESHOLD ? -restitution * vn : 0;

      solved.push({
        c,
        bRigid,
        rA,
        rB,
        invIA,
        invIB,
        tangent,
        invEffN,
        invEffT,
        bounce,
        approach: Math.max(0, -c.depth) / dt,
        friction: combinedFriction(c.a, c.b, bRigid),
        brakePos: brakeScale(c.a, bRigid, tangent),
        brakeNeg: brakeScale(c.a, bRigid, tangent.neg()),
        key: `${c.a.id}:${c.b.id}:${c.shapeA}:${c.shapeB}:${c.featureId}`,
      });
    }

    // Warm start: begin from last frame's accumulated impulses instead of from
    // zero, applied equal and opposite before the first iteration.
    //
    // This is not an optimisation. Cold-started, the iterations have to re-derive
    // the entire support load of a pile from scratch every single frame and with
    // any finite budget never quite get there - which is exactly the class of
    // residual-jitter bug the resting-contact work has been chasing one symptom
    // at a time, and why a four-box stack blew itself apart across the floor.
    // Warm started, the iterations only correct the CHANGE since last frame.
    //
    // A cached impulse is a starting guess and not a claim about state, so a
    // stale entry (the contact has gone) is simply dropped and a wrong guess
    // costs iterations and never correctness. That is also why the rope
    // rewriting the ball's velocity after this solve does not invalidate it.
    for (const s of solved) {
      const cached = previous.get(s.key);
      if (!cached) continue;
      s.c.normalImpulse = cached.n;
      s.c.tangentImpulse = cached.t;
      applyPairImpulse(
        s,
        s.c.normal.mul(cached.n).add(s.tangent.mul(cached.t)),
      );
    }

    for (let it = 0; it < VELOCITY_ITERATIONS; it++) {
      for (const s of solved) {
        // Tangent first, then normal - Box2D's ordering, so the non-penetration
        // solve gets the last word over anything friction has just done.
        this.solveTangent(s);
        this.solveNormal(s);
      }
    }

    for (const s of solved) {
      this.contactCache.set(s.key, { n: s.c.normalImpulse, t: s.c.tangentImpulse });
      // What this contact actually spent, normal and tangent. The phase delta
      // says the contact solve gave the ball 1.2 m/s sideways; this says which
      // contact paid for it, and whether it was at the Coulomb limit.
      PhaseTrace.contact(
        s.c.a,
        s.c.b,
        s.c.normalImpulse,
        s.c.tangentImpulse,
        s.c.normal,
        s.c.point,
        s.c.slipping,
      );
    }

    if (before) this.auditImpulses(before);
    this.separatePairs(constraints);
  }

  private snapshotVelocities(): Map<number, { v: Vec2; w: number }> {
    const out = new Map<number, { v: Vec2; w: number }>();
    for (const body of this.bodies) {
      if (body instanceof RigidBody2D && !body.removed) {
        out.set(body.id, { v: body.linearVelocity, w: body.angularVelocity });
      }
    }
    return out;
  }

  // Every body's momentum change across the solve must equal the impulses the
  // pair solve handed it, and nothing else. A discrepancy means something in the
  // contact phase wrote a velocity outside the pair bookkeeping - which is the
  // exact shape of the friction motor this solver replaced.
  private auditImpulses(before: Map<number, { v: Vec2; w: number }>): void {
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed) continue;
      const was = before.get(body.id);
      if (!was) continue;
      const applied = ContactAudit.applied.get(body.id) ?? { p: Vec2.ZERO, l: 0 };
      const dp = body.linearVelocity.sub(was.v).mul(body.mass);
      const dl = (body.angularVelocity - was.w) * body.inertia;
      // Scaled by what was actually applied: these are float sums over up to
      // `VELOCITY_ITERATIONS` increments, so the honest bar is relative.
      const tolP = 1e-9 + 1e-9 * applied.p.length();
      const tolL = 1e-9 + 1e-9 * Math.abs(applied.l);
      const residual = dp.sub(applied.p);
      if (residual.length() > tolP) {
        // The residual, not the two totals: they agree to several digits by
        // construction and printing both hides the very thing being reported.
        ContactAudit.violations.push(
          `body#${body.buildIndex} ${body.name || body.constructor.name}: ` +
            `${residual.length().toExponential(3)} N·s of momentum change with no impulse behind ` +
            `it (applied |P|=${applied.p.length().toExponential(3)})`,
        );
      }
      if (Math.abs(dl - applied.l) > tolL) {
        ContactAudit.violations.push(
          `body#${body.buildIndex} ${body.name || body.constructor.name}: ` +
            `${Math.abs(dl - applied.l).toExponential(3)} N·m·s of angular momentum change with ` +
            `no impulse behind it (applied |L|=${Math.abs(applied.l).toExponential(3)})`,
        );
      }
    }
  }

  // Coulomb friction, accumulated and clamped to the cone of this contact's OWN
  // accumulated normal impulse.
  //
  // `mu * Pn` is the whole cap. The one-sided routines had to size their friction
  // budget from the normal velocity they had just killed plus a gravity bite,
  // because at rest that is all a single pass can see of the load; the
  // accumulated normal impulse *is* the support load, warm starting keeps it
  // honest across frames, and adding the estimate on top would double-count it.
  //
  // The cap is also the only thing bounding a body whose rotation is driven
  // externally. The ball's aim steering rewrites `angularVelocity` every frame,
  // so its spin is an infinite reservoir as far as a contact is concerned, and
  // the slip it presents at the contact point is a conveyor belt. That is the
  // INTENDED mechanic - it is how a steered ball rolls, and it has to work
  // against scenery exactly as it works against the world, or the ball simply
  // spins on the spot the moment it touches a rigid body. What keeps it honest
  // is that the drive is Coulomb-capped: a crate with its own grip on the ground
  // holds, because the cone the ball can spend is `mu` times the ball's weight
  // while the crate's grip is `mu_s` times the weight of the crate and the ball
  // together. `spin-drive` asserts exactly that.
  private solveTangent(s: SolverContact): void {
    if (s.friction <= 0 || s.invEffT <= 1e-9) return;
    const { c } = s;
    const vt = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(s.tangent);
    // The cone is asymmetric only for an aiming ball: `contactBrakeScale` fades
    // impulses that oppose its travel so reorienting the spin mid-roll cannot
    // shed momentum, while impulses that drive it still land in full. Written on
    // the cone rather than on the applied increment so the running total stays a
    // true record of what was applied, which is what warm starting reads.
    const cone = s.friction * c.normalImpulse;
    const total = clamp(
      c.tangentImpulse - vt / s.invEffT,
      -cone * s.brakeNeg,
      cone * s.brakePos,
    );
    const delta = total - c.tangentImpulse;
    c.slipping = cone > 0 && Math.abs(total) >= cone - 1e-12;
    c.tangentImpulse = total;
    if (delta !== 0) applyPairImpulse(s, s.tangent.mul(delta));
  }

  // Non-penetration, accumulated with the running total clamped at zero rather
  // than each increment clamped on its own. A later iteration may hand back part
  // of an earlier one, which is what lets the points of a face settle on the load
  // split that actually holds the body still instead of each over-correcting for
  // the other.
  private solveNormal(s: SolverContact): void {
    const { c } = s;
    const vn = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(c.normal);
    // A contact still separated by `s.gap` may legitimately close at up to
    // `gap/dt` without ending the step overlapping, so that is what it is
    // allowed to approach at. For a touching or penetrating contact the gap is
    // zero and this is the plain non-penetration constraint; for a separated one
    // it is a speculative contact, which is what lets a point stay in the set
    // across the frames it is not quite touching without braking anything.
    const total = Math.max(0, c.normalImpulse + (s.bounce - s.approach - vn) / s.invEffN);
    const delta = total - c.normalImpulse;
    c.normalImpulse = total;
    if (delta !== 0) applyPairImpulse(s, c.normal.mul(delta));
  }

  // Per-pair positional push, kept from the routines this replaces.
  //
  // Leaning on the scene-wide sweep alone is not equivalent: it resolves only the
  // two deepest overlaps per body per pass, and removing the per-pair pushes left
  // the ball 240 mm inside the ground. Split by inverse mass rather than in half,
  // so a light body against a heavy one is the one that moves - each body used to
  // push itself half the depth on its own visit, which came to the same total
  // separation only because it never asked which body should give way.
  //
  // One push per (shape, shape) pair, at that pair's deepest point: the points of
  // a manifold share a normal, so pushing out at each in turn would push out
  // several times over. The gather emits a pair's points contiguously, so the run
  // is found by walking the list - never by grouping it into a map, which would
  // put a map's ordering into a sequence of position writes.
  private separatePairs(constraints: ContactConstraint[]): void {
    for (let i = 0; i < constraints.length; ) {
      const head = constraints[i]!;
      let deepest = head;
      let j = i + 1;
      while (j < constraints.length) {
        const c = constraints[j]!;
        if (c.a !== head.a || c.b !== head.b || c.shapeA !== head.shapeA || c.shapeB !== head.shapeB) {
          break;
        }
        if (c.depth > deepest.depth) deepest = c;
        j++;
      }
      i = j;
      const bRigid = deepest.b instanceof RigidBody2D ? deepest.b : null;
      const invMassA = deepest.a.inverseMass;
      const invMassB = bRigid ? bRigid.inverseMass : 0;
      const total = invMassA + invMassB;
      // A speculative contact is not overlapping, so there is nothing to push
      // out of - pushing along a negative depth would drag the pair together.
      if (total <= 0 || deepest.depth <= 0) continue;
      const push = deepest.normal.mul(deepest.depth / total);
      deepest.a.globalPosition = deepest.a.globalPosition.add(push.mul(invMassA));
      if (bRigid) bRigid.globalPosition = bRigid.globalPosition.sub(push.mul(invMassB));
    }
  }

  private resolveDynamicCollisions(dt: number): void {
    // Rigid versus rigid, as one impulse per contact solved for the pair.
    //
    // Only rigid-vs-rigid, deliberately. That is where the defect was, it keeps
    // the ball's static behaviour - `resolveRigidCircle`'s steering branch and
    // its centred-circle path, which is bit-identical to every recorded replay -
    // untouched, and it makes the change reviewable. Folding static contacts into
    // the same solver is a worthwhile follow-up once `cli contacts` has been
    // green across a few changes, and a valuable one: warm-started static
    // manifolds are where Box2D's resting-stack quality actually comes from.
    const constraints = this.collectContacts();
    this.solveContacts(constraints, dt);
    PhaseTrace.mark("contacts", this);

    // Which surfaces each body met this frame, and the grippiest of them.
    // `contactDamp` is once per body per frame now (see below), so it is the
    // body's own pass that has to know, rather than each contact damping as it
    // goes.
    const grips = new Map<number, number>();
    const met = (body: PhysicsBody2D, grip: number): void => {
      grips.set(body.id, Math.max(grips.get(body.id) ?? 0, grip));
    };
    for (const c of constraints) {
      // Only contacts that actually PUSHED BACK count. The gather keeps
      // speculative contacts - bodies within `CONTACT_SLOP` but not yet touching
      // - so that a resting pile's constraints persist for warm starting, and
      // those carry no impulse by construction. Damping a body for merely being
      // near another is a permanent brake on something that is not touching
      // anything: a ball hanging on a chain a centimetre clear of a crate was
      // slowed 2% every frame, the chain read that refusal as a block, and the
      // winch stall paid out slack against it for ever - 1.7 m of chain grown to
      // 3.7 and never released (session-611f).
      if (c.normalImpulse <= 0) continue;
      met(c.a, c.b.surfaceFriction);
      met(c.b, c.a.surfaceFriction);
    }

    const gripped = this.applyStaticGrip(constraints, dt);
    // The steered ball's grip, which is the only thing a circle contact still
    // needs beyond the constraint solve above: aim steering drives the ball's
    // rotation kinematically, and a control input with no force behind it cannot
    // be expressed as an impulse the solver would cap.
    for (const id of this.applySteeringGrip(constraints, dt)) gripped.add(id);
    PhaseTrace.mark("grip", this);

    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed || !body.hasShape()) continue;
      // Gripped by NAME this frame, rather than by a scene-wide "something
      // gripped" flag and a counter the grip pass had already reset: a body
      // gripped last frame and let go this one still reads `ungrippedFrames === 0`
      // when this loop reaches it, so the old test held its anchor for as long as
      // any OTHER body in the scene was still gripping.
      const stuck = gripped.has(body.id);
      // Released this frame - but not on the strength of one frame.
      //
      // The anchor has to go eventually, or a body that has left the ground snaps
      // back to a stale spot. It must NOT go on a single ungripped frame, though,
      // because the grip flickers: the normal solve leaves a little spin, and
      // every eighth frame or so it crosses `STICK_SPIN` and the gate says no. Each
      // of those dropped the anchor and re-seeded it wherever the body had drifted
      // to in the meantime, and the drift is always downhill - so a crate ratcheted
      // 21 cm down a 30 degree slope it is meant to hold, a few tenths of a
      // millimetre at a time.
      if (stuck) {
        body.ungrippedFrames = 0;
      } else if (++body.ungrippedFrames > STICK_RELEASE_FRAMES) {
        body.releaseStick();
      }
    }

    // Light contact drag, ONCE PER BODY PER FRAME.
    //
    // It used to be applied once per (shape, shape) pair, at the end of each
    // contact routine, which a scene-wide constraint list would apply several
    // times over: a body touching three things would be damped three times for
    // no reason but how its neighbours happen to be cut up. `contactDamp` is a
    // nonphysical drag a standard engine would express as global linear damping,
    // and it stays only because its default is replay-locked - so the one thing
    // it must not do is depend on geometry it has nothing to do with.
    //
    // The grippiest surface the body met decides, which reduces to exactly the
    // old value for the single-contact case every body used to be. The
    // `grip === 1` branch is not an optimisation: it keeps the default path on
    // the literal `contactDamp`, since 1 - (1 - 0.98) * 1 does not round back to
    // exactly 0.98 and would drift recorded replays.
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed) continue;
      const grip = grips.get(body.id);
      if (grip === undefined) continue;
      const damp = grip === 1 ? body.contactDamp : 1 - (1 - body.contactDamp) * grip;
      body.linearVelocity = body.linearVelocity.mul(damp);
    }
    PhaseTrace.mark("contact-damp", this);

    // Position is recovered for the whole scene AFTER every body's contacts have
    // been solved, and iterated over all of them together.
    //
    // The contact routines above push out per (shape, shape) pair, along that
    // pair's own deepest contact and in ignorance of the others. That is the
    // wedge failure `moveAndCollide` and `depenetrateRigid` were both fixed for,
    // in their own words: pushing fully out of one surface can push straight into
    // another, and whichever pair was handled last wins. The fix was never
    // applied here, so a body touching two things at once could not settle
    // against either. A slab leaning on another polygon with its lower end on the
    // floor is exactly that wedge, and it stood **165 mm** inside them, buzzing:
    // penetration that deep churns the contact set frame to frame, so the normal
    // impulse fired about one frame in five while contact friction went on
    // torquing the body every frame, and the slab's spin sawtoothed between -0.18
    // and +0.13 rad/s for as long as it slid (session-326f).
    //
    // Sweeping the whole scene rather than recovering each body at the end of its
    // own pass is what keeps the recovery fair. Depenetration is a race: whoever
    // moves last wins the overlap, so a body recovered inside another's contact
    // pass is answering a scene that is still half-solved, and a heavier or
    // simply later-listed neighbour walks straight through it. Interleaved into
    // the loop, a falling slab drove the ball a quarter of a metre into the
    // floor; swept afterwards, the two settle against each other.
    // A gripped body's `stickAnchor` rides along with the NORMAL part of what
    // this recovery moves it by, and with none of the tangential part.
    //
    // The anchor has to follow the normal push or the two fight: the grip would
    // drag the body back to an anchor the recovery had just found to be inside
    // something, the recovery would push it out again, and a polygon resting
    // perfectly still on the floor buzzed 4 cm back and forth for as long as it
    // sat there (session-255f). Along the surface it is the opposite: the anchor
    // IS the grip, and carrying it sideways is the same as not being gripped in
    // the direction that moved. A body resting on the floor with a load leaning
    // on it was pushed a fixed 0.65 mm sideways every frame - the recovery
    // resolving that load along an inclined normal - its anchor followed, and it
    // slid 53 cm across the level at a reported velocity of 1e-8 m/s
    // (`255f`, and the same shape in `326f` and `166f`). What the pin exists to
    // cancel is exactly that: a tangential displacement nothing accelerated the
    // body into.
    for (let pass = 0; pass < DEPENETRATION_PASSES; pass++) {
      for (const body of this.bodies) {
        if (!(body instanceof RigidBody2D) || body.removed) continue;
        const before = body.globalPosition;
        this.depenetrateRigid(body, 1);
        const anchor = body.stickAnchorWorld();
        if (anchor === null || body.stickBody === null) continue;
        const delta = body.globalPosition.sub(before);
        const n = body.stickNormal;
        body.setStickAnchor(body.stickBody, anchor.add(n === null ? delta : n.mul(delta.dot(n))));
      }
    }
    // Positional, and therefore invisible to every velocity column: this phase
    // moves bodies without giving them any velocity to have moved by, which is
    // the shape of a creep.
    PhaseTrace.mark("depenetrate", this);
  }

  // The position pin, for vertex-shaped bodies resting on static geometry.
  //
  // All that is left of `resolveRigidLoop`. Everything else it used to do -
  // the normal solve, the push-out, the Coulomb friction - is now done by
  // `solveContacts` for statics as well as for rigid pairs, which is what makes a
  // pile converge at all: a load path running through a static contact cannot be
  // solved in a different system from the contacts above it.
  //
  // The VELOCITY half of stiction went with it. It was always a Coulomb-capped
  // tangential impulse solved at the contact points, which is exactly what the
  // tangential constraint is, so keeping a second copy would apply friction
  // twice.
  //
  // What no velocity constraint can remove is gravity's per-frame *integration
  // step*, because this engine integrates before it solves (replay-locked, and
  // the rope phase depends on it). Kinetic friction cancels the velocity gravity
  // adds each frame and never the step already taken with it, so a box on a 5
  // degree ramp walks about 21 cm in fifteen seconds and is not slowing. Holding
  // a slope is what the pin does, and it is the honest patch for the ordering
  // rather than a leftover. A standard engine has no such thing; it solves
  // velocities before integrating positions, so the step never lands unopposed.
  // Returns the ids of the bodies it gripped, so the release counter can be a
  // statement about THIS body rather than about the scene.
  private applyStaticGrip(constraints: ContactConstraint[], dt: number): Set<number> {
    const stuck = new Set<number>();
    // Grouped by (body, surface): the grip is one statement about whether this
    // body is sliding on that surface, and the points of a manifold share a
    // normal, so asking per point only lets one point grip while its twin slides.
    //
    // A body gets ONE pin, held to whichever surface is carrying it - the pair
    // with the largest normal impulse. Taking the first pair in the list instead
    // is how a crate being shoved by a spinning ball anchored itself to the BALL
    // and let go of the floor it was standing on, which is the opposite of what
    // stiction is for (`cli contacts` spin-drive).
    // A pair is offered from BOTH sides. Which body leads a constraint is an id
    // ordering and nothing more, so pinning only the leader pinned whichever of
    // two stacked slabs happened to be built first: in `255f` the lower slab was
    // held against the upper one it carries (which it did not need - the floor
    // was already holding it) while the upper one, the one actually sliding down
    // the face, was never offered a pin at all.
    interface Candidate {
      body: RigidBody2D;
      other: PhysicsBody2D;
      point: Vec2;
      normal: Vec2;
      slipped: boolean;
      normalImpulse: number;
    }
    const best = new Map<number, Candidate>();
    const offer = (c: Candidate): void => {
      // A scripted mover carries the surface out from under the body by design,
      // so there is nothing to hold still against.
      if (!(c.other instanceof RigidBody2D) && c.other.isMobile) return;
      // A steered ball owns its own anchor (`applySteeringGrip`), which holds a
      // rolling contact rather than a still one: the two write the same field and
      // mean different things by it.
      if (c.body.kinematicRotation) return;
      // One pin per body, to whichever surface is carrying it - the pair with the
      // largest normal impulse. Taking the first pair in the list instead is how a
      // crate being shoved by a spinning ball anchored itself to the BALL and let
      // go of the floor it was standing on, which is the opposite of what stiction
      // is for (`cli contacts` spin-drive).
      const prev = best.get(c.body.id);
      if (prev === undefined || c.normalImpulse > prev.normalImpulse) best.set(c.body.id, c);
    };
    for (let i = 0; i < constraints.length; ) {
      const head = constraints[i]!;
      let deepest = head;
      let slipped = false;
      let normalImpulse = 0;
      let j = i;
      while (j < constraints.length) {
        const c = constraints[j]!;
        if (c.a !== head.a || c.b !== head.b) break;
        if (c.depth > deepest.depth) deepest = c;
        if (c.slipping) slipped = true;
        normalImpulse += c.normalImpulse;
        j++;
      }
      i = j;
      if (deepest.depth <= 0) continue; // speculative: not resting on anything yet
      if (normalImpulse <= 0) continue; // touching, but carrying nothing
      const shared = { point: deepest.point, slipped, normalImpulse };
      offer({ body: head.a, other: head.b, normal: deepest.normal, ...shared });
      if (head.b instanceof RigidBody2D) {
        // The same contact seen from the other body: its surface normal is the
        // one pointing back at it.
        offer({ body: head.b, other: head.a, normal: deepest.normal.neg(), ...shared });
      }
    }

    for (const { body, other, point, normal: n0, slipped, normalImpulse } of best.values()) {
      const otherRigid = other instanceof RigidBody2D ? other : null;
      // The same combination the kinetic path uses: the geometric mean of what
      // each body brings, so two rigid bodies agree on one coefficient.
      const staticMu = otherRigid
        ? Math.sqrt(
            body.staticFriction *
              other.surfaceFriction *
              otherRigid.staticFriction *
              body.surfaceFriction,
          )
        : body.staticFriction * other.surfaceFriction;
      // The speed gate reads the TANGENTIAL slip at the contact, not the whole
      // relative velocity of the body's centre. Stiction is a statement about
      // sliding, and the normal component is not sliding: it is the settling the
      // solve has just dealt with, and a body pivoting about its contact has a
      // moving centre by definition. Counting either made a body that is plainly
      // not sliding fail the gate - a crate on a 30 degree ramp read 0.31 m/s
      // against the 0.3 threshold on the frames gravity had just topped up,
      // dropped the grip, re-seeded its anchor a little further downhill each
      // time, and ratcheted 21 cm down a slope it is meant to hold.
      const t0 = new Vec2(-n0.y, n0.x);
      const slip0 = Math.abs(
        body.velocityAtPoint(point).sub(other.velocityAtPoint(point)).dot(t0),
      );
      // Spin is compared RELATIVE to the surface, as the slip already is: a body
      // riding a rotating one is not sliding on it.
      const relSpin = Math.abs(body.angularVelocity - (otherRigid ? otherRigid.angularVelocity : 0));
      const gripped = staticMu > 0 && !slipped && slip0 < STICK_SPEED && relSpin < STICK_SPIN;
      if (!gripped) continue;

      // Pin the along-surface position of the CONTACT POINT, not of the body.
      //
      // A body pivoting about its contact point must move its centre, so holding
      // the centre still is an instruction to slide. Held by the centre, a slab
      // settled on one corner had its spin bled away geometrically - 0.021,
      // 0.013, 0.008, 0.005 rad/s, about a third gone every frame - with no
      // contact anywhere near it doing the braking (session-1426f).
      //
      // The anchor is a MATERIAL point of the body (`stickLocal`), not the
      // manifold point itself: that one is geometric and slides along the
      // contacting face as the body settles, so anchoring it directly sent bodies
      // drifting 80 cm up a ramp. It is held in the SURFACE's frame for the same
      // reason, which against a static is the world's and against another rigid
      // body is the only frame the statement means anything in.
      //
      // Rotation is deliberately not anchored. Freezing a gripped body's pose
      // holds it by fiat - gravity gets no say, so a slab tipped up on a corner
      // can never topple back, and any rotation written after this is kept in
      // full and re-frozen next frame, so a chain that turns the body a fraction
      // of a degree per tug ratchets it round for good (session-1195f). The
      // normal impulses are what resist rotation, which is what a two-point
      // manifold is for.
      //
      // A body resting on a RIGID one had no pin at all before this, so it kept
      // the whole of gravity's integration step: this engine integrates before it
      // solves, the velocity solve cancels the velocity gravity added and never
      // the step already taken with it, and the recovery then resolves that step
      // along the face - which on an inclined one turns a 2.7 mm fall into 0.6 mm
      // of sideways travel, every frame, for ever. A slab resting on another slab
      // slid 17 cm across `255f` at a reported velocity of 1e-7 m/s, and
      // `cli contacts` `rigid-ramp-hold` is the same thing written down as a case.
      const invA = body.inverseMass;
      const invB = otherRigid ? otherRigid.inverseMass : 0;
      const totalInv = invA + invB;
      if (totalInv <= 0) continue;
      body.stickNormal = n0;
      if (body.stickBody !== other || body.stickAnchor === null) {
        body.setStickAnchor(other, point);
        body.stickLocal = point.sub(body.globalPosition).rotated(-body.globalRotation);
        stuck.add(body.id);
        continue;
      }
      const held = body.globalPosition.add(body.stickLocal.rotated(body.globalRotation));
      const d = held.sub(body.stickAnchorWorld()!);
      let corr = d.sub(n0.mul(d.dot(n0))).mul(PIN_RELAX);
      // Coulomb, on the position solve as on the velocity one: friction can hold
      // no more than mu times the normal impulse the contact actually carried
      // this frame, which as a displacement over one step is
      // mu * Pn * (1/m_effective) * dt. This is what keeps the pin a friction
      // model rather than a weld - and what stops it hauling bodies through each
      // other, since without it a pin whose anchor had gone stale dragged a
      // struck slab 200 mm inside the body that struck it.
      const maxCorrection = staticMu * normalImpulse * totalInv * dt;
      const wanted = corr.length();
      if (wanted > maxCorrection) {
        // Asked for more than friction can hold, so the contact HAS slipped: take
        // what the cone allows and re-seed the anchor where the body now is,
        // rather than remembering the rest. A remembered excess is the pin
        // hauling a body toward a place it slid away from frames ago - 3 mm of
        // positional work per frame in `298f`, which the energy invariant reads
        // (correctly) as the solver inventing 17 J out of nothing.
        corr = corr.mul(maxCorrection / wanted);
        body.setStickAnchor(other, held.sub(corr.mul(invA / totalInv)));
        body.stickLocal = held
          .sub(corr.mul(invA / totalInv))
          .sub(body.globalPosition)
          .rotated(-body.globalRotation);
      }
      // Split by inverse mass and applied to BOTH bodies, so a light body on a
      // heavy one is the one that gives way.
      body.globalPosition = body.globalPosition.sub(corr.mul(invA / totalInv));
      if (otherRigid) {
        otherRigid.globalPosition = otherRigid.globalPosition.add(corr.mul(invB / totalInv));
      }
      stuck.add(body.id);
    }
    return stuck;
  }

  // The steered ball's grip - all that a circle contact still does outside the
  // constraint solve, and the only part of it that is not a contact.
  //
  // Aim steering drives the ball's rotation KINEMATICALLY: it overwrites
  // `angularVelocity` outright every frame, with full authority, because it is a
  // control input and not a force. A contact impulse cannot express that (the
  // solver would cap it at the Coulomb cone, and the ball is rotationally locked
  // in the solve for exactly this reason), so the roll it implies is written
  // here, after the solve, as a velocity.
  //
  // Static/kinetic split on the contact slip: while the ball's contact point is
  // moving slowly against the surface (slow, careful rotation), grip it and
  // enforce exact roll-without-slip - the centre orbits the contact, so the ball
  // rolls or pivots over it and the off-centre loop never scrubs. Spin or travel
  // fast and the slip exceeds the threshold, the anchor is dropped, and what is
  // left is the solver's Coulomb friction, which is what makes a fast ball slide.
  //
  // Everything else this used to do - the push-out, the normal solve, the
  // Coulomb friction, the resting pin - is now `solveContacts`, `separatePairs`
  // and `applyStaticGrip`, for circles exactly as for every other shape. See the
  // note in `gatherShapePair` for what keeping a private copy of it cost.
  private applySteeringGrip(constraints: ContactConstraint[], dt: number): Set<number> {
    const stuck = new Set<number>();
    // One statement per (body, surface), at the deepest of that pair's points:
    // the grip writes the body's whole velocity, so applying it once per contact
    // point would apply it several times over.
    for (let i = 0; i < constraints.length; ) {
      const head = constraints[i]!;
      let deepest = head;
      let j = i;
      while (j < constraints.length) {
        const c = constraints[j]!;
        if (c.a !== head.a || c.b !== head.b) break;
        if (c.depth > deepest.depth) deepest = c;
        j++;
      }
      i = j;

      const body = head.a;
      const other = head.b;
      if (!body.kinematicRotation) continue;
      if (other instanceof RigidBody2D) continue; // gripping is against the immovable
      if (deepest.depth <= 0) continue; // speculative: not resting on anything yet

      const normal = deepest.normal;
      const point = deepest.point;
      const staticMu = body.staticFriction * other.surfaceFriction;
      const rContact = point.sub(body.globalPosition);
      const surfV = other.velocityAtPoint(point);
      const wCrossR = new Vec2(-body.angularVelocity * rContact.y, body.angularVelocity * rContact.x);
      const relV = body.linearVelocity.add(wCrossR).sub(surfV);
      const slipTan = relV.sub(normal.mul(relV.dot(normal)));
      const g = GRAVITY.mul(body.gravityScale);
      const gN = -g.dot(normal);
      const withinBudget =
        staticMu > 0 &&
        !other.isMobile &&
        gN > 1e-6 &&
        g.sub(normal.mul(g.dot(normal))).length() <= staticMu * gN;
      if (slipTan.length() >= SLIP_STICK || !withinBudget) {
        // Slipping: release the grip and leave the solver's friction to it.
        body.releaseStick();
        continue;
      }
      // Grip: drive the centre so the contact is stationary,
      // v_centre = surfaceVel - omega x r_contact.
      const desired = surfV.sub(wCrossR);
      const vnKeep = body.linearVelocity.dot(normal);
      const rollTan = desired.sub(normal.mul(desired.dot(normal)));
      body.linearVelocity = normal.mul(vnKeep).add(rollTan);
      // Kill gravity creep at any spin: integration slides the ball one step of
      // gravity downhill each frame before this solve (worse the steeper the
      // slope); undo it by pinning the along-surface position to an anchor that
      // ADVANCES by the intended roll (rollTan*dt). The steered roll is preserved
      // exactly while the gravity drift on top is removed; at omega = 0 the anchor
      // is static and the ball simply holds.
      body.stickNormal = normal;
      // The steered ball anchors its own CENTRE rather than a contact point: the
      // grip drives the centre so the contact is stationary, so the centre is
      // what the roll advances and what the creep has to be measured against.
      const held = body.stickBody === other ? body.stickAnchorWorld() : null;
      body.setStickAnchor(other, held === null ? body.globalPosition : held.add(rollTan.mul(dt)));
      const d = body.globalPosition.sub(body.stickAnchorWorld()!);
      body.globalPosition = body.globalPosition.sub(d.sub(normal.mul(d.dot(normal))));
      stuck.add(body.id);
    }
    return stuck;
  }

  private notifyAreas(): void {
    for (const area of this.areas) {
      if (area.removed || !area.hasShape()) continue;
      const inside: CollisionObject2D[] = [];
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (body.getShapes().some((s) => shapesOverlap(area.primaryShape(), s))) inside.push(body);
      }
      area.notifyOverlaps(inside);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Apply `impulse` to `a` and its exact negative to `b`. Equal and opposite by
// construction, which is the whole point of the pair solver: it is what conserves
// momentum, and what makes a body landing on another knock it round rather than
// stop it.
function applyPairImpulse(s: SolverContact, impulse: Vec2): void {
  const { c } = s;
  c.a.linearVelocity = c.a.linearVelocity.add(impulse.mul(c.a.inverseMass));
  c.a.angularVelocity += s.rA.cross(impulse) * s.invIA;
  if (ContactAudit.enabled) {
    ContactAudit.record(c.a, impulse, s.rA.cross(impulse) * (s.invIA > 0 ? 1 : 0));
  }
  if (!s.bRigid) return; // a static `b` has infinite mass: nothing to write
  s.bRigid.linearVelocity = s.bRigid.linearVelocity.sub(impulse.mul(s.bRigid.inverseMass));
  s.bRigid.angularVelocity -= s.rB.cross(impulse) * s.invIB;
  if (ContactAudit.enabled) {
    ContactAudit.record(s.bRigid, impulse.neg(), -s.rB.cross(impulse) * (s.invIB > 0 ? 1 : 0));
  }
}

// The Coulomb coefficient one body brings to a contact with another: its own
// kinetic friction, scaled by how grippy the other body's surface is.
function contributedFriction(body: PhysicsBody2D, against: PhysicsBody2D): number {
  return (body instanceof RigidBody2D ? body.contactFriction : 0) * against.surfaceFriction;
}

// One friction coefficient for the pair.
//
// The three routines this replaces each computed `body.contactFriction *
// other.surfaceFriction`, which is asymmetric the moment both sides are rigid -
// the two passes over one contact disagreed about how much friction it had.
// Combining the two products geometrically is Box2D's rule (sqrt(muA * muB)), and
// against a static body - which brings no kinetic coefficient of its own - it
// reduces to exactly the arithmetic the replay corpus was recorded under.
function combinedFriction(
  a: RigidBody2D,
  b: PhysicsBody2D,
  bRigid: RigidBody2D | null,
): number {
  const muA = contributedFriction(a, b);
  return bRigid ? Math.sqrt(muA * contributedFriction(bRigid, a)) : muA;
}

// How much of the friction cone is available in direction `dir`.
//
// `contactBrakeScale` is a ball-controller device: while the player aims,
// impulses opposing the ball's travel are faded so reorienting the spin mid-roll
// cannot shed momentum, and impulses driving it still apply in full. It is 1 for
// everything else, so this is the identity for all scenery.
function brakeScale(a: RigidBody2D, bRigid: RigidBody2D | null, dir: Vec2): number {
  let scale = 1;
  if (a.contactBrakeScale !== 1 && dir.dot(a.linearVelocity) < 0) {
    scale = Math.min(scale, a.contactBrakeScale);
  }
  // The impulse on `b` is the negative, so it brakes `b` under the opposite test.
  if (bRigid && bRigid.contactBrakeScale !== 1 && dir.dot(bRigid.linearVelocity) > 0) {
    scale = Math.min(scale, bRigid.contactBrakeScale);
  }
  return scale;
}

// Cheap symmetric overlap test between two shape transforms.
function shapesOverlap(a: ShapeTransform, b: ShapeTransform): boolean {
  if (a.shape.kind === "circle") {
    return circleOverlap(a.globalPosition, a.shape.radius, b) !== null;
  }
  if (b.shape.kind === "circle") {
    return circleOverlap(b.globalPosition, b.shape.radius, a) !== null;
  }
  // Two vertex shapes: sample via one's bounding circle then refine with the
  // min-translation test against the other (sufficient for the area/explosion
  // queries the game issues, which always involve a circle in practice).
  return circleOverlap(a.globalPosition, shapeRadius(a.shape), b) !== null;
}
