// Node / physics-body substitute for the Godot classes the game extends.
// Only the surface the game actually touches is modelled.

import { Vec2 } from "./vec2";
import { wrapAngle } from "./mathf";
import { isExposedCorner, shapeExtents, shapeVertices } from "./shapes";
import type { Shape, ShapeTransform } from "./shapes";
import type { World } from "./world";

// Live view of a body's collision shape (position/rotation track the body).
// `localOffset` mounts the shape away from the body origin in the body's local
// frame (rotates with the body); the default zero keeps single-shape bodies
// centred, exactly as before.
export class CollisionShape2D implements ShapeTransform {
  // May the rope catch on this shape? True for scene geometry — a compound
  // body's pieces are all real corners the rope wraps. False is for a shape
  // that exists as a *contact* proxy rather than as rope geometry: the ball &
  // chain avatar's mounting loop is solid so the ball can rest and tip on it,
  // but the chain deploys *through* it, so wrapping it would double-count the
  // one piece of geometry the chain is already threaded through.
  //
  // A property of the shape rather than of the body, because a compound body
  // can legitimately be both at once — which is exactly the ball's case, and
  // a level's too: `CollisionObjectData.wrappable` authors it per piece, for
  // the wheel whose rim is turned and whose hub winds the chain.
  wrappable = true;

  // Is this surface hook-proof? A hook that reaches it is destroyed (the grapple
  // hook) or deflected (the ball's), instead of anchoring. It blocks motion
  // exactly as any other solid shape does - hook-proof is about the *rope*, and
  // nothing else.
  //
  // A property of the SHAPE, and it has to be: which surface the hook reached is
  // a collision question, and every collision question here is about a shape
  // rather than a body ("`obj` identity answers 'does this move as one rigid
  // piece with that', `shape` identity answers 'is this the same surface'").
  // Held on the body it could not express either of the two things levels
  // actually want - a hook-proof crate that still falls and is hauled about
  // (a body kind cannot be `rigid` and `impermeable` at once), or a compound
  // wall with one attachable ledge and hook-proof faces everywhere else.
  impermeable = false;

  constructor(
    public owner: CollisionObject2D,
    public shape: Shape,
    public localOffset: Vec2 = Vec2.ZERO,
    // Rotation of the shape *within* the body's local frame, radians. A compound
    // body is authored as several pieces at their own angles - an L of two rects
    // meeting at 45°, a hull of polygons - and one body rotation cannot express
    // that. The default 0 makes a shape's rotation exactly the body's, which is
    // what every single-shape body (and every recorded replay) has.
    public localRotation = 0,
  ) {}

  // Where this shape lives in its owner's shape list, stamped by
  // `setShape`/`addShape`. The broadphase's candidate sort key alongside the
  // owner's `worldIndex` (see there).
  mountIndex = 0;
  // This shape's leaf in the world's broadphase tree, -1 while it has none.
  // Owned entirely by `World.syncBroadphase`.
  broadphaseProxy = -1;

  // Half-extents of this shape's world-axis-aligned box, cached against the
  // rotation (and shape object) they were computed at. A pure function of both,
  // so the cache cannot change any answer - what it removes is the per-vertex
  // rotate the old per-query `shapeExtents` calls burned, which the profiler
  // had at 6% of the frame.
  private extentsCache: Vec2 | null = null;
  private extentsCacheRot = 0;
  private extentsCacheShape: Shape | null = null;

  extents(): Vec2 {
    const rot = this.globalRotation;
    if (
      this.extentsCache !== null &&
      this.extentsCacheRot === rot &&
      this.extentsCacheShape === this.shape
    ) {
      return this.extentsCache;
    }
    const e = shapeExtents(this);
    this.extentsCache = e;
    this.extentsCacheRot = rot;
    this.extentsCacheShape = this.shape;
    return e;
  }

  get globalPosition(): Vec2 {
    return this.owner.globalPosition.add(
      this.localOffset.rotated(this.owner.globalRotation),
    );
  }
  get globalRotation(): number {
    return this.owner.globalRotation + this.localRotation;
  }

  // This shape's vertex `i` in world space. Circles have none.
  globalVertex(i: number): Vec2 | null {
    const v = shapeVertices(this.shape)[i];
    return v ? this.globalPosition.add(v.rotated(this.globalRotation)) : null;
  }

  // Is vertex `i` still a corner of the BODY, rather than a join swallowed by a
  // sibling piece? The rope may only bend around the first kind and the player
  // may only hang from the first kind (see `isExposedCorner`).
  //
  // Computed once and cached, because it is a property of how the body's pieces
  // are ARRANGED, and that arrangement is rigid: every piece rides the body's
  // transform, so moving or turning the body carries them all together and
  // cannot expose or bury a corner. Asking per query instead is what let three
  // separate call sites each answer it their own way, and each get it wrong.
  //
  // Invalidated when the body's shape set changes. Mutating a mounted shape's
  // `localOffset` / `localRotation` after build would not invalidate it, and
  // nothing does once the level is running: pieces are placed by `mountPieces`,
  // and the one thing that moves them afterwards (`reoriginTo`, an off-centre
  // pivot's bearing) still runs at build, before anything queries the body.
  isVertexExposed(i: number): boolean {
    if (this.shape.kind === "circle") return false;
    if (!this.exposedVertices) {
      const siblings = this.owner.getShapes();
      this.exposedVertices = shapeVertices(this.shape).map((_, k) => {
        const v = this.globalVertex(k);
        return v !== null && isExposedCorner(v, siblings);
      });
    }
    return this.exposedVertices[i] ?? false;
  }

