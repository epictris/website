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
import { Hook } from "../classes/hook";
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

  constructor(data: LevelData) {
    this.ball = new BallPlayer(data.player.radius);
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

    this.ball.resolveInput(input);
    this.bodies = this.bodies.filter((b) => !b.removed);

    // The chain solver runs only once anchored; while the hook is in flight
    // the chain is slack (Rope.physicsStep's unfurl handling is
    // Player-specific, so the ball controller skips it entirely).
    if (this.ball.chainAnchored && this.ball.chain) {
      this.ball.chain.physicsStep(this.bodies, delta);
    }

    // Hooks fly after level logic, mirroring the Player frame order.
    for (const b of this.bodies) {
      if (b instanceof Hook) b.physicsStep();
    }
    this.bodies = this.bodies.filter((b) => !b.removed);
    this.ball.checkChainReach();

    this.world.integrate(delta);

    this.cameraPosition = this.ball.globalPosition;
  }
}
