// Physics world / space-state substitute. Owns the body list, answers the
// space queries the game issues (IntersectRay, IntersectShape, moveAndCollide)
// and integrates dynamic bodies. Semantics approximate Godot's 2D physics
// closely enough for the character controller and rope; it is self-consistent
// (deterministic replay), not bit-compatible with Godot.

import { Vec2 } from "./vec2";
import { circleShape, shapeExtents } from "./shapes";
import type { ShapeTransform } from "./shapes";
import {
  Area2D,
  CharacterBody2D,
  CollisionObject2D,
  CollisionShape2D,
  ForceArea,
  KinematicCollision2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  VineLink,
  WaterArea,
  WATER_GRIP_RELEASE,
} from "./body";
import {
  circleOverlap,
  outwardDirection,
  rayVsShape,
  shapeRadius,
  sweepCircle,
} from "./collision";
import { shapeContacts } from "./manifold";
import { AABBTree } from "./aabbTree";
import { PhaseTrace } from "./phaseTrace";
import { PhysTrace } from "./physTrace";

// Broadphase candidate order: the owner's position in `World.bodies`, then the
// shape's mount order within the owner. This is exactly the order the full
// `for (const body of this.bodies) … for (const s of body.getShapes())` scans
// the broadphase replaced used to visit shapes in, and sorting candidates into
// it is what keeps every strict-inequality tie-break downstream - deepest
// overlap, earliest sweep hit, first ray hit at equal t - choosing the same
// winner the full scan chose, which is what keeps recorded replays
// bit-identical.
function candidateOrder(a: CollisionShape2D, b: CollisionShape2D): number {
  return a.owner.worldIndex - b.owner.worldIndex || a.mountIndex - b.mountIndex;
}

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
//
// Exported because it is not only the solver's business: it is the width of the
// band inside which `integrate` will act on a pair. Anything that wants to claim
// a contact BEFORE the solver turns it into a bounce — `BallHook`'s attach test
// is the one — has to look at least this far, or the solver silently wins the
// races it loses by less than a centimetre (`session-593f`).
export const CONTACT_SLOP = 0.01;
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
const STICK_SPIN = 1.5;
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
  // The piece of the collider the ray reached. A compound body is several
  // surfaces and they need not answer the same way - the grapple hook asks the
  // one it actually hit whether it is hook-proof.
  shape: CollisionShape2D;
}

export interface RayOptions {
  collisionMask?: number;
  exclude?: CollisionObject2D[];
  hitFromInside?: boolean;
}

// Does the world resolve collisions against this body? The allowlist every
// collision path is written as. Pass-through geometry is inside it by class and
// excluded by `isSolid` / `passable` instead (see `VineLink`,
// `CollisionObject2D.passable`).
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
  // Did it get everything it asked for, against the bound actually applied?
  //
  // Not the same question as `slipping`, which is asked of the bare Coulomb
  // cone. An aiming ball's cone is faded in the direction that would brake it
  // (`contactBrakeScale`), so a contact can be pinned at its real limit with a
  // tangent impulse well inside `mu * Pn` - a ball skidding to a halt under the
  // aim sits at exactly that bound and reports `slipping: false` (`session-477f`
  // f170, 11.595 against a faded bound of 11.60 and a cone of 15.32).
  //
  // Diagnostic only: nothing in the solve reads it. `roll-unfunded` does, because
  // "the contact reached no-slip" is precisely "it was not held at its bound",
  // and reading `slipping` for that calls every braking frame a violation.
  limited: boolean;
}

// A circle pair has no faces to key on and produces exactly one point, so every
// contact between one given pair of circles is the same feature. Distinct from
// `CIRCLE_FEATURE` (a circle against a vertex shape) only for tidiness; the two
// can never be produced for the same shape pair.
const CIRCLE_PAIR_FEATURE = -2;