  private exposedVertices: boolean[] | null = null;

  invalidateExposure(): void {
    this.exposedVertices = null;
  }
}

let nextId = 1;

// Collision layers. Bit 1 is solid scene geometry — everything the project has
// ever had, so every existing `collisionMask: 1` query keeps its meaning. Bit 2
// is geometry only the hook may find - a `passable` body, a vine link - which
// those queries therefore miss by construction; only the hook asks for both.
export const LAYER_SOLID = 1;
export const LAYER_ANCHOR = 2;

// Monotonic count of transform writes across ALL bodies in the process - the
// per-body `transformVersion`s summed, effectively. One integer comparison
// answers "has ANY body moved since I last looked", which is what lets derived
// geometry (a rope's span list) be memoized without watching each body it
// touches. Never reset.
let transformEpoch = 0;
export function currentTransformEpoch(): number {
  return transformEpoch;
}

export abstract class CollisionObject2D {
  readonly id: number = nextId++;
  // Position in the order its world was built, stamped by `World.add`. `id` is a
  // process-global counter, so a second level built in the same process (the
  // selftest runs a script and then replays it) numbers its bodies differently;
  // the build index is per world and therefore the same in both, which is what
  // makes it the name a full-world digest can be compared by. -1 until added.
  buildIndex = -1;
  // Position in its world's `bodies` array, maintained by `World.add`/`remove`.
  // The broadphase sorts its candidates by this so they are visited in exactly
  // the order the full `for (const body of this.bodies)` scans used to visit
  // them - which is what keeps every tie-break, and therefore every recorded
  // replay, bit-identical. -1 until added; areas never get one.
  worldIndex = -1;
  // Set when the transform (or shape set) has changed since the broadphase
  // last saw this body; cleared by `World.syncBroadphase`.
  broadphaseDirty = false;
  // Bumped on every transform write. "Has anything moved this body since I
  // last looked" is then one integer comparison, which is what lets a
  // converged constraint prove its next solve would be the identity and skip
  // it (see `SceneChain.solve`). Never reset, never compared across bodies.
  transformVersion = 0;
  name = "";
  private position_ = Vec2.ZERO;
  private rotation_ = 0;

  // The transform writes are the broadphase's only change signal: every path
  // that moves a body - integration, depenetration, the editor - lands here,
  // and marking on write is what lets a settled body cost the tree nothing.
  get globalPosition(): Vec2 {
    return this.position_;
  }

  set globalPosition(value: Vec2) {
    this.position_ = value;
    this.transformVersion++;
    transformEpoch++;
    if (!this.broadphaseDirty) this.world?.markBroadphaseDirty(this);
  }

  get globalRotation(): number {
    return this.rotation_;
  }

  set globalRotation(value: number) {
    this.rotation_ = value;
    this.transformVersion++;
    transformEpoch++;
    if (!this.broadphaseDirty) this.world?.markBroadphaseDirty(this);
  }
  // Bitmask of layers this body occupies (default layer 1, matching the project).
  collisionLayer = LAYER_SOLID;
  // The hook's mirror image of `CollisionShape2D.impermeable`: the hook reaches
  // this body and anchors to it, and everything else passes straight through.
  // The avatar walks and swings through it, loose debris falls through it, the
  // rope never wraps it - a background leaf on a stem the hook can catch, a
  // grate, a girder, a chandelier hung behind the level the player swings from.
  //
  // A property of the BODY and not of a shape, unlike hook-proofing. Hook-proof
  // asks "which surface did the hook reach", which is a question about one face;
  // this asks "is this thing in the way at all", and a body half in the way is
  // not a thing a level can mean - a compound leaf's pieces are one leaf.
  //
  // It was a body KIND (`anchor`), which cost the case this exists for: a kind
  // is what a body IS, so a passable body could only ever be immovable scenery,
  // and a leaf that hangs off a sprung stem is a `rigid` body. A flag composes
  // with every kind instead, exactly as `impermeable` and `pivot` do.
  //
  // Setting it moves the body onto `LAYER_ANCHOR`, which is what makes every
  // mask-1 query (the player's raycasts, ledge detection) miss it while the
  // hook, which asks for both layers, still finds it. The two always agree
  // because one writes the other; a caller that set the layer by hand and the
  // flag not at all is what the pairing removes.
  get passable(): boolean {
    return this.isPassable;
  }

  set passable(value: boolean) {
    this.isPassable = value;
    this.collisionLayer = value ? LAYER_ANCHOR : LAYER_SOLID;
  }

