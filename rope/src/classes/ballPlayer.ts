// BallPlayer — the ball & chain character controller. Unlike Player (a
// CharacterBody2D driven by a state machine), the ball is a plain RigidBody2D:
// gravity, rolling and chain tension are the only things that move it. The
// chain reuses the Rope wrap solver — its start contact is a point on the
// ball's EDGE, stored in the ball's local frame, so it rotates with the ball
// and the chain can wind around the ball itself; chain tension applied at the
// edge torques the ball (the rope solver's lever-arm path, which Player
// deliberately bypasses).

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { wrapAngle } from "../engine/mathf";
import { ImpermeableBody, RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeAttachment, RopeContact } from "../lib/ropeContact";
import type { FrameInput } from "../input/frameInput";
import { Rope } from "./rope";
import { BallHook } from "./ballHook";

export class BallPlayer extends RigidBody2D {
  // Absolute maximum chain length: pay-out stops here, a hook still flying at
  // this length has missed, and an attachment beyond it snaps the chain.
  static readonly CHAIN_MAX_LENGTH = 1.8;
  static readonly HOOK_SPEED = 12; // m/s launch speed (gravity arcs the flight)
  // Attachments longer than max by more than this snap the chain; within it
  // they clamp to max instead. Must cover the dangling state's solver
  // tolerance (~1 px over) — a deployed tip that finally lands attaches at
  // slightly over max and must NOT snap (found via session-1565f).
  static readonly ATTACH_SNAP_TOLERANCE = 0.2;
  // Proportional gain steering the loop toward the aim direction (1/s).
  // Stable at 1/60 while gain*dt < 1.
  static readonly AIM_TURN_GAIN = 15;
  // Coulomb coefficient for ground contact. Friction that DRIVES the ball
  // (the steered spin gripping the ground) always applies in full, so aiming
  // kicks and crawls the ball at any speed. Friction that would BRAKE the
  // ball fades with speed while aiming: full grip at rest, decaying smoothly
  // as the ball speeds up so it slides once genuinely fast (down a ramp)
  // while still gripping firmly through low/medium speeds.
  static readonly ROLL_FRICTION = 1.8;
  // Static-friction coefficient μ_s → breakaway angle atan(μ_s). 0.58 ≈ 30°:
  // the ball holds on shallow/moderate slopes and only slides once steeper.
  static readonly STATIC_FRICTION = 0.58;
  // The mounting loop's collision radius, and the gap between the ball's rim
  // and the loop ring's centre. Shared by the physics (a second collision
  // circle) and the renderer so the solid loop matches the drawn one.
  static readonly LOOP_RADIUS = 2 * PX;
  static readonly LOOP_GAP = 1.5 * PX;
  // Density relative to the default sim material (computeMass ≈ water). The
  // ball is cast iron: ρ ≈ 7200 kg/m³ vs water 1000 → 7.2× the base mass.
  // Higher = heavier, more sluggish response to aim-kicks, chain tugs, impacts.
  static readonly MASS_SCALE = 7.2;
  // Braking friction follows an exponential falloff in speed:
  //   brake = MIN + (1 - MIN) * exp(-speed / DECAY_SPEED)
  // DECAY_SPEED is the e-folding speed — the higher it is, the longer friction
  // keeps biting before it thins out. A smooth gradient the whole way, with no
  // corner where grip suddenly vanishes (the old linear ramp cliffed to the
  // floor by ~60 px/s, leaving almost no friction at medium speed).
  static readonly AIM_BRAKE_DECAY_SPEED = 1.1; // m/s — brake ≈ 0.6 at 0.6, 0.5 at 0.8
  static readonly AIM_BRAKE_MIN = 0.05; // braking fraction remaining at high speed

  chain: Rope | null = null;
  hookInFlight: BallHook | null = null;
  // Free chain end after a miss: the hook disarms in place and lives on as a
  // dangling tip weight — the chain stays deployed at max length until reeled
  // or released.
  chainTip: BallHook | null = null;
  spawnBody: ((body: PhysicsBody2D) => void) | null = null;
  // Scene bodies for the current frame, set by BallLevel before hooks step, so
  // the hook's attach callback can regenerate the chain's wrap path (the hook
  // fires mid-integration, with no bodies list in hand).
  sceneBodies: PhysicsBody2D[] = [];