// Consecutive absent frames a pair's sustained load survives before it is
// forgotten. A press being held through solver flicker vanishes from the
// constraint set for a frame or two; a body that actually left is gone longer,
// and what load it re-earns on return it re-earns through the ramp.
const PAIR_LOAD_GRACE = 5;

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
  // How much of this contact's normal impulse a KINEMATIC spin fabricated, and
  // so may not fund friction with — see `spinFabricatedNormal`. 0 for every
  // contact that is not an off-centre shape on a kinematically spun body.
  readonly spinNormal: number;
  // Tangential slip a kinematic spin presents at the point (m/s), captured at
  // build and constant across the iterations (the spin's invI is 0). Nonzero
  // only when a body on the contact is kinematically spun. Its sign names the
  // DRIVE direction: the impulse cancelling it is `-sign(spinSlip)` along the
  // tangent, and that is the half of the cone `solveTangent` bounds.
  readonly spinSlip: number;
  // The normal impulse the spinning body's own weight sustains on this contact
  // per frame - what a resting contact here would carry, full on a floor and
  // nothing on a wall or ceiling. The spin-traction ramp STARTS here on a
  // fresh contact and climbs by `rampBite` per carried frame, because the spin
  // is an infinite reservoir (nothing the solve does can despin it) and an
  // impact's Pn is many frames of load at once: spent against the spin it is
  // energy from nothing, a ball rolling into a wall at 3.9 m/s leaving the
  // floor at 4.4 m/s straight up with its spin untouched (`session-773f`
  // f600).
  readonly spinCone: number;
  // Impulse the linear share of the entering slip justifies in the drive
  // direction (N·s, >= 0). Added to the spin's cap so real momentum sliding the
  // same way as the spin drives is still braked in full.
  readonly linearNeed: number;
  // One frame of the pair's weight through this contact's effective mass,
  // direction-blind (N·s): the rate the sustained-load ramp climbs at. Blind on
  // purpose - what qualifies a load for spin traction is that it PERSISTS, not
  // where it points: a taut chain pressing the ball into a wall is as real as
  // gravity pressing it into a floor, and the wound-up ball climbing to its
  // anchor is carried by exactly that press (`ball-ground-wind-up`). An impact
  // is gone before the ramp can chase it, whichever way it pointed.
  readonly rampBite: number;
  // The BODY PAIR's sustained load entering this frame (`World.pairLoad`,
  // N·s), frozen at build so the cap and the `spin-overdrive` detector read
  // the same number regardless of where the iterations left Pn mid-solve. The
  // pair and not the feature, because a compound body's touching shape changes
  // while the press persists: the wound-up ball's loop meets the wall once per
  // revolution, and per-feature continuity would read a steady press as a
  // stream of impacts.
  readonly sustained: number;
  // True when the kinematically spun body on this contact is held by an
  // anchored chain - that regime keeps legacy traction, so the ramp is off.
  readonly tethered: boolean;
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

  // Broadphase: one fat-box leaf per collision shape of every body in
  // `bodies` (areas are not proxied - nothing queries them spatially). The
  // tree answers CANDIDATES only; every query below keeps its original exact
  // per-shape tests, so the accepted set is bit-identical to the full scans
  // this replaces (see `aabbTree.ts`).
  private readonly broadphase = new AABBTree<CollisionShape2D>();
  // Bodies whose transform or shape set changed since the tree last saw them.
  // Membership is guarded by `broadphaseDirty` so a body integrating every
  // frame is pushed once, not once per write.
  private readonly broadphaseDirtyList: PhysicsBody2D[] = [];

  // Called by the transform setters on `CollisionObject2D` - the one funnel
  // every path that moves a body goes through.
  markBroadphaseDirty(obj: CollisionObject2D): void {
    if (!(obj instanceof PhysicsBody2D)) return;
    obj.broadphaseDirty = true;
    this.broadphaseDirtyList.push(obj);
  }

  // Bring the tree up to date with every dirty body. Runs at the top of every
  // spatial query, so between queries the tree may be stale and it never
  // matters.
  private syncBroadphase(): void {
    const list = this.broadphaseDirtyList;
    if (list.length === 0) return;
    for (const b of list) {
      b.broadphaseDirty = false;
      if (b.removed || b.world !== this) continue;
      this.syncBody(b);
    }
    list.length = 0;
  }

  private syncBody(body: PhysicsBody2D): void {
    const shapes = body.collisionShapes;
    const prev = body.proxiedShapes;
    const setChanged = prev.length !== shapes.length || prev.some((s, i) => s !== shapes[i]);
    if (setChanged) {
      // `setShape` replaces the array outright, so leaves for shapes no longer
      // carried have to be found through the snapshot and dropped.
      for (const s of prev) {
        if (s.broadphaseProxy >= 0 && !shapes.includes(s)) {
          this.broadphase.remove(s.broadphaseProxy);
          s.broadphaseProxy = -1;
        }
      }
    }
    for (const s of shapes) {
      const c = s.globalPosition;
      const e = s.extents();
      if (s.broadphaseProxy < 0) {
        s.broadphaseProxy = this.broadphase.insert(s, c.x - e.x, c.y - e.y, c.x + e.x, c.y + e.y);
      } else {
        this.broadphase.move(s.broadphaseProxy, c.x - e.x, c.y - e.y, c.x + e.x, c.y + e.y);
      }
    }
    if (setChanged) body.proxiedShapes = shapes.slice();
  }

  // Broadphase candidates for a world-axis box, in canonical order (see
  // `candidateOrder`).
  private queryShapes(minX: number, minY: number, maxX: number, maxY: number): CollisionShape2D[] {
    this.syncBroadphase();
    const out: CollisionShape2D[] = [];
    this.broadphase.query(minX, minY, maxX, maxY, out);
    out.sort(candidateOrder);
    return out;
  }

  // Last frame's accumulated impulses, by contact. Looked up only - never
  // iterated - so it cannot put a map's ordering anywhere near the solve.
  private contactCache = new Map<string, CachedImpulses>();

  // Names bodies for the full-world digest: assignment order in this world, not
  // the process-global `id`, so two builds of the same level agree.
  private nextBuildIndex = 0;

  add(body: CollisionObject2D): void {
    if (body.world !== this && body.world !== null) {
      // Leaves this body may hold live in ANOTHER world's tree, where this
      // world's proxy ids mean nothing. Forget them; the old world is being
      // torn down or rebuilt, or it will re-sync the body if it still holds it.
      for (const s of body.proxiedShapes) s.broadphaseProxy = -1;
      body.proxiedShapes = [];
    }
    body.world = this;
    body.removed = false;
    if (body instanceof Area2D) {
      if (!this.areas.includes(body)) this.areas.push(body);
      else return;
    } else if (body instanceof PhysicsBody2D) {
      if (!this.bodies.includes(body)) {
        this.bodies.push(body);
        body.worldIndex = this.bodies.length - 1;
        if (!body.broadphaseDirty) this.markBroadphaseDirty(body);
      } else {
        return;
      }
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
    if (i >= 0) {
      for (const s of body.proxiedShapes) {
        if (s.broadphaseProxy >= 0) {
          this.broadphase.remove(s.broadphaseProxy);
          s.broadphaseProxy = -1;
        }
      }
      body.proxiedShapes = [];
      body.worldIndex = -1;
      this.bodies.splice(i, 1);
      // Everything behind the gap slides down one place; the candidate order
      // (`worldIndex`) has to follow or it stops matching iteration order.
      for (let k = i; k < this.bodies.length; k++) this.bodies[k]!.worldIndex = k;
    }
    const j = this.areas.indexOf(body as Area2D);
    if (j >= 0) this.areas.splice(j, 1);
  }

  // Is this body asleep? Only a vine link can be (see `VineLink.asleep`), and it
  // is asked here rather than at each site so the three places that skip one
  // cannot drift apart.
  private static isAsleep(body: CollisionObject2D): boolean {
    return body instanceof VineLink && body.asleep;
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

    // Broadphase: everything the swept circle could reach, visited in the
    // order the full body scan used to visit it (see `candidateOrder`). The
    // per-shape tests below are unchanged, so the hits are identical.
    const end = start.add(motion);
    const sweepPad = r + SKIN + 1e-3;
    const sweepCands = this.queryShapes(
      Math.min(start.x, end.x) - sweepPad,
      Math.min(start.y, end.y) - sweepPad,
      Math.max(start.x, end.x) + sweepPad,
      Math.max(start.y, end.y) + sweepPad,
    );
    for (const ts of sweepCands) {
      const target = ts.owner;
      if (target === body || target.removed) continue;
      if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
      // A non-solid body blocks nothing (see `VineLink`, and `passable`, which
      // is the authored form of the same thing): both are real bodies the world
      // integrates, and both must be something the avatar walks and swings
      // straight through.
      if (!target.isSolid) continue;
      if (body.exceptions.has(target.id)) continue;
      // Every shape the target carries arrives as its own candidate. A
      // compound body (a concave form built from convex pieces) blocks with
      // all of them; a single-shape body is the one-iteration case this has
      // always been.
      {
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
        // Re-queried every pass: `finalPos` moves with each pushout.
        const reach = r + 1e-3;
        const recoverCands = this.queryShapes(
          finalPos.x - reach,
          finalPos.y - reach,
          finalPos.x + reach,
          finalPos.y + reach,
        );
        for (const ts of recoverCands) {
          const target = ts.owner;
          if (target === body || target.removed) continue;
          if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
          // Nothing is ever pushed out of a non-solid body — the same rule the
          // forward sweep above applies, and it has to hold here too or the
          // avatar would be depenetrated out of a vine it is standing in.
          if (!target.isSolid) continue;
          if (body.exceptions.has(target.id)) continue;
          {
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
    // Broadphase: walk the tree with the segment itself rather than its
    // bounding box - a long diagonal hook shot's box covers half the level,
    // the segment crosses almost none of it.
    this.syncBroadphase();
    const cands: CollisionShape2D[] = [];
    this.broadphase.querySegment(from.x, from.y, to.x, to.y, cands);
    cands.sort(candidateOrder);
    for (const s of cands) {
      const body = s.owner;
      if (!(body instanceof PhysicsBody2D)) continue;
      if (body.removed || excludeIds.has(body.id)) continue;
      if (!this.matchesMask(body, opts.collisionMask)) continue;
      {
        const hit = rayVsShape(from, to, s, opts.hitFromInside ?? false);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          best = { collider: body, position: hit.position, normal: hit.normal, shape: s };
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
    const cands = this.queryShapes(
      center.x - radius - 1e-3,
      center.y - radius - 1e-3,
      center.x + radius + 1e-3,
      center.y + radius + 1e-3,
    );
    const seen = new Set<number>();
    for (const s of cands) {
      const body = s.owner;
      if (!(body instanceof PhysicsBody2D)) continue;
      if (body.removed || seen.has(body.id)) continue;
      // Overlap test: does the probe circle intersect this shape? A body is
      // reported once, on its first overlapping shape in candidate order -
      // the same body order the full scan reported.
      if (shapesOverlap(probe, s)) {
        seen.add(body.id);
        out.push(body);
        if (out.length >= maxResults) break;
      }
    }
    return out;
  }

  // ---- dynamic-body integration -----------------------------------------

  integrate(dt: number): void {
    this.applyAreaForces(dt);
    this.applyWaterDrag(dt);
    PhaseTrace.mark("areas", this);
    for (const body of this.bodies) {
      if (body instanceof RigidBody2D && !body.removed) {
        // A sleeping body does not integrate: no gravity, no step, nothing to
        // undo. It is settled where it was left and the only thing that can
        // change that is being woken (see `VineLink.asleep`).
        if (World.isAsleep(body)) continue;
        if (body.pivot) {
          // A pivot body turns on a fixed bearing: no gravity, no translation.
          // The velocity is ZEROED rather than trusted to stay zero, because
          // the area passes above write `linearVelocity` directly (a current's
          // dv, water's flow lerp) and inverse mass being 0 does not cover a
          // direct write - cancelled here, before the position step, none of
          // it ever moves the axle or leaks into `velocityAtPoint`.
          body.linearVelocity = Vec2.ZERO;
        } else {
          // A spring body is pulled back toward its anchor by a damped
          // harmonic oscillator per axis, folded into the same semi-implicit
          // Euler step gravity takes (see `RigidBody2D.spring`). Applied HERE,
          // in the gravity phase, rather than as an impulse: `auditImpulses`
          // snapshots velocities around `solveContacts` only, so a force
          // applied outside that window needs no pair bookkeeping, exactly
          // like gravity itself.
          let accel = GRAVITY.mul(body.gravityScale);
          if (body.spring) accel = accel.add(springAcceleration(body, body.spring));
          body.linearVelocity = body.linearVelocity.add(accel.mul(dt));
          if (body.continuous) this.integrateContinuous(body, dt);
          else body.globalPosition = body.globalPosition.add(body.linearVelocity.mul(dt));
          // A locked axis (frequency 0) is pinned to the anchor rather than
          // sprung to it: the useful degenerate case is a leaf that only bobs
          // vertically. Snapped after the step and idempotent, so nothing the
          // frame did - a contact, a current, the rope - can walk it off.
          if (body.spring) {
            const s = body.spring;
            if (s.omegaX === 0) {
              body.globalPosition = new Vec2(s.anchor.x, body.globalPosition.y);
              body.linearVelocity = new Vec2(0, body.linearVelocity.y);
            }
            if (s.omegaY === 0) {
              body.globalPosition = new Vec2(body.globalPosition.x, s.anchor.y);
              body.linearVelocity = new Vec2(body.linearVelocity.x, 0);
            }
          }
        }
        // A spring body does not spin (see `RigidBody2D.inverseInertia`). The
        // velocity is ZEROED rather than trusted to stay zero, with the same
        // justification as the pivot's linear zero above: an inverse inertia of
        // 0 does not cover a direct write, and water's angular drag is one.
        if (body.spring) body.angularVelocity = 0;
        body.globalRotation += body.angularVelocity * dt;
      }
    }
    PhaseTrace.mark("gravity", this);
    this.resolveDynamicCollisions(dt);
    this.notifyAreas();
  }

  // The continuous position step (see RigidBody2D.continuous): advance the
  // body along its velocity, stopping at the earliest swept contact any of its
  // circle shapes makes with static geometry, then slide the remainder of the
  // step along that surface. Velocity is deliberately untouched - the body ends
  // the step seated a skin's clearance off the surface, inside the solver's
  // speculative band, and the contact solve then kills the approach velocity
  // exactly as it does for a discrete step that stopped short. What changes is
  // only what cannot happen: no step, however fast, ever carries the body
  // across a surface, so the per-piece answers everything downstream gives
  // (contacts, depenetration, the chain's push-out accounting) are always asked
  // from the outside of the body, where they are correct.
  //
  // Statics only, matching the hazard: a static compound's internal seams are
  // where a tunnelled body gets trapped (session-1085f), and rigid neighbours
  // are neither large enough to tunnel through nor safe to sweep one-sidedly -
  // both ends of a rigid pair move, and a swept stop against last frame's pose
  // would be a contact the pair solver never agreed to.
  //
  // The slide is what keeps a grazing step a graze: dropping the remainder
  // instead would stop a hook skimming a floor dead in its tracks, where today
  // the solver converts the approach into a slide along the face. Up to three
  // contacts are taken per step (a wedge is two, three is a dead end), and any
  // motion still left after that is dropped - dropped motion cannot penetrate.
  private integrateContinuous(body: RigidBody2D, dt: number): void {
    let remaining = body.linearVelocity.mul(dt);
    for (let pass = 0; pass < 3; pass++) {
      if (remaining.x === 0 && remaining.y === 0) return;
      let best: { t: number; normal: Vec2 } | null = null;
      // The primary shape only. A mounted shape (the ball's rim loop) turns
      // kinematically, so a translation-only sweep would test it at a stale
      // offset - and its contacts carry their own mechanic (the loop cap),
      // which a swept stop would pre-empt phase-dependently (`cli contacts`
      // loop-cap). With the primary stopped a skin off the surface, a mounted
      // shape can reach past it only by its own small protrusion, which is the
      // shallow-overlap regime the discrete solve and depenetration already
      // handle correctly.
      {
        const bs = body.primaryShape();
        if (bs.shape.kind !== "circle") {
          body.globalPosition = body.globalPosition.add(remaining);
          return;
        }
        const start = bs.globalPosition;
        const r = bs.shape.radius;
        const reach = r + remaining.length() + CONTACT_SLOP;
        const cands = this.queryShapes(
          start.x - reach,
          start.y - reach,
          start.x + reach,
          start.y + reach,
        );
        for (const ts of cands) {
          const target = ts.owner;
          if (target === body || target.removed) continue;
          if (!(target instanceof StaticBody2D)) continue;
          // A `passable` static is scenery the hook catches and nothing stops
          // against, so the swept step flies through it exactly as the discrete
          // one does. Missing here is the one way a body could still be halted
          // by geometry no other path admits exists.
          if (!target.isSolid) continue;
          if (body.exceptions.has(target.id)) continue;
          {
            // The same conservative box reject the contact gather uses, widened
            // by the step: anything further than the whole motion plus the
            // radius cannot be swept into.
            const oe = ts.extents();
            if (Math.abs(start.x - ts.globalPosition.x) > oe.x + reach) continue;
            if (Math.abs(start.y - ts.globalPosition.y) > oe.y + reach) continue;
            const hit = sweepCircle(start, remaining, r, ts);
            if (!hit || hit.t > 1) continue;
            // The same phantom-contact guards as the character sweep
            // (moveAndCollide): a real contact opposes the motion, and its
            // normal agrees with the side of the shape the sweep starts on -
            // without them a shape the body is already touching answers with
            // its far face and the "contact" points inward.
            if (hit.normal.dot(remaining) > 1e-9) continue;
            if (hit.normal.dot(outwardDirection(start, ts)) < -1e-6) continue;
            if (!best || hit.t < best.t) best = hit;
          }
        }
      }
      if (!best) {
        body.globalPosition = body.globalPosition.add(remaining);
        return;
      }
      // Stop exactly at contact - touching, depth zero - and slide what is
      // left of the step along the face: the tangential remainder is the
      // motion the discrete step's contact solve would have allowed. NOT
      // backed off by the skin the character sweep uses: this runs every
      // frame a body rests on a surface (a resting sweep hits at t=0), and a
      // skin's worth of outward seat re-applied every frame is a pump - the
      // ball settling in a basin was held hovering and jittering at 8 cm/s by
      // it, never quiet enough for stiction to pin. At depth zero the contact
      // gather still sees the pair well inside its speculative band, and any
      // float-noise overlap is the depenetration sweep's ordinary work.
      body.globalPosition = body.globalPosition.add(remaining.mul(best.t));
      const rem = remaining.mul(1 - best.t);
      remaining = rem.sub(best.normal.mul(Math.min(0, rem.dot(best.normal))));
    }
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
      const ashapes = area.getShapes();
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (!areaOverlapsBody(ashapes, body)) continue;
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

  // Water areas: a drag toward the current, and how deep each body is in it.
  //
  // Runs beside the force areas and before gravity, so a body entering water is
  // already carried on its first frame inside and its fall is already resisted
  // on the step it enters. Velocity ONLY, never position: the ball's chain phase
  // turns the position it realises into velocity (`BallLevel.physicsProcess`),
  // so a positional nudge here would be laundered into speed the body was never
  // given - the mechanism behind several of the chain launches in CLAUDE.md.
  //
  // A level with no water areas returns before touching a single body, which is
  // what keeps every recorded replay bit-identical: `submerged` stays 0, and
  // `surfaceFriction` therefore answers exactly the number the level authored.
  private applyWaterDrag(dt: number): void {
    let any = false;
    for (const area of this.areas) {
      if (area instanceof WaterArea && !area.removed && area.hasShape() && area.drag > 0) {
        any = true;
        break;
      }
    }
    if (!any) return;

    // Submersion is re-derived every frame rather than accumulated, so a body
    // that leaves the water is dry on the next one with nothing to remember.
    for (const body of this.bodies) body.submerged = 0;

    for (const area of this.areas) {
      if (!(area instanceof WaterArea) || area.removed || !area.hasShape()) continue;
      if (area.drag <= 0) continue;
      const ashapes = area.getShapes();
      const flow = area.flowVelocity;
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (!(body instanceof RigidBody2D) && !(body instanceof CharacterBody2D)) continue;
        // The exact overlap test decides whether the body is in the water at
        // all - the same one the force areas and the killzone use, and for the
        // reason written over `shapesOverlap`: a bounding-circle answer makes a
        // long thin area vastly bigger than it is drawn. The boxes below only
        // ever say HOW MUCH, and only for a body the exact test has already
        // placed inside.
        if (!areaOverlapsBody(ashapes, body)) continue;
        const frac = submergedFraction(body, ashapes);
        if (frac <= 0) continue;
        body.submerged = Math.max(body.submerged, frac);

        // The implicit step: v ← (v + k·dt·flow) / (1 + k·dt). `keep` is the
        // share of the body's own velocity that survives, and 1 − keep the
        // share of the current it has taken on, so the two always sum to one
        // and the body can neither overshoot the current nor be reversed by a
        // single step however large `drag` is.
        const keep = 1 / (1 + area.drag * frac * dt);
        if (body instanceof RigidBody2D) {
          body.linearVelocity = body.linearVelocity.mul(keep).add(flow.mul(1 - keep));
          // Spin is damped by the same water, at a lower rate: a body tumbling
          // under water is stopped by it, and the ratio is what keeps that
          // slower than being carried off. A kinematically steered body is
          // excluded, because its spin is a control input with no force behind
          // it - the aim steering overwrites `angularVelocity` outright, so
          // damping it here would be a number written and immediately lost.
          if (!body.kinematicRotation) {
            body.angularVelocity *= 1 / (1 + area.drag * frac * WATER_ANGULAR_DRAG * dt);
          }
        } else {
          // The character's state machine reads this next frame; its grounded
          // basis discards the into-surface component, so water pushes it along
          // a floor rather than through it (as a force area does).
          body.velocity = body.velocity.mul(keep).add(flow.mul(1 - keep));
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
  //
  // `accept` narrows what counts as solid for this caller. The default - every
  // solid body in the scene - is what a caller pushing out the one body its
  // constraint moves wants. A caller whose constrained body is itself something
  // other bodies rest ON does not: pushing it out of a neighbour is one side of
  // a pair being resolved by whoever asked, which is the race `integrate`'s
  // scene-wide sweep exists to avoid, and the constraint's own body is not the
  // side that must yield (see `settleChainBodies`).
  depenetrateRigid(
    body: RigidBody2D,
    iterations = 2,
    accept: ((other: PhysicsBody2D) => boolean) | null = null,
  ): Vec2[] {
    const pushedOutOf: Vec2[] = [];
    if (body.removed || !body.hasShape()) return pushedOutOf;
    // A sleeping body was pushed clear before it went to sleep and nothing has
    // moved since (see `VineLink.asleep`).
    if (World.isAsleep(body)) return pushedOutOf;
    // A pivot body cannot be translated off its bearing, by this sweep or by
    // anything else - an overlap it is in is the contact solver's to resolve in
    // rotation. Reporting no pushes is also the honest answer for the callers
    // that read them (the chain phase's blocked-length lease): the geometry did
    // not move this body, so nothing was refused in translation.
    if (body.pivot) return pushedOutOf;
    for (let pass = 0; pass < iterations; pass++) {
      const [a, b] = this.gatherDepenetration(body, accept);
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
    accept: ((other: PhysicsBody2D) => boolean) | null = null,
  ): [{ normal: Vec2; depth: number } | null, { normal: Vec2; depth: number } | null] {
    let a: { normal: Vec2; depth: number } | null = null;
    let b: { normal: Vec2; depth: number } | null = null;
    // A `passable` body is blocked by nothing, statics included - the one place
    // it goes further than `isSolid`, which keeps a vine link resting on the
    // ground it drapes across. Answering with no overlaps is what stops the
    // scenery a leaf hangs in front of shoving the leaf out of itself.
    if (body.passable) return [null, null];
    const consider = (ov: { normal: Vec2; depth: number }): void => {
      if (!a || ov.depth > a.depth) {
        b = a;
        a = ov;
      } else if (!b || ov.depth > b.depth) {
        b = ov;
      }
    };
    for (const bshape of body.getShapes()) {
      const be = bshape.extents();
      const bc = bshape.globalPosition;
      // Broadphase: this shape's own tight box is the query - an overlap needs
      // the tight boxes to meet, so no margin is required for the candidate
      // set to be complete (the tree's fat boxes only widen it).
      const cands = this.queryShapes(bc.x - be.x, bc.y - be.y, bc.x + be.x, bc.y + be.y);
      for (const oshape of cands) {
        const other = oshape.owner;
        if (!(other instanceof PhysicsBody2D)) continue;
        if (other === body || other.removed) continue;
        if (body.exceptions.has(other.id)) continue;
        if (!isSolidTarget(other)) continue;
        // No body is ever depenetrated out of a vine link (see `VineLink`): a
        // non-solid body blocks nothing, and being pushed out of one is exactly
        // being blocked by it.
        if (!other.isSolid) continue;
        // And the other half of the same rule: a non-solid body is blocked only
        // by STATICS, so a vine link is pushed out of the scenery it drapes over
        // and out of nothing else. Without this the pair is decoupled in one
        // direction only - the ball sails through the vine, and the recovery
        // sweep then shoves the vine out of the ball, so a vine the ball is
        // supposed to pass through whips a metre out of its way as it goes.
        if (!body.isSolid && !(other instanceof StaticBody2D)) continue;
        if (accept && !accept(other)) continue;
        {
          // The same conservative box reject as before the broadphase - kept
          // because the tree answers on FAT boxes, and this exact test on the
          // tight ones is what keeps the accepted set identical to the full
          // scan's. Nothing here is speculative - an overlap has positive
          // depth by definition - so shapes whose boxes are strictly apart
          // cannot contribute.
          const oe = oshape.extents();
          if (Math.abs(bc.x - oshape.globalPosition.x) > be.x + oe.x) continue;
          if (Math.abs(bc.y - oshape.globalPosition.y) > be.y + oe.y) continue;
          if (bshape.shape.kind === "circle") {
            const ov = circleOverlap(bc, bshape.shape.radius, oshape);
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
  // The constraints the last `integrate` solved. Read-only to everything but the
  // solver; a caller that wants to know what a body touched this frame asks here
  // rather than re-deriving contacts it would then have to keep in step.
  frameContacts: ContactConstraint[] = [];

  // The frame's worst overspend against the kinematic-spin drive cap (N·s), and
  // which contact spent it. 0 while the cap in `solveTangent` holds; the
  // `spin-overdrive` invariant reads it so a future path that spends spin-funded
  // impulse outside the cap is caught rather than felt (`session-773f`).
  spinDriveOverspend = 0;
  spinDriveDetail: string | null = null;

  // Each body pair's SUSTAINED load (N·s), keyed `aId:bId`, with how many
  // consecutive frames the pair has currently been absent. The load a spin may
  // buy traction from: it climbs by at most `rampBite` per carried frame and
  // follows the pair's actual normal impulse down instantly, so a load
  // qualifies by PERSISTING - gravity on a floor, a crate's weight, any press
  // renewed frame after frame - while an impact's Pn is many frames of load in
  // one and decays before the ramp can chase it. Direction-blind on purpose,
  // and per pair with a short absence grace, because a held press is not a
  // held constraint SET: a compound body's touching shape rotates and the set
  // flickers while the press persists. A ball grinding on a wall reads ~0 here
  // for ever - between its own micro-bounces nothing presses it in - which is
  // what stopped maturity-by-contact-age treating the grind as a load and
  // funding a 78 cm wall climb out of it (`session-422f-wall` f373).
  private pairLoad = new Map<string, { s: number; missing: number }>();

  collectContacts(): ContactConstraint[] {
    const out: ContactConstraint[] = [];
    // Broadphase pair discovery. Every pair that can produce a constraint has
    // a rigid side that survives every rigid-side filter below (role `a` is
    // by definition rigid, awake, not passable and a solid target), so
    // querying the tree from exactly those bodies finds every such pair.
    // Both-rigid pairs are found twice and deduped on the canonical
    // (lower, higher) world-index key; the keys are then SORTED, which
    // re-establishes the exact (i, j) lexicographic order the O(n²) loop
    // emitted constraints in - the solve order is part of the replay contract.
    this.syncBroadphase();
    const pairKeys = new Set<number>();
    for (const a of this.bodies) {
      if (!(a instanceof RigidBody2D)) continue;
      if (a.removed || !a.hasShape() || !isSolidTarget(a)) continue;
      if (a.passable) continue;
      if (World.isAsleep(a)) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of a.getShapes()) {
        const c = s.globalPosition;
        const e = s.extents();
        minX = Math.min(minX, c.x - e.x);
        minY = Math.min(minY, c.y - e.y);
        maxX = Math.max(maxX, c.x + e.x);
        maxY = Math.max(maxY, c.y + e.y);
      }
      // The narrowphase gathers speculative contacts down to -CONTACT_SLOP
      // depth, so the query box carries the same slop the box test below does.
      const cands: CollisionShape2D[] = [];
      this.broadphase.query(
        minX - CONTACT_SLOP,
        minY - CONTACT_SLOP,
        maxX + CONTACT_SLOP,
        maxY + CONTACT_SLOP,
        cands,
      );
      for (const s of cands) {
        const t = s.owner;
        if (t === a || !(t instanceof PhysicsBody2D) || t.removed) continue;
        const lo = Math.min(a.worldIndex, t.worldIndex);
        const hi = Math.max(a.worldIndex, t.worldIndex);
        pairKeys.add(lo * 0x100000 + hi);
      }
    }
    const orderedKeys = Array.from(pairKeys).sort((x, y) => x - y);
    for (const key of orderedKeys) {
      const bi = this.bodies[Math.floor(key / 0x100000)]!;
      const bj = this.bodies[key % 0x100000]!;
      this.collectPairContacts(bi, bj, out);
    }
    return out;
  }

  // One (i, j) body pair of the contact gather, `bi` earlier in `bodies` than
  // `bj` - the filters and shape loops of the old O(n²) loop, verbatim.
  private collectPairContacts(
    bi: PhysicsBody2D,
    bj: PhysicsBody2D,
    out: ContactConstraint[],
  ): void {
    {
      {
        if (bi.removed || !bi.hasShape() || !isSolidTarget(bi)) return;
        if (bj.removed || !bj.hasShape() || !isSolidTarget(bj)) return;
        if (bi.exceptions.has(bj.id)) return;
        const iLeads =
          bi instanceof RigidBody2D && (!(bj instanceof RigidBody2D) || bi.id < bj.id);
        const a = iLeads ? bi : bj;
        const b = iLeads ? bj : bi;
        // Neither side can move: two statics touching is not a contact.
        if (!(a instanceof RigidBody2D)) return;
        // A non-solid body blocks nothing and is blocked only by statics (see
        // `VineLink`). The obstacle side going non-solid drops the pair
        // outright; the moving side going non-solid keeps only its contacts
        // against static geometry. Concretely, for a vine: link-vs-static
        // exists - that is how a vine drapes over a ledge and pools on a floor -
        // and link-vs-link, link-vs-ball, link-vs-any-rigid do not, so a vine
        // never pushes anything, never stacks, and never fights its own pair
        // constraints through the contact solver.
        if (!b.isSolid) return;
        if (!a.isSolid && !(b instanceof StaticBody2D)) return;
        // ...and a `passable` body keeps not even those: the hook is the only
        // thing in the sim that may find it, so it neither pushes a static nor
        // is stopped by one (see `CollisionObject2D.passable`).
        if (a.passable) return;
        // A sleeping body has no contacts. It is not moving and nothing that
        // could move it reaches this loop, and the pair loop is the O(n²) half
        // of the frame - which is what a level full of vines pays (see
        // `VineLink.asleep`).
        if (World.isAsleep(a)) return;
        const as = a.getShapes();
        const bs = b.getShapes();
        for (let si = 0; si < as.length; si++) {
          const sa = as[si]!;
          const ea = sa.extents();
          for (let sj = 0; sj < bs.length; sj++) {
            const sb = bs[sj]!;
            // The pair loop is O(n²) with no broadphase, and at this scene scale
            // that is the right trade (see "Known simplifications") - but only
            // the LOOP is cheap. What it costs is `gatherShapePair`, a full SAT
            // and incident-face clip per shape pair, run on the ball arena 743
            // times a frame for the 1 pair that is actually within reach.
            //
            // So the box test, which is exactly conservative rather than
            // approximately so: `gatherShapePair` drops anything at
            // `depth <= -CONTACT_SLOP`, and boxes separated on an axis by more
            // than the slop put the shapes further than the slop apart on that
            // axis alone. Every pair skipped here is a pair the narrowphase
            // would have gathered nothing from, so the contact set is identical
            // and every recorded replay stays bit-for-bit - which is the whole
            // reason to reject on the shapes' own boxes rather than to build a
            // grid whose bucket size would be a new number to be wrong about.
            //
            // On session-1618f it takes 99.9% of the narrowphase calls out and
            // `World.integrate` from 1.475 ms a frame to 0.087.
            const eb = sb.extents();
            const dx = sa.globalPosition.x - sb.globalPosition.x;
            if (Math.abs(dx) > ea.x + eb.x + CONTACT_SLOP) continue;
            const dy = sa.globalPosition.y - sb.globalPosition.y;
            if (Math.abs(dy) > ea.y + eb.y + CONTACT_SLOP) continue;
            this.gatherShapePair(out, a, si, sa, b, sj, sb);
          }
        }
      }
    }
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
        limited: false,
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
    this.spinDriveOverspend = 0;
    this.spinDriveDetail = null;
    const prevLoads = this.pairLoad;
    if (constraints.length === 0) {
      // No contacts at all: every pair is absent, so its grace elapses here.
      const kept = new Map<string, { s: number; missing: number }>();
      for (const [key, e] of prevLoads) {
        if (e.missing < PAIR_LOAD_GRACE) kept.set(key, { s: e.s, missing: e.missing + 1 });
      }
      this.pairLoad = kept;
      return;
    }
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

      // The tangential slip a KINEMATIC spin contributes at this point, and the
      // sustained load that spin is allowed to buy traction from. Constant
      // across the iterations: a kinematic body's spin has invI = 0, so nothing
      // the solve applies can change it. The press is the spinning body's OWN
      // gravity component into the surface - not the pair's relative gravity,
      // which is zero for two falling bodies and would starve the drive on a
      // rigid platform (`ball-roll-drive-rigid`).
      let spinSlip = 0;
      if (c.a.kinematicRotation) spinSlip += c.a.angularVelocity * rA.cross(tangent);
      if (bRigid && bRigid.kinematicRotation) spinSlip -= bRigid.angularVelocity * rB.cross(tangent);
      // The ramp guards the FREE spinning body only: anchored, the chain
      // machinery owns this regime and contact traction stays exactly legacy.
      const tethered =
        (c.a.kinematicRotation && c.a.constraintTethered) ||
        (bRigid !== null && bRigid.kinematicRotation && bRigid.constraintTethered);
      // The press is computed for every contact, not only spun ones, so the
      // sustained-load ramp below is already warm when the player starts
      // aiming mid-rest.
      const press =
        Math.max(0, -GRAVITY.dot(c.normal)) * c.a.gravityScale +
        (bRigid ? Math.max(0, GRAVITY.dot(c.normal)) * bRigid.gravityScale : 0);
      // Impulse in the spin's drive direction that the LINEAR half of the slip
      // justifies on its own, from the entering velocities. Usually zero - a
      // rolling ball's linear slide wants braking, the opposite direction - but
      // when a ball slides and spins the same way the real momentum may still be
      // braked in full.
      let linearNeed = 0;
      if (spinSlip !== 0 && invEffT > 1e-9) {
        const vt0 = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(tangent);
        const driveSign = spinSlip > 0 ? -1 : 1;
        linearNeed = Math.max(0, (driveSign * -(vt0 - spinSlip)) / invEffT);
      }

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
        spinNormal: spinFabricatedNormal(c, bRigid, rA, rB, restitution, invEffN),
        spinSlip,
        spinCone: (press * dt) / invEffN,
        linearNeed,
        rampBite:
          (GRAVITY.length() *
            Math.max(c.a.gravityScale, bRigid ? bRigid.gravityScale : 0) *
            dt) /
          invEffN,
        sustained: prevLoads.get(`${c.a.id}:${c.b.id}`)?.s ?? 0,
        tethered,
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

    // The pairs' sustained loads for next frame: ramp-limited on the way up,
    // the pair's own (largest-contact) normal impulse on the way down, grace
    // for pairs the set dropped this frame.
    const loads = new Map<string, { s: number; missing: number }>();
    for (const s of solved) {
      const pairKey = `${s.c.a.id}:${s.c.b.id}`;
      const held = loads.get(pairKey);
      const ceiling = Math.min(s.c.normalImpulse, s.sustained + s.rampBite);
      if (!held || ceiling > held.s) loads.set(pairKey, { s: ceiling, missing: 0 });
    }
    for (const [key, e] of prevLoads) {
      if (!loads.has(key) && e.missing < PAIR_LOAD_GRACE) {
        loads.set(key, { s: e.s, missing: e.missing + 1 });
      }
    }
    this.pairLoad = loads;

    for (const s of solved) {
      this.contactCache.set(s.key, { n: s.c.normalImpulse, t: s.c.tangentImpulse });
      // The rule the drive cap in `solveTangent` enforces, measured on what was
      // actually APPLIED: tangential impulse in a kinematic spin's drive
      // direction beyond what the sustained load and the linear slip fund is a
      // drive with no force behind it. Zero by construction while the cap
      // holds; recorded so `spin-overdrive` catches any path that spends
      // outside it again (the shape of `session-773f`'s wall launch).
      if (s.spinSlip !== 0 && !s.tethered) {
        const driveSign = s.spinSlip > 0 ? -1 : 1;
        const applied = Math.max(0, driveSign * s.c.tangentImpulse);
        const funded =
          s.friction *
            Math.max(0, Math.max(s.spinCone, s.sustained) - s.spinNormal) +
          s.linearNeed;
        const over = applied - funded;
        if (over > this.spinDriveOverspend) {
          this.spinDriveOverspend = over;
          this.spinDriveDetail =
            `${s.c.a.name || s.c.a.constructor.name} vs ` +
            `${s.c.b.name || s.c.b.constructor.name}: spent ${applied.toFixed(1)} N·s against ` +
            `the spin's slip, funded ${funded.toFixed(1)}`;
        }
      }
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
      // A pivot body's linear momentum is not a state variable: its inverse
      // mass is 0, so an applied impulse moves it nothing and the difference is
      // the bearing's reaction, which nothing models. The ANGULAR half is the
      // half a pivot answers to and stays audited in full.
      if (!body.pivot && residual.length() > tolP) {
        // The residual, not the two totals: they agree to several digits by
        // construction and printing both hides the very thing being reported.
        ContactAudit.violations.push(
          `body#${body.buildIndex} ${body.name || body.constructor.name}: ` +
            `${residual.length().toExponential(3)} N·s of momentum change with no impulse behind ` +
            `it (applied |P|=${applied.p.length().toExponential(3)})`,
        );
      }
      // The mirror of the exemption above, for the other locked freedom: a
      // SPRING body's angular momentum is not a state variable (its inverse
      // inertia is 0), so an applied torque turns it nothing and the difference
      // is the stem's reaction, which nothing models. The LINEAR half is the
      // half a spring body answers to and stays audited in full - which is the
      // point, since being loadable through ordinary impulses is the whole
      // reason a spring body is a rigid body.
      if (!body.spring && Math.abs(dl - applied.l) > tolL) {
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
    // ...and it is scaled by the part of the normal impulse a real load put
    // there. A kinematic spin driving an off-centre shape into a surface is not
    // one, and what it fabricated buys nothing (see `spinFabricatedNormal`).
    const cone = s.friction * Math.max(0, c.normalImpulse - s.spinNormal);
    // ...and for an untethered kinematic spin, the cone in the spin's drive
    // direction is sized from the pair's SUSTAINED load, never from the whole
    // accumulated normal impulse. The spin is an infinite reservoir - the
    // solve cannot despin it (invI is 0), so friction fighting its slip
    // converts rim speed into centre velocity with the spin paying nothing.
    // Against a carried load that IS the rolling drive; against an impact's Pn
    // - many frames of load in one - it is energy from nothing: a ball rolling
    // into a wall at 3.9 m/s had its rim's slip stopped outright out of a 234
    // N·s impact impulse and left the floor at 4.4 m/s straight up, spin
    // intact (`session-773f` f600). What separates the two is persistence
    // (`World.pairLoad`): the sustained load never sits under the gravity
    // press (full on a floor, nothing on a wall or ceiling - the impact-frame
    // statement of "a spinning ball cannot climb a wall"), climbs by one frame
    // of weight per carried frame, and follows the pair's real load down
    // instantly - so a grind against a wall, where nothing presses between the
    // ball's own bounces, funds nothing however long it lasts
    // (`session-422f-wall`). The linear share of the slip is real momentum and
    // keeps the full cone via `linearNeed`; an anchored chain keeps the whole
    // regime legacy (see `constraintTethered`).
    let conePos = cone;
    let coneNeg = cone;
    if (s.spinSlip !== 0 && !s.tethered) {
      const driveCap = Math.min(
        cone,
        s.friction *
          Math.max(0, Math.max(s.spinCone, s.sustained) - s.spinNormal) +
          s.linearNeed,
      );
      if (s.spinSlip > 0) coneNeg = driveCap;
      else conePos = driveCap;
    }
    const capPos = conePos * s.brakePos;
    const capNeg = coneNeg * s.brakeNeg;
    const total = clamp(c.tangentImpulse - vt / s.invEffT, -capNeg, capPos);
    const delta = total - c.tangentImpulse;
    const sideCone = total >= 0 ? conePos : coneNeg;
    c.slipping = sideCone > 0 && Math.abs(total) >= sideCone - 1e-12;
    // Against the bound the clamp above actually used, faded cone included.
    c.limited = total >= capPos - 1e-12 || total <= -capNeg + 1e-12;
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

    // This frame's contact set, kept for callers that own a mechanic the solver
    // deliberately does not: `BallPlayer.applyLoopCap` needs to know that the
    // ball's mounting loop met a surface, and which way that surface faces.
    this.frameContacts = constraints;

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
    //
    // A pair is offered from BOTH sides, as `applyStaticGrip` offers its pin.
    // Which body leads a constraint is an id ordering and nothing more, and it
    // used to be enough to read `a` alone only because `b` was always a static -
    // one a static can never be. Against a rigid ramp built before the ball, the
    // ball IS `b`, so the whole routine looked straight past the only body it
    // exists for and the grip never ran at all.
    const grip = (
      body: RigidBody2D,
      other: PhysicsBody2D,
      normal: Vec2,
      point: Vec2,
    ): void => {
      if (!body.kinematicRotation) return;
      // A scripted mover carries the surface out from under the body by design,
      // so there is nothing to hold still against - the same exclusion
      // `applyStaticGrip` makes, and for the same reason. A rigid body is not
      // that: it is mobile in the classification sense while being exactly the
      // scenery a ball rests on, and the anchor is kept in the surface's own
      // frame (`setStickAnchor`), so it means the same thing against one as
      // against the world.
      //
      // This used to refuse every rigid surface outright, on the argument that
      // gripping is against the immovable, and it left the one body in the game
      // that is always steered with no pin at all against scenery: not
      // `applyStaticGrip`'s, which declines a `kinematicRotation` body because a
      // steered anchor has to advance by the roll, and not this one. So a
      // resting ball kept the whole of gravity's integration step every frame
      // and the recovery resolved it along the inclined normal - 0.68 mm of
      // sideways travel a frame, 84 cm down a 20 degree ramp in fifteen seconds,
      // at a reported velocity of zero, while the identical static ramp held it
      // to 0.1 cm (`steered-ramp-hold`).
      if (!(other instanceof RigidBody2D) && other.isMobile) {
        body.releaseStick();
        return;
      }
      // Under water there is nothing to grip with. The traction scaling on
      // `surfaceFriction` is not enough on its own here, because this grip is a
      // position pin rather than a force: its budget test below compares
      // gravity's tangential component against the cone, and on level ground
      // that is zero against anything positive, so it holds at any friction at
      // all. A ball sitting in a river would then be a ball the river cannot
      // move - the one place the player actually meets the water.
      if (body.submerged >= WATER_GRIP_RELEASE) {
        body.releaseStick();
        return;
      }

      const otherRigid = other instanceof RigidBody2D ? other : null;
      // The same combination the kinetic path and `applyStaticGrip` use: the
      // geometric mean of what each body brings, so two rigid bodies agree on one
      // coefficient however the pair is ordered.
      const staticMu = otherRigid
        ? Math.sqrt(
            body.staticFriction *
              other.surfaceFriction *
              otherRigid.staticFriction *
              body.surfaceFriction,
          )
        : body.staticFriction * other.surfaceFriction;
      const rContact = point.sub(body.globalPosition);
      const surfV = other.velocityAtPoint(point);
      const wCrossR = new Vec2(-body.angularVelocity * rContact.y, body.angularVelocity * rContact.x);
      const relV = body.linearVelocity.add(wCrossR).sub(surfV);
      const slipTan = relV.sub(normal.mul(relV.dot(normal)));
      const g = GRAVITY.mul(body.gravityScale);
      const gN = -g.dot(normal);
      const withinBudget =
        staticMu > 0 &&
        gN > 1e-6 &&
        g.sub(normal.mul(g.dot(normal))).length() <= staticMu * gN;
      if (slipTan.length() >= SLIP_STICK || !withinBudget) {
        // Slipping: release the grip and leave the solver's friction to it.
        body.releaseStick();
        return;
      }
      // Grip: drive the centre so the contact is stationary,
      // v_centre = surfaceVel - omega x r_contact.
      const desired = surfV.sub(wCrossR);
      const vnKeep = body.linearVelocity.dot(normal);
      const rollTan = desired.sub(normal.mul(desired.dot(normal)));
      body.linearVelocity = normal.mul(vnKeep).add(rollTan);
      // The same roll taken RELATIVE to the surface, which is what the anchor
      // below advances by. The velocity above wants the surface's own motion in
      // it - a ball riding a moving body moves with it - but the anchor is held
      // in that body's frame (`setStickAnchor`), so it is carried along already,
      // and adding `surfV` a second time counts it twice.
      //
      // Against a static this is the same vector (`surfV` is zero) and nothing
      // changes. Against a rigid one it is the whole bug: the surface's velocity
      // AT THIS POINT IN THE FRAME is gravity's own step, un-cancelled - the
      // engine integrates before it solves, and a body whose support is a chain
      // rather than a contact carries all 0.163 m/s of it for ever, since a PBD
      // length constraint corrects position and never that step. Read as surface
      // motion, a hanging platform that goes nowhere presented 54 mm/s of
      // downhill slip, the anchor chased it 0.9 mm a frame, and the ball rode it
      // 29 cm down a 14 degree slope in ten seconds while gripping every frame
      // and reporting a velocity of zero (`session-599f`).
      const rollRel = wCrossR.neg();
      const rollRelTan = rollRel.sub(normal.mul(rollRel.dot(normal)));
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
      // Continue the anchor only if the grip actually held LAST frame. The
      // anchor survives a few ungripped frames so a flickering grip does not
      // re-seed itself downhill every eighth frame (`STICK_RELEASE_FRAMES`), and
      // for a crate holding a slope that is right: it drifts sub-millimetre
      // while the grip is off. A steered ball does not drift, it ROLLS - metres
      // per second - and the anchor stands still while it does, so resuming onto
      // the held anchor yanks the whole lapse out in one frame. Five ungripped
      // frames at 2.4 m/s put the anchor 21.7 cm behind the ball, and the grip
      // dragged it back there with no velocity change to show for it: a visible
      // teleport, backwards, against its own motion (`session-497f` f376).
      //
      // Re-seeding costs nothing here, because this anchor is not holding a
      // position - it advances by the intended roll every frame and exists only
      // to remove the ONE frame of gravity creep integration slid in underneath
      // it. Losing that for the frame a grip resumes on is a fraction of a
      // millimetre.
      const continuous = body.stickBody === other && body.ungrippedFrames === 0;
      const held = continuous ? body.stickAnchorWorld() : null;
      body.setStickAnchor(
        other,
        held === null ? body.globalPosition : held.add(rollRelTan.mul(dt)),
      );
      const d = body.globalPosition.sub(body.stickAnchorWorld()!);
      body.globalPosition = body.globalPosition.sub(d.sub(normal.mul(d.dot(normal))));
      stuck.add(body.id);
    };

    for (let i = 0; i < constraints.length; ) {
      const head = constraints[i]!;
      let deepest = head;
      let normalImpulse = 0;
      let j = i;
      while (j < constraints.length) {
        const c = constraints[j]!;
        if (c.a !== head.a || c.b !== head.b) break;
        if (c.depth > deepest.depth) deepest = c;
        normalImpulse += c.normalImpulse;
        j++;
      }
      i = j;
      // Resting is what the contact CARRIED, not how deep it is. Depth is the
      // test everywhere else here, and against another dynamic body it cannot be
      // used: the solve pushes a resting interface to exactly zero overlap and
      // the pair then falls by the same gravity step, so the depth sits on 0 and
      // its sign is float noise - the very thing `CONTACT_SLOP` and speculative
      // contacts exist for (see "Resting contacts"). Read as depth, the grip
      // dropped on every other frame, and since the anchor re-seeds wherever the
      // ball is when a lapsed grip resumes, each lapse kept the creep it was
      // there to remove: still 78 cm down a 20 degree ramp with the grip
      // nominally holding. A contact that pushed back is carrying load, which is
      // the same statement `mu * Pn` makes about how much grip there is to have.
      if (normalImpulse <= 0) continue;
      grip(head.a, head.b, deepest.normal, deepest.point);
      // The same contact seen from the other body: its surface normal is the one
      // pointing back at it.
      if (head.b instanceof RigidBody2D) {
        grip(head.b, head.a, deepest.normal.neg(), deepest.point);
      }
    }
    return stuck;
  }

  private notifyAreas(): void {
    for (const area of this.areas) {
      if (area.removed || !area.hasShape()) continue;
      const inside: CollisionObject2D[] = [];
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (areaOverlapsBody(area.getShapes(), body)) inside.push(body);
      }
      area.notifyOverlaps(inside);
    }
  }
}

// The spring body's restoring acceleration (see `RigidBody2D.spring`): a damped
// harmonic oscillator per axis about the anchor,
//
//   a = -w^2 * offset - 2*zeta*w * velocity
//
// written per axis so each has its own frequency and each damping term uses its
// own axis's w. Mass does not appear: the stiffness is `k = m*w^2` by
// construction, so the free oscillation and the SELF-WEIGHT droop `g/w^2` are
// the same whatever the body is made of, while an external load `F` still adds
// `F/(m*w^2)` - a heavy stiff plant barely notices the player and a light whippy
// one plunges, which is the authorable half.
//
// Semi-implicit Euler is stable here for `w*dt < 2`, i.e. under ~19 Hz at the
// fixed 1/60 step; authored frequencies are clamped to 8 Hz well inside that.
function springAcceleration(
  body: RigidBody2D,
  s: { anchor: Vec2; omegaX: number; omegaY: number; zeta: number },
): Vec2 {
  const d = body.globalPosition.sub(s.anchor);
  const v = body.linearVelocity;
  return new Vec2(
    -s.omegaX * s.omegaX * d.x - 2 * s.zeta * s.omegaX * v.x,
    -s.omegaY * s.omegaY * d.y - 2 * s.zeta * s.omegaY * v.y,
  );
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

// How much of a contact's normal impulse a KINEMATICALLY DRIVEN spin put there.
//
// A driven spin is an infinite reservoir - `kinematicRotation` means the ball's
// aim steering overwrites `angularVelocity` every frame, so no impulse can be
// taken back out of it - and the friction cone above is written on the
// understanding that the normal impulse it is scaled by is a real load: a
// weight, an impact, a constraint pressing two bodies together. Everything a
// contact drives with is bought from that.
//
// A shape mounted at the body's own centre cannot break it. Its contact point
// lies along the normal, so `omega x r` there is purely tangential: the spin
// reaches the surface as SLIP and nothing else, which is the conveyor belt that
// IS the rolling mechanic, Coulomb-capped by the ball's own weight.
//
// A shape mounted OFF the centre is a different object. The ball's loop is a
// second circle on the rim, so its contact point carries a NORMAL component of
// `omega x r` and spinning drives it into whatever it is against. That
// fabricates a normal impulse out of nothing, the cone is sized from it, and the
// friction it buys is a drive with no force behind it. A ball resting in a
// corner scrubbed its loop against the wall and climbed it: +2.1 m/s upward per
// touch, out of a 135 N.s normal impulse the ball's own motion contributed
// nothing to, ratcheting 90 cm up a flat wall in 35 frames (`session-200f`).
// With no traction under it at all it goes 7.4 m up (`loop-wall`).
//
// So the fabricated share is measured and taken off the cone: what the spin
// pressed the surface with is not something the surface may press back with.
// That is the same statement `BallPlayer.applyLoopCap` makes about the outgoing
// NORMAL velocity of a loop landing, made about the tangential half - and, as
// there, it is the spin's own contribution and not a fraction of the answer.
// Sizing it as the impulse that kills the spin's approach and pays its bounce -
// `(1 + restitution) * approach / invEffN` - is exactly what the normal solve
// does with an approach, so a contact keeps the whole of the cone its own linear
// approach earned and only the surplus goes.
//
// What must NOT go with it is the slip: removing the spin from the tangential
// velocity as well is the tempting second half and it is wrong, because a loop
// bearing down on the FLOOR is bearing the ball's weight, and there the drive is
// the mechanic doing its job. Taken out, a rolling ball loses a fifth of its
// travel (`ball-roll-drive`, 2.4 m against 4.9) and a ground wind-up stops
// paying its chain in (`ball-ground-wind-up`). The load is what was fabricated;
// the slip was always real.
//
// The gate is the MOUNT and not the arithmetic: for a centred shape the term is
// identically zero, and asking the shape where it is mounted keeps it exactly
// zero in floats rather than nearly so - which is what leaves every recorded
// replay of a ball rolling on its own rim untouched, bit for bit.
function spinFabricatedNormal(
  c: ContactConstraint,
  bRigid: RigidBody2D | null,
  rA: Vec2,
  rB: Vec2,
  restitution: number,
  invEffN: number,
): number {
  let vn = 0;
  if (spinsOffCentre(c.a, c.shapeA)) vn += c.a.angularVelocity * rA.cross(c.normal);
  if (bRigid && spinsOffCentre(bRigid, c.shapeB)) vn -= bRigid.angularVelocity * rB.cross(c.normal);
  // Only a spin pressing INTO the surface fabricates anything; one lifting the
  // shape away has already cost the contact its impulse rather than bought it.
  const approach = Math.max(0, -vn);
  if (approach === 0) return 0;
  return (approach * (1 + restitution)) / invEffN;
}

// Is this contact on a shape whose spin can press it into a surface without
// anything paying for the spin?
function spinsOffCentre(body: RigidBody2D, shapeIndex: number): boolean {
  if (!body.kinematicRotation) return false;
  const shape = body.getShapes()[shapeIndex];
  return shape !== undefined && shape.localOffset.lengthSquared() > 0;
}

// Symmetric overlap test between two shape transforms.
//
// The vertex-vs-vertex case is the separating-axis test, not a bounding-circle
// approximation of it. It used to be the latter - `a`'s bounding circle against
// `b`, with a comment promising a refinement that was never written and a
// justification ("the area queries always involve a circle in practice") that
// held only while every body an area could reach was the round avatar.
//
// A bounding circle is a broadphase, and using one as the answer makes a long
// thin area enormously bigger than it is drawn: `shapeRadius` of a rect is its
// half-DIAGONAL, so the 31.5 x 0.7 m river current across the bottom of the ball
// arena reached as a disc of radius 15.75 m centred on it. Everything rectangular
// in most of the level was inside that disc, and force areas apply their
// acceleration to whatever they overlap - so a plank hung on scene chains 5.6 m
// ABOVE the water was blown sideways at a steady 3 m/s², every frame, and swung a
// metre off its anchors while the level read as a perfectly symmetrical pendulum.
// The circle avatar took the exact branch above and behaved, which is what kept
// it looking like a chain bug rather than an area one.
//
// `killzone` runs through the same test (`notifyAreas`), where the same slop
// would reset the level from outside the volume.
// How much of a spinning body's spin the water takes, as a fraction of what it
// takes of its travel. Lower, because a body is carried off by a current long
// before it is stopped from tumbling in it.
const WATER_ANGULAR_DRAG = 0.5;

// How much of `body` is inside `area`, 0..1 - the fraction of the body's
// bounding box the area's bounding box covers, taken at the piece that is
// deepest in.
//
// Boxes rather than the exact intersection ON PURPOSE, and the two questions are
// kept apart: whether a body is in the water at all is decided by the exact
// overlap test (see `shapesOverlap`, and the arena-wide current that a bounding
// answer once produced), and this only says how much of a body already known to
// be inside it is under. What it buys is the surface: a ball dipping into the
// channel is dragged by the part of it that is wet and not by all of it, so it
// slows as it enters instead of stopping the instant it touches.
function submergedFraction(body: PhysicsBody2D, area: readonly ShapeTransform[]): number {
  let best = 0;
  for (const a of area) {
    const ac = a.globalPosition;
    const ae = shapeExtents(a);
    for (const s of body.getShapes()) {
      const bc = s.globalPosition;
      const be = shapeExtents(s);
      if (be.x <= 0 || be.y <= 0) continue;
      const ox = Math.min(bc.x + be.x, ac.x + ae.x) - Math.max(bc.x - be.x, ac.x - ae.x);
      const oy = Math.min(bc.y + be.y, ac.y + ae.y) - Math.max(bc.y - be.y, ac.y - ae.y);
      if (ox <= 0 || oy <= 0) continue;
      const f = Math.min(1, ox / (2 * be.x)) * Math.min(1, oy / (2 * be.y));
      if (f > best) best = f;
    }
  }
  return best;
}

// Does any shape of the area touch any shape of the body? Areas iterate their
// shapes like everything else in this engine, which they did not use to: an area
// was single-shape by construction while the only way to compound one was to
// group it, and grouping an area was refused outright. A concave authored
// outline is cut into convex pieces at load (`makeShapes`), so an area is a
// several-shape body now whenever its author drew a notch in it, and testing the
// first piece alone would leave the rest of a cave's water dry. Every existing
// area has exactly one shape, so this is the same answer they always gave.
function areaOverlapsBody(area: readonly ShapeTransform[], body: PhysicsBody2D): boolean {
  for (const a of area) {
    for (const s of body.getShapes()) if (shapesOverlap(a, s)) return true;
  }
  return false;
}

function shapesOverlap(a: ShapeTransform, b: ShapeTransform): boolean {
  if (a.shape.kind === "circle") {
    return circleOverlap(a.globalPosition, a.shape.radius, b) !== null;
  }
  if (b.shape.kind === "circle") {
    return circleOverlap(b.globalPosition, b.shape.radius, a) !== null;
  }
  // Cheap conservative reject first - a shape outside the other's bounding
  // circle cannot touch it - then the exact test. `shapeContacts` at slop 0
  // emits a point only where the loops genuinely meet.
  if (circleOverlap(a.globalPosition, shapeRadius(a.shape), b) === null) return false;
  return shapeContacts(a, b).length > 0;
}