  private isPassable = false;
  // A body can carry more than one collision shape (a compound body). The first
  // is what `primaryShape()` returns for the few call sites that legitimately
  // mean exactly that shape; the rest are offset auxiliaries.
  collisionShapes: CollisionShape2D[] = [];
  // The shapes the broadphase currently holds leaves for - a snapshot taken by
  // `World.syncBroadphase` so a later `setShape` (which replaces the array
  // outright) still lets it find and drop the stale leaves.
  proxiedShapes: readonly CollisionShape2D[] = [];
  // Bodies excused from colliding with this one (Godot AddCollisionExceptionWith).
  readonly exceptions = new Set<number>();
  world: World | null = null;
  // Optional authored appearance (level geometry): hex fill colour + 0..1 fill
  // opacity. Null = the renderer uses its type-based default. Borders draw fully
  // opaque in `fillColor` regardless of `fillOpacity`.
  fillColor: string | null = null;
  fillOpacity = 1;
  // Surface friction of this body's geometry, 0 (ice) .. 1 (rubber). It scales
  // every contact-friction term another body applies *against* this one: the
  // character controller's ground and wall friction, and a rigidbody's Coulomb
  // friction, stiction and contact damping. 1 is the default and multiplies
  // those constants by exactly 1, so untouched levels — and recorded replays,
  // which predate this field — stay bit-identical.
  //
  // What it ANSWERS is the authored value scaled by how much of the body is in
  // water, which is why it is a getter: a submerged body is a body whose grip on
  // whatever it is resting on has largely gone, and every friction term in the
  // engine already reads this one property. Doing it here rather than at the
  // half-dozen places that combine two bodies' frictions is what stops the
  // Coulomb cone, the stiction pin and the contact damping disagreeing about
  // whether the ball is under water.
  private authoredFriction = 1;

  get surfaceFriction(): number {
    // `submerged === 0` is the whole of every level that authors no water, and
    // the branch is what keeps it EXACTLY the authored number rather than the
    // authored number times one - which is the same value, but only because
    // IEEE-754 says so, and the recorded corpus should not have to rely on it.
    if (this.submerged <= 0) return this.authoredFriction;
    return this.authoredFriction * (1 - this.submerged * WATER_TRACTION_LOSS);
  }

  set surfaceFriction(value: number) {
    this.authoredFriction = value;
  }

  // How bouncy this body's surface is, and how hard it throws back whatever
  // lands on it. Both are read off BOTH sides of a contact and the larger wins
  // (`contactBounce` in world.ts), so a trampoline pad states its own bounce
  // once and everything that meets it - the ball, its hook, a crate - is thrown
  // by it without knowing the pad exists.
  //
  // Here rather than on `RigidBody2D`, which is where `restitution` lived while
  // only a dynamic body could author one: a trampoline is a STATIC surface, and
  // the pair's bounce is a fact about the two surfaces meeting rather than about
  // whichever of them is the one that moves. Both default to 0 and MUST stay so
  // - recorded replays predate the fields, and a static contributing 0 is
  // exactly what the pair max used to read off it.
  //
  // `restitution` is the fraction of the inward normal velocity reflected back:
  // 0 is fully inelastic (the approach is simply cancelled), 1 a perfect bounce.
  // It is a RATIO, so what a body leaves with is proportional to what it arrived
  // with, and a body that arrives slowly leaves slowly.
  //
  // `launchSpeed` is the m/s the surface throws with regardless of that - the
  // spring in a trampoline, which is stored in the pad and not in the arrival.
  // It is a FLOOR under the outgoing normal speed, so a ball that has dropped
  // 20 cm leaves at the same speed as one that has fallen the height of the
  // level, which is the whole of what makes a pad a launcher rather than a
  // bouncy floor. See `contactBounce` for how the two combine and for why the
  // floor fades out at low approach speeds instead of applying at any touch.
  restitution = 0;
  launchSpeed = 0;

  // How much of this body is inside a `WaterArea`, 0 (dry) .. 1 (under). Written
  // once per frame by `World.applyWaterDrag` and never read by anything the sim
  // does not run: it is 0 for every body in a level with no water areas, so the
  // whole mechanism is invisible to a level that authors none.
  submerged = 0;

  // Reset the body to a single centred shape (Godot's usual one-CollisionShape
  // node). Replaces any auxiliaries.
  setShape(shape: Shape): CollisionShape2D {
    const s = new CollisionShape2D(this, shape);
    this.collisionShapes = [s];
    if (!this.broadphaseDirty) this.world?.markBroadphaseDirty(this);
    return s;
  }

  // Corner exposure is a property of the whole shape set, so adding or replacing
  // a shape invalidates every piece's cache, not just the new one's.
  private invalidateExposure(): void {
    for (const s of this.collisionShapes) s.invalidateExposure();
  }

  // Mount an extra shape offset (and optionally turned) in the body's local
  // frame; both ride the body's transform.
  addShape(shape: Shape, localOffset: Vec2, localRotation = 0): CollisionShape2D {
    const s = new CollisionShape2D(this, shape, localOffset, localRotation);
    s.mountIndex = this.collisionShapes.length;
    this.collisionShapes.push(s);
    this.invalidateExposure();
    if (!this.broadphaseDirty) this.world?.markBroadphaseDirty(this);
    return s;
  }

  // The primary (first-mounted) shape, and ONLY that one.
  //
  // Named for what it returns rather than for what a single-shape body happens
  // to make it mean. It used to be `getShape()`, and every caller that read it
  // as "this body's shape" went on believing the rest of a compound body was not
  // there: the hook's swept attach test flew straight through the second piece
  // of a three-piece wall, and the embedding invariants could not see a chain
  // buried in one either (`session-306f`).
  //
  // Legitimate uses are a body asking about ITSELF where it is known to carry
  // one shape - mass and inertia at construction, the avatar's own radius, the
  // character sweep's moving shape. Anything asking about *another* body's
  // geometry wants `getShapes()`, or one of the whole-body queries in
  // `engine/collision.ts` that iterate it for you.
  //
  // Areas used to be on that list and are not any more. They were single-shape
  // by construction only while every authored polygon was convex; an authored
  // concave outline is cut into convex pieces at load, so a killzone with a
  // notch in it is a several-shape area and `World.integrate` iterates them
  // (`areaOverlapsBody`) rather than acting through the first piece alone.
  primaryShape(): CollisionShape2D {
    const s = this.collisionShapes[0];
    if (!s) throw new Error(`No shape found for body ${this.name}`);
    return s;
  }

