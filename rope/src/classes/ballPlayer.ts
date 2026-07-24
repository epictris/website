// BallPlayer — the ball & chain character controller. Unlike Player (a
// CharacterBody2D driven by a state machine), the ball is a plain RigidBody2D:
// gravity, rolling and chain tension are the only things that move it. The
// chain reuses the Rope wrap solver — its start contact is a point on the
// ball's EDGE, stored in the ball's local frame, so it rotates with the ball
// and the chain can wind around the ball itself; chain tension applied at the
// edge torques the ball (the rope solver's lever-arm path, which Player
// deliberately bypasses).

import { Vec2 } from "../engine/vec2";
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
  static readonly CHAIN_MAX_LENGTH = 300;
  static readonly REEL_RATE = 2; // px/frame while reeling in
  static readonly HOOK_SPEED = 1200; // px/s launch speed (gravity arcs the flight)
  // Attachments longer than max by more than this snap the chain; within it
  // they clamp to max instead. Must cover the dangling state's solver
  // tolerance (~1 px over) — a deployed tip that finally lands attaches at
  // slightly over max and must NOT snap (found via session-1565f).
  static readonly ATTACH_SNAP_TOLERANCE = 20;
  // Proportional gain steering the loop toward the aim direction (1/s).
  // Stable at 1/60 while gain*dt < 1.
  static readonly AIM_TURN_GAIN = 15;
  // Coulomb coefficient for ground contact. Friction that DRIVES the ball
  // (the steered spin gripping the ground) always applies in full, so aiming
  // kicks and crawls the ball at any speed. Friction that would BRAKE the
  // ball fades with speed while aiming: full at crawl speeds ("aiming has
  // real friction"), nearly gone when moving fast (reorienting mid-roll keeps
  // the momentum).
  static readonly ROLL_FRICTION = 0.8;
  static readonly AIM_BRAKE_FULL_SPEED = 15; // px/s — full braking below this
  static readonly AIM_BRAKE_FADE_SPEED = 60; // px/s — braking at its floor beyond this
  static readonly AIM_BRAKE_MIN = 0.05; // braking fraction remaining at high speed

  chain: Rope | null = null;
  hookInFlight: BallHook | null = null;
  // Free chain end after a miss: the hook disarms in place and lives on as a
  // dangling tip weight — the chain stays deployed at max length until reeled
  // or released.
  chainTip: BallHook | null = null;
  private reeling = false; // reel button held this frame (set in resolveInput)
  spawnBody: ((body: PhysicsBody2D) => void) | null = null;

  constructor(radius = 8) {
    super();
    // KillZone reset and the hook's don't-attach-to-the-avatar check both
    // match by name.
    this.name = "Player";
    this.setShape(circleShape(radius));
    this.mass = ShapeGeometry.computeMass(this.getShape());
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.getShape(), this.mass);
    // Coulomb friction coefficient — ground contact gradually converts slide
    // into roll; capped by normal force, so no wall-climbing traction.
    this.contactFriction = BallPlayer.ROLL_FRICTION;
    // Light damp: rolling resistance comes from the Coulomb model, not the
    // historical 0.98 contact damp.
    this.contactDamp = 0.99;
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

  resolveInput(input: FrameInput): void {
    // Aim steering: rotate the ball so the loop faces the aim point — also
    // with the chain out (winding it around the ball). An aim point at the
    // ball's centre means "not aiming" (stick released — see BallInputSource),
    // which leaves rotation to the physics. The steering overwrites this
    // frame's angular velocity; the chain solver's corrections still land on
    // top of it afterwards.
    const toAim = input.mouseWorldPosition.sub(this.globalPosition);
    const aiming = toAim.lengthSquared() > 1;
    // Speed-faded braking while aiming; symmetric friction otherwise.
    let brake = 1;
    if (aiming) {
      const speed = this.linearVelocity.length();
      const t = Math.min(
        1,
        Math.max(
          0,
          (speed - BallPlayer.AIM_BRAKE_FULL_SPEED) /
            (BallPlayer.AIM_BRAKE_FADE_SPEED - BallPlayer.AIM_BRAKE_FULL_SPEED),
        ),
      );
      brake = 1 - t * (1 - BallPlayer.AIM_BRAKE_MIN);
    }
    this.contactBrakeScale = brake;
    if (aiming) {
      const delta = wrapAngle(toAim.angle() - this.loopDirection.angle());
      this.angularVelocity = delta * BallPlayer.AIM_TURN_GAIN;
    }

    // Hold-to-keep: press shoots, release lets go (matches the grapple
    // controller's fire semantics).
    if (input.fire.pressed && !this.chain) this.shoot();
    if (input.fire.released) this.releaseChain();

    // Reel is held? Record it for checkChainReach (which runs post-integrate).
    // Anchored: shortens the chain. Still deploying: cuts the deploy short —
    // freezes the chain at its current length instead of reeling it in.
    this.reeling = input.retract.held;
    if (this.chainAnchored && this.chain && this.reeling) {
      this.chain.retract(BallPlayer.REEL_RATE);
    }
  }

  // Called after the hook has flown this frame. Three triggers convert the
  // flying hook into the dangling chain tip: reaching the absolute max length
  // (a missed throw), the player reeling while it is still deploying (cut the
  // deploy short and hold the current length), or the deploying chain snagging
  // on scene geometry — it wraps the corner and the deploy stops there.
  checkChainReach(bodies: PhysicsBody2D[]): void {
    if (!this.hookInFlight || !this.chain) return;
    const len = this.chain.getCurrentLength();
    if (len > BallPlayer.CHAIN_MAX_LENGTH) {
      this.deployTip(BallPlayer.CHAIN_MAX_LENGTH);
    } else if (this.reeling) {
      this.deployTip(len);
    } else if (this.chain.detectSceneCatch(bodies, this)) {
      // Snagged mid-flight: the wrap node is now in the chain, so freeze at the
      // wrapped path length (longer than the straight span was).
      this.deployTip(this.chain.getCurrentLength());
    }
  }

  // The chain has stopped paying out mid-flight (hit max, or the player cut
  // it short by reeling): from here the hook is the chain tip — the rope
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
