// Player — the grappling character controller, ported from classes/Player.cs.
// A CharacterBody2D whose behaviour is delegated to a PlayerState machine.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { CharacterBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeContact, RopeWrap } from "../lib/ropeContact";
import type { FrameInput } from "../input/frameInput";
import { Rope } from "./rope";
import { Hook } from "./hook";
import { AirborneState } from "./states/airborneState";
import type { PlayerState } from "./states/playerState";

export class InputBuffer {
  activeFrames: number | null = null;

  activate(): void {
    if (this.activeFrames === null) this.activeFrames = 0;
  }
  deactivate(): void {
    this.activeFrames = null;
  }
  tick(): void {
    if (this.activeFrames !== null) this.activeFrames++;
  }
  get framesSinceActivation(): number | null {
    return this.activeFrames;
  }
  get isActive(): boolean {
    return this.activeFrames !== null;
  }
}

interface ButtonLike {
  pressed: boolean;
  released: boolean;
}

export class PlayerInputs {
  moveLeft = new InputBuffer();
  moveRight = new InputBuffer();
  jump = new InputBuffer();
  retract = new InputBuffer();
  extend = new InputBuffer();

  tick(input: FrameInput): void {
    PlayerInputs.apply(this.moveLeft, input.moveLeft);
    PlayerInputs.apply(this.moveRight, input.moveRight);
    PlayerInputs.apply(this.jump, input.jump);
    PlayerInputs.apply(this.retract, input.retract);
    PlayerInputs.apply(this.extend, input.extend);
  }

  private static apply(buffer: InputBuffer, button: ButtonLike): void {
    buffer.tick();
    if (button.pressed) buffer.activate();
    if (button.released) buffer.deactivate();
  }
}

export class Player extends CharacterBody2D {
  static readonly MAX_CANNON_CHARGE_FRAMES = 60;
  static readonly GROUND_FRICTION = 0.2;
  static readonly WALL_FRICTION = 0.3;
  static readonly WALL_SLIDE_SPEED = 1;
  static readonly MAX_GROUND_SPEED = 5;
  static readonly MAX_AIR_SPEED = 3;
  static readonly GROUND_ACCELERATION = 0.32;
  static readonly AIR_ACCELERATION = 0.1;
  static readonly JUMP_FORCE = 5;
  static readonly JUMP_BUFFER_FRAMES = 20;
  static readonly TERMINAL_VELOCITY = 7;
  static readonly COYOTE_BUFFER_FRAMES = 5;
  static readonly COM_OFFSET_RATE = 1;
  static readonly COM_OFFSET_MAX = 8;

  coyoteBufferFrames = 0;
  xInputDirection = 0;
  radialCoMOffset = Player.COM_OFFSET_MAX;
  previousFrameVelocity = Vec2.ZERO;

  inputs = new PlayerInputs();
  rope: Rope | null = null;
  spawnBody: ((body: PhysicsBody2D) => void) | null = null;
  stateChanged: ((state: PlayerState) => void) | null = null;

  state: PlayerState = new AirborneState();

  constructor(radius = 5) {
    super();
    this.name = "Player";
    if (!this.hasShape()) this.setShape(circleShape(radius));
  }

  get mass(): number {
    return ShapeGeometry.computeMass(this.getShape());
  }
  get inertia(): number {
    return ShapeGeometry.computeMomentOfInertia(this.getShape(), this.mass);
  }

  resolveMouseActions(input: FrameInput): void {
    if (input.fire.pressed && this.rope === null) {
      const hook = new Hook();
      hook.globalPosition = this.globalPosition;
      hook.velocity = this.globalPosition.directionTo(input.mouseWorldPosition).mul(20);
      hook.addCollisionExceptionWith(this);
      hook.onDestroyed(() => {
        this.rope = null;
      });
      this.spawnBody?.(hook);
      this.rope = new Rope(
        new RopeContact(this, Vec2.UP.mul(5)),
        new RopeContact(hook, Vec2.ZERO),
        [] as RopeWrap[],
        null,
      );
    }

    if (input.fire.released) this.rope = null;
    if (input.retractClick.pressed) this.rope?.retract(4);
  }

  resolveInput(input: FrameInput, delta: number): void {
    this.inputs.tick(input);

    if (this.inputs.retract.isActive) this.rope?.retract(2);

    if (this.inputs.extend.isActive) {
      this.radialCoMOffset = Mathf.max(
        this.radialCoMOffset - Player.COM_OFFSET_RATE,
        -Player.COM_OFFSET_MAX,
      );
    } else {
      this.radialCoMOffset = Mathf.min(
        this.radialCoMOffset + Player.COM_OFFSET_RATE,
        Player.COM_OFFSET_MAX,
      );
    }

    this.xInputDirection =
      (this.inputs.moveRight.isActive ? 1 : 0) - (this.inputs.moveLeft.isActive ? 1 : 0);

    let next = this.state.update(this, delta);
    if (next !== this.state) {
      this.state.exit(this, delta);
      this.state = next;
      this.state.enter(this, delta);
      this.stateChanged?.(this.state);
    }

    next = this.state.resolveCollision(this, delta);
    if (next !== this.state) {
      this.state.exit(this, delta);
      this.state = next;
      this.state.enter(this, delta);
      this.stateChanged?.(this.state);
    }
  }
}