  // Every collision shape the body carries (primary first).
  getShapes(): readonly CollisionShape2D[] {
    return this.collisionShapes;
  }

  hasShape(): boolean {
    return this.collisionShapes.length > 0;
  }

  addCollisionExceptionWith(other: CollisionObject2D): void {
    this.exceptions.add(other.id);
    other.exceptions.add(this.id);
  }

  // Removed from the world tree (Godot GetParent().RemoveChild(this)).
  removed = false;

  // --- render interpolation -------------------------------------------------
  // The transform as it was at the start of the current physics step, so the
  // renderer can draw between two sim states instead of snapping to the newest
  // one. Without it a body moves only 60 times a second while the display
  // refreshes at 120 or 144 Hz, and the repeated/skipped frames read as jitter.
  //
  // These fields are **render-only**: the sim never reads them, so capturing
  // and interpolating them cannot change a recorded run.
  private prevPosition_r: Vec2 = Vec2.ZERO;
  private prevRotation_r = 0;
  // False until the first capture — a body spawned mid-frame has no previous
  // transform, and interpolating from the origin would fling it across the
  // level for one frame. It simply draws at its current transform instead.
  private hasPrev_r = false;

  // Called by World once per physics step, before anything moves.
  captureRenderTransform(): void {
    this.prevPosition_r = this.globalPosition;
    this.prevRotation_r = this.globalRotation;
    this.hasPrev_r = true;
  }

  // Position to draw at: `alpha` is the fraction of a step elapsed since the
  // last one (leftover accumulator / step), so 0 is the previous sim state and
  // 1 the current one.
  renderPosition(alpha: number): Vec2 {
    if (!this.hasPrev_r) return this.globalPosition;
    return this.prevPosition_r.lerp(this.globalPosition, alpha);
  }

  // Rotation to draw at, taken the short way round so a body crossing ±π
  // interpolates through the wrap instead of unwinding a full turn.
  renderRotation(alpha: number): number {
    if (!this.hasPrev_r) return this.globalRotation;
    return this.prevRotation_r + wrapAngle(this.globalRotation - this.prevRotation_r) * alpha;
  }

  // The primary shape at the interpolated transform — what the renderer paths
  // instead of the live `primaryShape()`.
  renderShape(alpha: number): ShapeTransform {
    const rot = this.renderRotation(alpha);
    return this.placeShape(this.primaryShape(), this.renderPosition(alpha), rot);
  }

  // Every shape at the interpolated transform, primary first. A compound body is
  // several pieces on one transform, so the renderer draws them all rather than
  // only the one `renderShape` returns.
  renderShapes(alpha: number): ShapeTransform[] {
    const pos = this.renderPosition(alpha);
    const rot = this.renderRotation(alpha);
    return this.collisionShapes.map((s) => this.placeShape(s, pos, rot));
  }

  private placeShape(s: CollisionShape2D, pos: Vec2, rot: number): ShapeTransform {
    return {
      shape: s.shape,
      globalPosition: pos.add(s.localOffset.rotated(rot)),
      globalRotation: rot + s.localRotation,
    };
  }
}

export abstract class PhysicsBody2D extends CollisionObject2D {
  // Mobility classification (game-design.md): can this body's transform change
  // over time? Separate axis from "physics-driven".
  get isMobile(): boolean {
    return false;
  }

  // Surface velocity at a world point: v + ω × r (game-design.md, velocity
  // inheritance). Static bodies are immobile, so zero.
  velocityAtPoint(_worldPoint: Vec2): Vec2 {
    return Vec2.ZERO;
  }

  // Whether the body is currently rotating — drives the character
  // controller's grip grace on near-threshold faces (game-design.md).
  get isRotating(): boolean {
    return false;
  }

  // Does this body block motion? False for a `passable` body, which the hook
  // anchors to but nothing collides with, and for a vine link, which is blocked
  // by statics but blocks nothing itself. Queries that scan bodies generically -
  // ledge detection, the debug overlay, the rope's wrap list - filter on this
  // rather than naming a class.
  get isSolid(): boolean {
    return !this.passable;
  }
}

export class StaticBody2D extends PhysicsBody2D {}

// Script-driven mover (Godot AnimatableBody2D): transform is set by game logic
// each frame; collides as static / infinite mass, but exposes the per-frame
// contact velocities so the character controller can inherit them.
export class AnimatableBody2D extends StaticBody2D {
  linearVelocity: Vec2 = Vec2.ZERO;
  angularVelocity = 0;
  private prevPosition: Vec2 = Vec2.ZERO;
  private prevRotation = 0;

  override get isMobile(): boolean {
    return true;
  }

  override get isRotating(): boolean {
    return Math.abs(this.angularVelocity) > 1e-9;
  }

  // Snapshot the transform before the mover script runs this frame.
  beginMove(): void {
    this.prevPosition = this.globalPosition;
    this.prevRotation = this.globalRotation;
  }