  constructor(radius = 0.08) {
    super();
    // KillZone reset and the hook's don't-attach-to-the-avatar check both
    // match by name.
    this.name = "Player";
    this.setShape(circleShape(radius));
    // The mounting loop is solid: a second collision circle fixed to the rim,
    // so the ball can rest, tip, and catch edges on the loop as it rotates.
    // (The flying chain hook still ignores it — BallHook skips bodies named
    // "Player".) Mass/inertia stay those of the ball body: the loop is a light
    // steel ring, a collision bump rather than a significant mass.
    this.addShape(circleShape(BallPlayer.LOOP_RADIUS), this.loopLocalOffset);
    // Heavy ball: mass scaled up so aim-kicks, chain tugs, and collisions move
    // it less (F = ma) — sluggish, momentum-carrying feel. Gravity is
    // acceleration-based, so this does not change fall speed.
    this.mass = ShapeGeometry.computeMass(this.getShape()) * BallPlayer.MASS_SCALE;
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.getShape(), this.mass);
    // Coulomb friction coefficient — ground contact gradually converts slide
    // into roll; capped by normal force, so no wall-climbing traction.
    this.contactFriction = BallPlayer.ROLL_FRICTION;
    // Static friction (stiction): the ball stays put on slopes gentler than the
    // breakaway angle atan(STATIC_FRICTION) and only slides/rolls once past it.
    this.staticFriction = BallPlayer.STATIC_FRICTION;
    // Light damp: rolling resistance comes from the Coulomb model, not the
    // historical 0.98 contact damp.
    this.contactDamp = 0.99;
    // Small bounce on impact — a cast-iron ball is not perfectly dead.
    this.restitution = 0.15;
  }

  get radius(): number {
    const shape = this.getShape().shape;
    return shape.kind === "circle" ? shape.radius : 0;
  }

  get chainAnchored(): boolean {
    return this.chain !== null && this.hookInFlight === null;
  }

  // The chain deploys from a fixed material point on the rim — the "loop",
  // at the top of the ball when unrotated. Aiming rotates the ball so the
  // loop faces the aim direction; the shot always leaves through the loop.
  get loopDirection(): Vec2 {
    return new Vec2(0, -1).rotated(this.globalRotation);
  }

  // The loop ring's centre in the ball's local frame (top of the ball at
  // rotation 0). Mounts the loop's collision circle; rotates with the ball.
  get loopLocalOffset(): Vec2 {
    return new Vec2(0, -(this.radius + BallPlayer.LOOP_GAP));
  }

  // The loop ring's centre in world space (shared by physics and rendering).
  get loopCenter(): Vec2 {
    return this.globalPosition.add(this.loopDirection.mul(this.radius + BallPlayer.LOOP_GAP));
  }

  resolveInput(input: FrameInput): void {
    // Aim steering: rotate the ball so the loop faces the aim point — also
    // with the chain out (winding it around the ball). An aim point at the
    // ball's centre means "not aiming" (stick released — see BallInputSource),
    // which leaves rotation to the physics. The steering overwrites this
    // frame's angular velocity; the chain solver's corrections still land on
    // top of it afterwards.
    const toAim = input.mouseWorldPosition.sub(this.globalPosition);
    const aiming = toAim.lengthSquared() > PX * PX;
    // Speed-faded braking while aiming; symmetric friction otherwise. Full grip
    // at rest, decaying exponentially with speed toward the floor — grippy at
    // low/medium speed, sliding once fast.
    let brake = 1;
    if (aiming) {
      const speed = this.linearVelocity.length();
      brake =
        BallPlayer.AIM_BRAKE_MIN +
        (1 - BallPlayer.AIM_BRAKE_MIN) * Math.exp(-speed / BallPlayer.AIM_BRAKE_DECAY_SPEED);
    }
    this.contactBrakeScale = brake;
    // While aiming, the steering below drives rotation kinematically. Flag it so
    // ground contacts stop pouring their friction impulse into angular velocity
    // (which this line would overwrite anyway) and instead brake the linear
    // slide — otherwise a ball balanced on its loop coasts sideways forever.
    this.kinematicRotation = aiming;
    if (aiming) {
      const delta = wrapAngle(toAim.angle() - this.loopDirection.angle());
      this.angularVelocity = delta * BallPlayer.AIM_TURN_GAIN;
    }

    // Hold-to-keep: press shoots, release lets go (matches the grapple
    // controller's fire semantics).
    if (input.fire.pressed && !this.chain) this.shoot();
    if (input.fire.released) this.releaseChain();
  }

  // Called after the hook has flown this frame. Two triggers convert the
  // flying hook into the dangling chain tip: reaching the absolute max length
  // (a missed throw), or the deploying chain snagging on scene geometry — it
  // wraps the corner and the deploy stops there.
  checkChainReach(bodies: PhysicsBody2D[]): void {
    if (!this.hookInFlight || !this.chain) return;
    const len = this.chain.getCurrentLength();
    if (len > BallPlayer.CHAIN_MAX_LENGTH) {
      this.deployTip(BallPlayer.CHAIN_MAX_LENGTH);
    } else if (this.chain.detectSceneCatch(bodies, this)) {
      // Snagged mid-flight: the wrap node is now in the chain, so freeze at the
      // wrapped path length (longer than the straight span was).
      this.deployTip(this.chain.getCurrentLength());
    }
  }

  // The chain has stopped paying out mid-flight (hit max, or snagged on scene
  // geometry): from here the hook is the chain tip — the rope
  // solver takes over (dangle, swing, get reeled in) — but it stays armed and
  // still anchors to the first surface it touches. `targetLength` is the
  // length to freeze at.
  private deployTip(targetLength: number): void {
    const hook = this.hookInFlight;
    const chain = this.chain;
    if (!hook || !chain) return;

    // Pull any overshoot back along the final span so the deployed length is
    // exactly targetLength.
    const lastWrap = chain.wraps[chain.wraps.length - 1];
    const prevPos = lastWrap ? lastWrap.contact.globalPosition : chain.start.contact.globalPosition;
    const overshoot = chain.getCurrentLength() - targetLength;
    if (overshoot > 0) {
      hook.globalPosition = hook.globalPosition.add(
        hook.globalPosition.directionTo(prevPos).mul(overshoot),
      );
    }
    // Strip the outward radial velocity: the chain is taut, so integration
    // must not stretch it past target again this frame (the tangential
    // remainder becomes the swing).
    const outward = prevPos.directionTo(hook.globalPosition);
    const vr = hook.linearVelocity.dot(outward);
    if (vr > 0) hook.linearVelocity = hook.linearVelocity.sub(outward.mul(vr));

    this.chainTip = hook;
    this.hookInFlight = null;
    chain.maxRopeLength = targetLength;
  }

  private shoot(): void {
    // The shot leaves through the loop, wherever the ball is facing.
    const dir = this.loopDirection;
    const muzzle = this.globalPosition.add(dir.mul(this.radius));
    const hook = new BallHook();
    hook.globalPosition = muzzle;
    // Launch speed along the loop direction.
    hook.linearVelocity = dir.mul(BallPlayer.HOOK_SPEED);
    hook.addCollisionExceptionWith(this);
    this.hookInFlight = hook;
    this.spawnBody?.(hook);

    // Chain origin on the ball's edge, in the ball's local frame — it rotates
    // with the ball.
    this.chain = new Rope(
      new RopeContact(this, dir.mul(this.radius)),
      new RopeContact(hook, Vec2.ZERO),
      [],
      null,
    );
    hook.registerAttachmentCallback((body, point) => {
      this.hookInFlight = null;
      this.chainTip = null;
      if (!this.chain) return;
      if (body instanceof ImpermeableBody) {
        // Hook-proof surface: the chain is lost.
        this.releaseChain();
        return;
      }
      this.chain.end = new RopeAttachment(
        new RopeContact(body, point.sub(body.globalPosition)),
      );
      // Regenerate wraps now so the length below is the true wrapped path. The
      // solver (chain.physicsStep) will wrap it this same frame regardless; if we
      // measured the straight span here, clamping to it would leave the wrapped
      // path over max and the solve would dump the difference into the ball as a
      // one-frame lurch (session-116f: a 0.9 m/s kick off a resting ball).
      this.chain.syncWraps(this.sceneBodies);
      const len = this.chain.getCurrentLength();
      if (len > BallPlayer.CHAIN_MAX_LENGTH + BallPlayer.ATTACH_SNAP_TOLERANCE) {
        // Attached far beyond the chain's absolute length — snap instead of
        // letting the solver yank the ball toward a too-far anchor.
        this.releaseChain();
        return;
      }
      const target = Math.min(len, BallPlayer.CHAIN_MAX_LENGTH);
      // A dangling tip anchors a few px past target (it was swinging outward and
      // swept slightly beyond max before the solver caught it). Absorb that
      // overshoot here, exactly as deployTip does for a mid-air freeze — else
      // the length solver dumps it into the ball in one frame the instant the
      // anchor goes rigid, a hard forward lurch (found via session-922f).
      this.settleAnchorOvershoot(target);
      this.chain.maxRopeLength = target;
    });
  }

  // Pull the freshly-set anchor in along the final span so the chain path is
  // exactly `targetLength`, and strip the ball's outward radial velocity — the
  // anchor counterpart to deployTip's overshoot handling. Keeping the ball put
  // (only the anchor point moves) means the constraint is already satisfied
  // when it goes rigid, so no one-frame correction is dumped into the ball.
  private settleAnchorOvershoot(targetLength: number): void {
    const chain = this.chain;
    if (!chain) return;
    const overshoot = chain.getCurrentLength() - targetLength;
    if (overshoot <= 0) return;

    const end = chain.end.contact;
    const lastWrap = chain.wraps[chain.wraps.length - 1];
    const prevPos = lastWrap
      ? lastWrap.contact.globalPosition
      : chain.start.contact.globalPosition;
    const anchorPos = end.globalPosition;
    const pulled = anchorPos.add(anchorPos.directionTo(prevPos).mul(overshoot));
    chain.end = new RopeAttachment(new RopeContact(end.obj, pulled.sub(end.obj.globalPosition)));

    // Remove the component of the ball's velocity that points away from the
    // chain (it would stretch the first span past the length just set).
    const firstWrap = chain.wraps[0];
    const nextPos = firstWrap ? firstWrap.contact.globalPosition : chain.end.contact.globalPosition;
    const outward = nextPos.directionTo(this.globalPosition);
    const vr = this.linearVelocity.dot(outward);
    if (vr > 0) this.linearVelocity = this.linearVelocity.sub(outward.mul(vr));
  }

  releaseChain(): void {
    if (this.hookInFlight) this.hookInFlight.world?.remove(this.hookInFlight);
    if (this.chainTip) this.chainTip.world?.remove(this.chainTip);
    this.hookInFlight = null;
    this.chainTip = null;
    this.chain = null;
  }
}
