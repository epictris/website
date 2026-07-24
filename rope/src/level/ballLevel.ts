// BallLevel — level driver for the ball & chain controller. Deliberately a
// separate class from Level: the two controllers share nothing beyond the
// arena data, and keeping the Player frame flow untouched preserves its
// recorded replays bit-for-bit.

import { Vec2 } from "../engine/vec2";
import { StaticBody2D, type PhysicsBody2D } from "../engine/body";
import { rectShape, circleShape } from "../engine/shapes";
import { Debug } from "../engine/debug";
import { PhysTrace } from "../engine/physTrace";
import { World } from "../engine/world";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { KillZone } from "../classes/killZone";
import type { FrameInput } from "../input/frameInput";
import type { LevelData } from "./levelData";

export class BallLevel {
  readonly world = new World();
  readonly ball: BallPlayer;
  // All PhysicsBody2D the chain may wrap (ball + statics + hook).
  bodies: PhysicsBody2D[] = [];
  frame = 0;
  cameraPosition = Vec2.ZERO;
  onReset: (() => void) | null = null;

  // The ball plays 1.5× the arena's authored avatar radius — a heftier ball
  // & chain than the grapple avatar, without hand-editing generated levelData.
  static readonly BALL_RADIUS_SCALE = 1.5;

  constructor(data: LevelData) {
    this.ball = new BallPlayer(data.player.radius * BallLevel.BALL_RADIUS_SCALE);
    this.ball.globalPosition = new Vec2(data.player.x, data.player.y);
    this.ball.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.ball);
    this.bodies.push(this.ball);

    for (const b of data.bodies) {
      const shape = b.shape.kind === "rect" ? rectShape(b.shape.w, b.shape.h) : circleShape(b.shape.r);
      if (b.kind === "killzone") {
        const kz = new KillZone(() => this.onReset?.());
        kz.setShape(shape);
        kz.globalPosition = new Vec2(b.x, b.y);
        kz.globalRotation = b.rot;
        this.world.add(kz);
      } else {
        const sb = new StaticBody2D();
        sb.setShape(shape);
        sb.globalPosition = new Vec2(b.x, b.y);
        sb.globalRotation = b.rot;
        this.world.add(sb);
        this.bodies.push(sb);
      }
    }

    this.cameraPosition = this.ball.globalPosition;
  }

  private spawnBody(body: PhysicsBody2D): void {
    this.world.add(body);
    this.bodies.push(body);
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
    Debug.clear();
    PhysTrace.frame = this.frame;

    // Restart (top face button → jump field). Replaces this level instance;
    // bail before touching more of the frame.
    if (input.jump.pressed) {
      this.onReset?.();
      return;
    }

    this.ball.resolveInput(input);
    this.bodies = this.bodies.filter((b) => !b.removed);

    // Armed hooks run their swept attach check before integration moves them.
    for (const b of this.bodies) {
      if (b instanceof BallHook) b.physicsStep(delta);
    }
    this.bodies = this.bodies.filter((b) => !b.removed);

    this.world.integrate(delta);

    // Chain logic runs AFTER integration — the ball is a RigidBody2D, so
    // integration moves it; solving afterwards leaves the frame's final state
    // within the length constraint (solve-then-integrate ended every fast
    // swing frame over-length by |v|·dt). The solver runs only once the chain
    // is fully deployed or anchored; while the hook is in flight the chain is
    // slack (Rope.physicsStep's unfurl handling is Player-specific, so the
    // ball controller skips it entirely).
    this.ball.checkChainReach(this.bodies);
    if (this.ball.chainAnchored && this.ball.chain) {
      this.ball.chain.physicsStep(this.bodies, delta);
    }

    this.cameraPosition = this.ball.globalPosition;
  }
}