  // Derive contact velocities from the per-frame transform delta.
  commitMove(dt: number): void {
    this.linearVelocity = this.globalPosition.sub(this.prevPosition).div(dt);
    this.angularVelocity = wrapAngle(this.globalRotation - this.prevRotation) / dt;
  }

  override velocityAtPoint(worldPoint: Vec2): Vec2 {
    const r = worldPoint.sub(this.globalPosition);
    return this.linearVelocity.add(new Vec2(-r.y, r.x).mul(this.angularVelocity));
  }
}

// Result of CharacterBody2D.moveAndCollide.
export class KinematicCollision2D {
  constructor(
    private normal: Vec2,
    private travel: Vec2,
    private remainder: Vec2,
    private collider: CollisionObject2D,
    private position: Vec2,
  ) {}
  getNormal(): Vec2 {
    return this.normal;
  }
  getTravel(): Vec2 {
    return this.travel;
  }
  getRemainder(): Vec2 {
    return this.remainder;
  }
  getCollider(): CollisionObject2D {
    return this.collider;
  }
  // World-space contact point on the collider (Godot GetPosition).
  getPosition(): Vec2 {
    return this.position;
  }
}

export class CharacterBody2D extends PhysicsBody2D {
  velocity: Vec2 = Vec2.ZERO;
  // Whether moveAndCollide imparts an impulse on RigidBody2D colliders.
  pushesRigidBodies = false;

  get mass(): number {
    return 1;
  }

  override get isMobile(): boolean {
    return true;
  }

  override velocityAtPoint(_worldPoint: Vec2): Vec2 {
    return this.velocity;
  }

  moveAndCollide(motion: Vec2, testOnly = false): KinematicCollision2D | null {
    if (!this.world) return null;
    return this.world.moveAndCollide(this, motion, testOnly);
  }
}

export class RigidBody2D extends PhysicsBody2D {
  linearVelocity: Vec2 = Vec2.ZERO;
  angularVelocity = 0;
  mass = 1;
  // Coulomb friction coefficient (μ) for static contacts: tangential impulses
  // (capped at μ × the frame's normal impulse) couple linear and angular
  // motion so sliding becomes rolling. 0 preserves the historical
  // frictionless-rotation behaviour and MUST stay the default: recorded
  // replays predate this field.
  //
  // Submerged, a body brings less of it, exactly as `surfaceFriction` scales
  // what it OFFERS another body (see the note there). Both halves are needed and
  // they are not the same statement: the friction against a static floor is the
  // moving body's coefficient times the floor's, so scaling only what the water
  // is standing in leaves a ball resting on a dry-authored channel bed gripping
  // it as though the water were not there.
  private authoredContactFriction = 0;

  get contactFriction(): number {
    if (this.submerged <= 0) return this.authoredContactFriction;
    return this.authoredContactFriction * (1 - this.submerged * WATER_TRACTION_LOSS);
  }

  set contactFriction(value: number) {
    this.authoredContactFriction = value;
  }
  // Per-frame velocity damp applied while touching static geometry. The
  // historical 0.98 MUST stay the default (recorded replays); rolling bodies
  // set it lighter and get their resistance from the Coulomb model instead.
  contactDamp = 0.98;
  // Scale on friction impulses that oppose the body's current travel
  // (braking); impulses that push along it (spin driving a roll) always apply
  // in full. 1 = symmetric Coulomb friction, the default. The ball controller
  // fades this with speed while the player aims, so reorienting the spin
  // mid-roll cannot shed momentum but can still drive the ball.
  contactBrakeScale = 1;
  // True while this body is held by an anchored chain (`BallLevel` maintains
  // it). Another ball-controller device: with the chain anchored, contact spin
  // traction is left exactly as it always was - the wind-up's climb to its
  // anchor starts on a wall the ball has only just met, funded by its arrival
  // impact, and the chain machinery (winch budget, unwind, the lease) is what
  // polices that regime. The spin-traction ramp in `World.solveTangent` guards
  // the FREE ball, whose wall impact has no chain to answer for it
  // (`session-773f`).
  constraintTethered = false;
  // When true, the body's rotation is driven externally (the ball & chain
  // avatar's aim steering overwrites angularVelocity every frame), so contact
  // resolution treats it as rotationally locked (infinite rotational inertia):
  // no contact feeds angular velocity — that would be discarded next frame, and
  // the wasted impulse is what let a steered ball slide instead of braking.
  // Default false keeps every other body — and recorded replays — unchanged.
  kinematicRotation = false;
  // When true, World.integrate advances the body's position by a swept motion
  // against static geometry (earliest time of impact across every circle shape
  // the body carries) instead of the discrete `pos += v*dt` step, so the body
  // can never cross a static surface within a step however fast it moves. The
  // ball and its hook set it: both are small, fast circles, and a discrete step
  // let the hook cross into a compound floor and travel along the seam between
  // two of its convex pieces, where every per-piece answer - contacts,
  // depenetration - points at the seam rather than out of the body
  // (session-1085f). Default false: loose debris is neither small nor fast
  // enough to tunnel, and recorded replays predate this field.
  continuous = false;
  // Static-friction (stiction) coefficient μ_s. A nearly-stationary body on a
  // slope whose along-surface gravity is within μ_s × the normal force is
  // pinned (tangential velocity and spin zeroed) instead of rolling/creeping
  // off — it breaks loose only past the breakaway angle atan(μ_s). This is a
  // deliberately non-physical grip (a real point-contact ball rolls down any
  // slope). 0 disables it and MUST stay the default: recorded replays predate
  // this field. Scaled by submersion as the kinetic coefficient above is.
  private authoredStaticFriction = 0;

