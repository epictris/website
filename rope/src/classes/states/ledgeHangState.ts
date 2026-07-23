// LedgeHangState, ported from classes/PlayerStates/LedgeHangState.cs.
// Extended for mobile shapes (game-design.md): the hang tracks the grabbed
// vertex in body-local space and re-verifies reachability every frame — a
// corner whose top face rotates past the floor/wall threshold releases the
// player with the surface's contact-point velocity.

import { Vec2 } from "../../engine/vec2";
import type { PhysicsBody2D } from "../../engine/body";
import { ShapeGeometry } from "../../lib/shapeGeometry";
import { Surface } from "../../lib/surface";
import { SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { LedgeClimbState } from "./ledgeClimbState";

export class LedgeHangState extends PlayerState {
  surfaceNormal: Vec2;
  ledgePosition: Vec2;
  body: PhysicsBody2D | null;
  vertexIndex: number;
  private localGrab: Vec2 = Vec2.ZERO;
  private localPlayerOffset: Vec2 = Vec2.ZERO;

  constructor(
    ledgePosition: Vec2 = Vec2.ZERO,
    surfaceNormal: Vec2 = Vec2.ZERO,
    body: PhysicsBody2D | null = null,
    vertexIndex = -1,
  ) {
    super();
    this.ledgePosition = ledgePosition;
    this.surfaceNormal = surfaceNormal;
    this.body = body;
    this.vertexIndex = vertexIndex;
  }

  private get tracksMobileBody(): boolean {
    return (this.body?.isMobile ?? false) && this.vertexIndex >= 0;
  }

  enter(player: Player, _delta: number): void {
    if (!this.tracksMobileBody || !this.body) return;
    // Capture body-local anchors once so the hang follows the mover.
    const rot = this.body.globalRotation;
    this.localGrab = this.ledgePosition.sub(this.body.globalPosition).rotated(-rot);
    this.localPlayerOffset = player.globalPosition.sub(this.body.globalPosition).rotated(-rot);
  }

  update(player: Player, _delta: number): PlayerState {
    if (this.tracksMobileBody && this.body) {
      if (this.body.removed) return new AirborneState();
      const rot = this.body.globalRotation;
      this.ledgePosition = this.body.globalPosition.add(this.localGrab.rotated(rot));
      player.globalPosition = this.body.globalPosition.add(this.localPlayerOffset.rotated(rot));

      // Reachability re-verification (game-design.md): the ledge stays
      // grabbable only while a face incident to the vertex classifies as
      // floor. Released hangs launch with the surface's contact velocity.
      const [a, b] = ShapeGeometry.getIncidentFaceNormals(this.body.getShape(), this.vertexIndex);
      const topIsFloor =
        Surface.getSurfaceType(a, this.body.isRotating) === SurfaceType.FLOOR ||
        Surface.getSurfaceType(b, this.body.isRotating) === SurfaceType.FLOOR;
      if (!topIsFloor) {
        player.velocity = this.body.velocityAtPoint(this.ledgePosition);
        return new AirborneState();
      }
    }

    player.velocity = Vec2.ZERO;
    // A taut rope drags the body positionally; hanging can't stay pinned against it.
    if (player.rope?.isTaut === true) return this.release(player);
    if (player.xInputDirection * this.surfaceNormal.x < 0) {
      return new LedgeClimbState(this.ledgePosition, this.surfaceNormal, this.body, this.vertexIndex);
    }
    if (player.xInputDirection * this.surfaceNormal.x > 0) {
      return this.release(player);
    }
    return this;
  }

  // Separation keeps the surface's contact-point velocity (game-design.md).
  private release(player: Player): AirborneState {
    if (this.tracksMobileBody && this.body) {
      player.velocity = this.body.velocityAtPoint(this.ledgePosition);
    }
    return new AirborneState();
  }

  resolveCollision(_player: Player, _delta: number): PlayerState {
    return this;
  }
}
