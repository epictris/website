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
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeContact } from "../lib/ropeContact";
import type { FrameInput } from "../input/frameInput";
import { Rope } from "./rope";
import { Hook } from "./hook";

export class BallPlayer extends RigidBody2D {
  // Absolute maximum chain length: pay-out stops here, a hook still flying at
  // this length has missed, and an attachment beyond it snaps the chain.
  static readonly CHAIN_MAX_LENGTH = 300;
  static readonly REEL_RATE = 2; // px/frame while reeling in
  static readonly PAY_OUT_RATE = 2; // px/frame while paying out
  static readonly TUG_AMOUNT = 4; // px per tug press, matching Player's retract-tug
  static readonly HOOK_SPEED = 20; // px/frame, matches the grapple hook
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
  hookInFlight: Hook | null = null;
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

    if (this.chainAnchored && this.chain) {
      // Sharp tug: one-shot retract burst, the solver turns the sudden
      // length deficit into an impulse toward the anchor.
      if (input.retractClick.pressed) this.chain.retract(BallPlayer.TUG_AMOUNT);
      if (input.retract.held) this.chain.retract(BallPlayer.REEL_RATE);
      if (input.extend.held) {
        this.chain.maxRopeLength = Math.min(
          this.chain.maxRopeLength + BallPlayer.PAY_OUT_RATE,
          BallPlayer.CHAIN_MAX_LENGTH,
        );
      }
    }
  }

  // Called after the hook has flown this frame: a hook still unattached past
  // the chain's absolute length has missed — the chain snaps back.
  checkChainReach(): void {
    if (
      this.hookInFlight &&
      this.chain &&
      this.chain.getCurrentLength() > BallPlayer.CHAIN_MAX_LENGTH
    ) {
      this.releaseChain();
    }
  }

  private shoot(): void {
    // The shot leaves through the loop, wherever the ball is facing.
    const dir = this.loopDirection;
    const muzzle = this.globalPosition.add(dir.mul(this.radius));
    const hook = new Hook();
    hook.globalPosition = muzzle;
    hook.velocity = dir.mul(BallPlayer.HOOK_SPEED);
    hook.addCollisionExceptionWith(this);
    hook.onDestroyed(() => {
      this.chain = null;
      this.hookInFlight = null;
    });
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
    // Runs after the Rope's own attachment callback (which re-anchors the end
    // and grows maxRopeLength to the settled path length).
    hook.registerAttachmentCallback(() => {
      this.hookInFlight = null;
      if (this.chain && this.chain.getCurrentLength() > BallPlayer.CHAIN_MAX_LENGTH) {
        // Attached beyond the chain's absolute length — snap instead of
        // letting the solver yank the ball toward a too-far anchor.
        this.releaseChain();
      }
    });
  }

  releaseChain(): void {
    if (this.hookInFlight) this.hookInFlight.world?.remove(this.hookInFlight);
    this.hookInFlight = null;
    this.chain = null;
  }
}