  get staticFriction(): number {
    if (this.submerged <= 0) return this.authoredStaticFriction;
    return this.authoredStaticFriction * (1 - this.submerged * WATER_TRACTION_LOSS);
  }

  set staticFriction(value: number) {
    this.authoredStaticFriction = value;
  }
  // The anchor held while static friction has the body gripped: its
  // along-surface position is pinned here so gravity cannot ratchet it downhill
  // one integration step at a time. Null when not gripped; cleared the first
  // frame the body has no sticking contact (so it never snaps back after
  // leaving the ground).
  //
  // Stored in the SURFACE's frame (`stickBody`) rather than in the world's,
  // because the surface may be another rigid body and then the anchor is a
  // material point of it - the pin holds the two bodies together along their
  // shared face, which is a statement about them and not about the world. For a
  // static surface the frame never moves and the two are the same thing.
  stickBody: PhysicsBody2D | null = null;
  stickAnchor: Vec2 | null = null;
  // Consecutive frames the body has had no gripping contact. The anchor is only
  // dropped once this passes `STICK_RELEASE_FRAMES`: a single frame's flicker of
  // the grip is not the body leaving the surface, and dropping the anchor on one
  // re-seeds it wherever the body has drifted to, which ratchets.
  ungrippedFrames = 0;
  // The gripped contact point in the BODY's own frame. `stickAnchor` records
  // where that material point was when the grip took hold; this is what finds it
  // again after the body has turned. Anchoring the raw manifold point instead
  // does not work: it is a geometric point that slides along the contacting face
  // as the body settles, so it drifts even when nothing is sliding.
  stickLocal: Vec2 = Vec2.ZERO;
  // The surface normal the grip took hold along, or null when not gripped. It is
  // what splits the depenetration sweep's correction into the part the anchor
  // must follow (out of the surface) and the part it must not (along it, which
  // is the drift the pin exists to cancel).
  stickNormal: Vec2 | null = null;

  // Take hold at `worldPoint` on `surface`, storing the anchor in that surface's
  // frame. Every writer goes through this rather than assigning `stickAnchor`
  // directly, so an anchor can never be left naming one body while holding
  // another's coordinates.
  setStickAnchor(surface: PhysicsBody2D, worldPoint: Vec2): void {
    this.stickBody = surface;
    this.stickAnchor = worldPoint
      .sub(surface.globalPosition)
      .rotated(-surface.globalRotation);
  }

  // Where the anchor is now, in world space - which for a rigid surface is
  // wherever that surface has carried it since.
  stickAnchorWorld(): Vec2 | null {
    if (this.stickAnchor === null || this.stickBody === null) return null;
    return this.stickBody.globalPosition.add(
      this.stickAnchor.rotated(this.stickBody.globalRotation),
    );
  }

  releaseStick(): void {
    this.stickAnchor = null;
    this.stickBody = null;
    this.stickNormal = null;
  }

  override get isMobile(): boolean {
    return true;
  }

  override get isRotating(): boolean {
    return Math.abs(this.angularVelocity) > 1e-9;
  }

  override velocityAtPoint(worldPoint: Vec2): Vec2 {
    const r = worldPoint.sub(this.globalPosition);
    return this.linearVelocity.add(new Vec2(-r.y, r.x).mul(this.angularVelocity));
  }
  // Moment of inertia about the centre of mass.
  inertia = 1;
  gravityScale = 1;
  // Pivot mounting: the body is bolted to the world through a frictionless
  // bearing at its origin (the centre of mass), so it cannot translate but is
  // free to spin - a windmill fin, a paddle wheel. Translation is removed at
  // the source rather than fought: `inverseMass` reads 0, so every impulse
  // path (contacts, the rope, an explosion) moves it nothing, and
  // `World.integrate` skips gravity and zeroes `linearVelocity` so an area
  // current cannot creep it off its axle. Torque is untouched - spinning the
  // body IS the mechanic - and the origin being the centre of mass is what
  // makes gravity torque-free about the bearing, so an unbalanced fin still
  // hangs where it was authored. Default false keeps every other body - and
  // recorded replays - unchanged.
  pivot = false;
  // Where the centre of mass sits relative to the bearing, in the body's own
  // frame. ZERO for a plain pivot body, whose origin IS the centre of mass
  // (above). An authored pivot POINT (`LevelBodyData.pivotX`) re-origins the
  // body onto the bearing instead - the origin is the hinge, the inertia
  // carries the parallel-axis term - and this vector is what gravity's torque
  // about the bearing is measured by in `World.integrate`. With the origin at
  // the hinge every existing impulse path is exact for a hinged body with no
  // code of its own: `inverseMass` 0 holds the axle, and every lever arm the
  // engine measures from `globalPosition` is measured from the hinge.
  pivotComOffset = Vec2.ZERO;
  // Torsion return spring on a pivot body (`LevelBodyData.pivotFreq`): a
  // damped angular oscillator about the rest angle the body was built at, so a
  // branch bends away under a load - a hanging player, a thrown crate - and
  // returns to its authored angle when the load leaves. The acceleration form
  // (`alpha = -w²·Δθ - 2ζw·ω`, applied in `World.integrate`) makes the free
  // oscillation mass-independent, exactly as the linear spring's is. The angle
  // is deliberately NOT wrapped: a body wound a full turn unwinds a full turn,
  // which is what a torsion spring does. Null for a free-spinning pivot and
  // for every other body; recorded replays predate the field.
  pivotSpring: { restAngle: number; omega: number; zeta: number } | null = null;
  // The Δw the integrate step's own restoring dynamics - the torsion spring
  // and an off-centre bearing's gravity torque - applied to this pivot THIS
  // frame (rad/s, signed; zero for a plain centre-of-mass pivot). Written by
  // `World.integrate`, read by `Rope.boundRotationCredit`: the solve's
  // rotation-credit top-up must never refund velocity the body's own
  // dynamics just removed, or a hanging load position-marches the branch at
  // a constant rate with the spring's bite handed back every frame
  // (session-333f).
  pivotFrameAccelDw = 0;
  // Spring mounting: the body is held at its authored position by a two-axis
  // spring-damper rather than bolted to it (see `LevelBodyData.springFreqX`).
  // It sags under its own weight, sags further under a load - a hanging
  // player, a resting rock, rope tension - and springs back with a visible
  // overshoot when the load leaves: a plant whose leaf the player grabs, the
  // spring standing in for the stem bending.
  //
  // `anchor` is the body's built position (its centre of mass), `omegaX` /
  // `omegaY` are the per-axis angular frequencies in rad/s (0 = that axis
  // rigidly pinned to the anchor) and `zeta` is the shared damping ratio.
  // The force is applied in `World.integrate` alongside gravity, so every
  // impulse path in the engine loads it with no plumbing of its own.
  //
  // Where `pivot` removes ROTATION from a rigid body's freedom, `spring`
  // removes rotation instead: a leaf on a stem translates on its spring, it
  // does not spin. The two are therefore mutually exclusive - together they
  // would describe a body that cannot move at all - and `buildBodies` refuses
  // the combination. Null for every ordinary body; recorded replays predate
  // the field.
  spring: { anchor: Vec2; omegaX: number; omegaY: number; zeta: number } | null = null;

