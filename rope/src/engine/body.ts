// Node / physics-body substitute for the Godot classes the game extends.
// Only the surface the game actually touches is modelled.

import { Vec2 } from "./vec2";
import { wrapAngle } from "./mathf";
import type { Shape, ShapeTransform } from "./shapes";
import type { World } from "./world";

// Live view of a body's collision shape (position/rotation track the body).
// `localOffset` mounts the shape away from the body origin in the body's local
// frame (rotates with the body); the default zero keeps single-shape bodies
// centred, exactly as before.
export class CollisionShape2D implements ShapeTransform {
  constructor(
    public owner: CollisionObject2D,
    public shape: Shape,
    public localOffset: Vec2 = Vec2.ZERO,
  ) {}
  get globalPosition(): Vec2 {
    return this.owner.globalPosition.add(
      this.localOffset.rotated(this.owner.globalRotation),
    );
  }
  get globalRotation(): number {
    return this.owner.globalRotation;
  }
}

let nextId = 1;

// Collision layers. Bit 1 is solid scene geometry — everything the project has
// ever had, so every existing `collisionMask: 1` query keeps its meaning. Bit 2
// is hook-only geometry (`AnchorBody`), which those queries therefore miss by
// construction; only the hook asks for both.
export const LAYER_SOLID = 1;
export const LAYER_ANCHOR = 2;

export abstract class CollisionObject2D {
  readonly id: number = nextId++;
  name = "";
  globalPosition: Vec2 = Vec2.ZERO;
  globalRotation = 0;
  // Bitmask of layers this body occupies (default layer 1, matching the project).
  collisionLayer = LAYER_SOLID;
  // A body can carry more than one collision shape (a compound body). The first
  // is the primary, centred shape that `getShape()` returns for the many call
  // sites that assume a single shape; the rest are offset auxiliaries.
  collisionShapes: CollisionShape2D[] = [];
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
  surfaceFriction = 1;

  // Reset the body to a single centred shape (Godot's usual one-CollisionShape
  // node). Replaces any auxiliaries.
  setShape(shape: Shape): CollisionShape2D {
    const s = new CollisionShape2D(this, shape);
    this.collisionShapes = [s];
    return s;
  }

  // Mount an extra shape offset in the body's local frame (rotates with it).
  addShape(shape: Shape, localOffset: Vec2): CollisionShape2D {
    const s = new CollisionShape2D(this, shape, localOffset);
    this.collisionShapes.push(s);
    return s;
  }

  // The primary (centred) shape. Used by every query that assumes a single
  // shape — the rope solver, mass/inertia, the character sweep's moving shape.
  getShape(): CollisionShape2D {
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
  // instead of the live `getShape()`.
  renderShape(alpha: number): ShapeTransform {
    const s = this.getShape();
    const rot = this.renderRotation(alpha);
    return {
      shape: s.shape,
      globalPosition: this.renderPosition(alpha).add(s.localOffset.rotated(rot)),
      globalRotation: rot,
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

  // Does this body block motion? False only for hook-only geometry
  // (`AnchorBody`), which the hook anchors to but nothing collides with.
  // Queries that scan bodies generically — ledge detection, the debug overlay —
  // filter on this rather than naming the class.
  get isSolid(): boolean {
    return true;
  }
}

export class StaticBody2D extends PhysicsBody2D {}

// Rope-attachment blocker: hooks are destroyed on contact instead of attaching.
export class ImpermeableBody extends StaticBody2D {}

// Hook-only scene geometry — the mirror image of ImpermeableBody. The hook
// anchors to it, but the avatar, the rope/chain and loose debris all pass
// straight through: a background grate, girder or chandelier the player can
// swing from without it blocking the level.
//
// It deliberately extends PhysicsBody2D *directly* rather than StaticBody2D.
// Every collision path in `World` (moveAndCollide, resolveDynamicCollisions) is
// written as an allowlist of `StaticBody2D | RigidBody2D`, so a body outside
// that pair is excluded by construction instead of by a special case each site
// would have to remember. Raycasts exclude it by layer (`LAYER_ANCHOR`), and
// the rope never sees it at all — `buildLevelBodies` keeps it out of the wrap
// list, so no span can catch on it.
export class AnchorBody extends PhysicsBody2D {
  constructor() {
    super();
    this.name = "Anchor";
    this.collisionLayer = LAYER_ANCHOR;
  }

  override get isSolid(): boolean {
    return false;
  }
}

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
  contactFriction = 0;
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
  // Coefficient of restitution (bounciness) for static contacts: the fraction
  // of inward normal velocity reflected back on impact. 0 = fully inelastic
  // (kill inward velocity) and MUST stay the default — recorded replays predate
  // this field. 1 would be a perfect bounce.
  restitution = 0;
  // When true, the body's rotation is driven externally (the ball & chain
  // avatar's aim steering overwrites angularVelocity every frame), so contact
  // resolution treats it as rotationally locked (infinite rotational inertia):
  // no contact feeds angular velocity — that would be discarded next frame, and
  // the wasted impulse is what let a steered ball slide instead of braking.
  // Default false keeps every other body — and recorded replays — unchanged.
  kinematicRotation = false;
  // Static-friction (stiction) coefficient μ_s. A nearly-stationary body on a
  // slope whose along-surface gravity is within μ_s × the normal force is
  // pinned (tangential velocity and spin zeroed) instead of rolling/creeping
  // off — it breaks loose only past the breakaway angle atan(μ_s). This is a
  // deliberately non-physical grip (a real point-contact ball rolls down any
  // slope). 0 disables it and MUST stay the default: recorded replays predate
  // this field.
  staticFriction = 0;
  // World-space anchor held while static friction has the body gripped: its
  // along-surface position is pinned here so gravity cannot ratchet it downhill
  // one integration step at a time. Null when not gripped; cleared the first
  // frame the body has no sticking contact (so it never snaps back after
  // leaving the ground).
  stickAnchor: Vec2 | null = null;

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

  get inverseMass(): number {
    return this.mass > 0 ? 1 / this.mass : 0;
  }
  get inverseInertia(): number {
    return this.inertia > 0 ? 1 / this.inertia : 0;
  }

  // Godot ApplyImpulse(impulse, position=offset from centre of mass).
  applyImpulse(impulse: Vec2, position: Vec2 = Vec2.ZERO): void {
    this.linearVelocity = this.linearVelocity.add(impulse.mul(this.inverseMass));
    this.angularVelocity += this.inverseInertia * position.cross(impulse);
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