  get inverseMass(): number {
    if (this.pivot) return 0;
    return this.mass > 0 ? 1 / this.mass : 0;
  }
  get inverseInertia(): number {
    // A spring body's rotation is locked at the source, exactly as a pivot's
    // translation is: every impulse path - contacts, the rope's torque arm, an
    // explosion - writes angular velocity through this getter, so 0 here is one
    // statement covering all of them. NOT modelled as `inertia = Infinity`:
    // `mechanicalEnergy` computes 0.5·inertia·w² and Infinity·0 is NaN. Nor as
    // `kinematicRotation`, which means "rotation is externally driven this
    // frame" and belongs to the ball controller.
    if (this.spring) return 0;
    return this.inertia > 0 ? 1 / this.inertia : 0;
  }

  // Godot ApplyImpulse(impulse, position=offset from centre of mass).
  applyImpulse(impulse: Vec2, position: Vec2 = Vec2.ZERO): void {
    this.linearVelocity = this.linearVelocity.add(impulse.mul(this.inverseMass));
    this.angularVelocity += this.inverseInertia * position.cross(impulse);
  }

  // Reconcile the body with its own shape, after the frame's rotation step and
  // before any contact is gathered against it. A no-op for everything but the
  // ball, whose mounting loop makes its silhouette turn with it
  // (`BallPlayer.applyLoopRide`).
  //
  // The window is the whole point and is not interchangeable with running before
  // `integrate` or after the solve. Before, the rotation this answers has not
  // happened yet; after, the gather has already decided the frame's contacts
  // against a pose the body was not going to keep - which for the ball is the
  // difference between rolling and hopping. Position only, so the body is paid
  // nothing for it and the solve still sizes its normal impulse (and so its
  // Coulomb cone) from gravity's own step, exactly as for a resting body.
  preContactStep(_dt: number): void {}
}

// One link of a hanging vine (see `level/vines.ts`). A real dynamic body - it
// falls, it is held by the chain constraints between it and its neighbours, and
// the hook's ray hits it, which is the whole reason it is a body rather than a
// drawn curve: a wrap-point rope is a constraint and nothing can be grabbed
// halfway along one.
//
// It is a `RigidBody2D` because it needs gravity integration and mass, and
// because the entire chain phase (`snapshotChainBodies`, `settleChainBodies`,
// `creditScale`) is written against `instanceof RigidBody2D`.
//
// It is `passable`: blocked by nothing at all, statics included, exactly as a
// hook-only leaf is - the hook is the one thing in the sim that finds it. A
// vine used to be the weaker statement ("a non-solid body blocks nothing, and
// is blocked only by statics"), which is how one draped over a ledge and
// pooled on a floor; vines ignore the scenery outright now (see
// `level/vines.ts`), which takes the links out of the contact gather, the
// depenetration sweep and `settleChainBodies`' static push-out - most of what
// an awake vine cost.
//
// So the player walks and swings straight through a vine, a vine never pushes
// the ball or is pushed by it, never stacks on another vine and never fights
// its own pair constraints through the contact solver - the
// stacking-and-contact problem `docs/game-design.md` cites against
// body-per-link chains, removed by construction rather than solved.
//
// `LAYER_ANCHOR` (set by `passable`) is what the hook sees and what every
// mask-1 query (the player's raycasts, ledge detection) therefore misses.
export class VineLink extends RigidBody2D {
  // A settled vine costs nothing.
  //
  // This is the "no sleeping" simplification `docs/game-design.md` lists, taken
  // for the one body kind that finally needed it. A vine is `length / spacing`
  // bodies and that many constraints, all swept every frame whether or not
  // anything is happening to them: two 3 m vines in the ball arena are 40 links
  // and 3.9 ms a physics frame, against 0.15 ms for the same arena with none.
  // Nearly all of that is spent on vines hanging perfectly still.
  //
  // Asleep, a link is skipped by `World.integrate` (no gravity, no contacts, no
  // depenetration) and its vine is left out of the chain sweep entirely, which
  // is where the cost is. What it is NOT skipped by is the hook's raycast: a
  // sleeping vine is still a thing you can catch, and waking it is what being
  // caught means (see `stepVines`).
  //
  // It is a flag on the body rather than a general engine feature because the
  // engine has no sleeping and this is not the change that should introduce one:
  // every other body here is either scenery that never moves or an avatar that
  // always does. Default false, and nothing but a vine ever sets it, so no other
  // body and no recorded replay can see it.
  asleep = false;

  constructor() {
    super();
    this.name = "VineLink";
    this.passable = true;
  }

  override get isSolid(): boolean {
    return false;
  }
}

export class Area2D extends CollisionObject2D {
  private bodyEnteredCbs: Array<(body: CollisionObject2D) => void> = [];
  private inside = new Set<number>();

  onBodyEntered(cb: (body: CollisionObject2D) => void): void {
    this.bodyEnteredCbs.push(cb);
  }

  // Called by the world each step with the bodies currently overlapping.
  notifyOverlaps(current: CollisionObject2D[]): void {
    const currentIds = new Set(current.map((b) => b.id));
    for (const b of current) {
      if (!this.inside.has(b.id)) {
        for (const cb of this.bodyEnteredCbs) cb(b);
      }
    }
    this.inside = currentIds;
  }
}

// A region that accelerates every body inside it — a river current, wind, an
// updraft (Godot's Area2D gravity override, which this mirrors). The direction
// is the area's own rotation, so the same rotate handle that aims a rect aims
// the flow; `magnitude` is signed, and negative reverses it.
//
// Deliberately an acceleration rather than a true force: the current carries
// light and heavy bodies alike, so a level author tunes one number and gets the
// same drift for the avatar, a pebble and a boulder.
export class ForceArea extends Area2D {
  // Acceleration along the area's local +X, in m/s².
  magnitude = 0;

  constructor() {
    super();
    this.name = "ForceArea";
  }

  get acceleration(): Vec2 {
    return Vec2.RIGHT.rotated(this.globalRotation).mul(this.magnitude);
  }
}

// How much grip a body loses when it is fully submerged. A sewer channel is a
// slimed floor under moving water, and a body resting on one keeps a fifth of
// the traction it has in the dry.
//
// It exists because a current cannot otherwise be felt by anything standing on
// the bottom. The steered ball GRIPS what it rolls on (`applySteeringGrip`
// writes its whole tangential velocity from the roll), and a flat floor passes
// the grip's budget test at any friction at all - so without this a ball sitting
// in a river is a ball the river does not touch, and the one place the player
// meets the water is the one place it does nothing.
export const WATER_TRACTION_LOSS = 0.8;

// Past this much of a body being under, the steered ball's grip is released
// outright and what is left holding it is the solver's (now much smaller)
// Coulomb friction. Traction scaling alone is not enough for the grip, which is
// a position pin rather than a force: on level ground its budget test compares
// gravity's tangential component (zero) against the cone (anything positive), so
// it holds however slippery the floor is.
export const WATER_GRIP_RELEASE = 0.25;

// A body of water: a region that drags whatever is inside it toward a current
// rather than pushing it along one.
//
// The difference from `ForceArea` is the whole reason this is its own kind. A
// force is an acceleration and has no terminal speed, so a body left in one is
// flung; water has a speed it carries things AT, and reaching that speed is the
// same act as being slowed to it. One relative-velocity drag says both:
//
//     v ← v + (flow − v) · (1 − 1/(1 + drag·dt))
//
// which is the implicit form of `dv/dt = drag · (flow − v)`, so it is stable at
// any `drag` and any step and cannot overshoot the current the way the explicit
// form does past `drag·dt = 2`. Being an acceleration law it is also
// MASS-INDEPENDENT: the 52 kg ball and the 70 kg avatar drift downstream at the
// same speed, which is what makes "pushed back at a constant speed" a property
// of the water rather than of what fell in it.
//
// Its direction is the area's own rotation, as a force area's is, so the same
// rotate handle that aims one aims the other; `flow` is signed and negative
// reverses it.
export class WaterArea extends Area2D {
  // Current speed along the area's local +X, in m/s. This is the speed a body
  // left in the water ends up travelling at, not a force.
  flow = 0;
  // How hard the water couples a body to that current, in 1/s: the reciprocal is
  // the time constant of the approach, so 5 has a body at two thirds of the
  // current in a fifth of a second. It also sets how much the water resists
  // motion ACROSS the flow, which is what makes a body dropped in it sink
  // slowly rather than fall.
  drag = 0;

  constructor() {
    super();
    this.name = "WaterArea";
  }

  get flowVelocity(): Vec2 {
    return Vec2.RIGHT.rotated(this.globalRotation).mul(this.flow);
  }
}
