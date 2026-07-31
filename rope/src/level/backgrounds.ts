// Scene backgrounds - an authored decoration panel, resolved against the bodies
// the level was built from.
//
// A panel is pure decoration and stays pure decoration: nothing collides with
// it, the rope never wraps it, no force reaches through it and the sim never
// sees it (which is why it is its own list rather than a pass-through
// `BodyKind`). What resolving adds is the one thing decoration could not say
// before - WHICH body it belongs to. A panel tagged into a compound group
// (`BackgroundData.group`, the same tag its bodies carry) is drawn in that
// group's engine body's frame, so a backdrop welded to a rigid assembly swings,
// falls and turns with it.
//
// The conversion happens exactly once, here, for the reason chains convert their
// anchors here: a group's origin is its combined centre of mass, which moves as
// pieces are added, so the file authors a WORLD placement and the loader turns
// it into the offset and angle the body actually carries.
//
// An untagged panel - which is every panel authored before the field - resolves
// to `body: null` and is drawn exactly where it says it is, so nothing about an
// existing level changes.

import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D } from "../engine/body";
import type { BackgroundData } from "./levelFormat";

export interface SceneBackground {
  // The authored panel (metres): shape, colour and opacity. The placement in it
  // is the authored world one, and stays the answer for an unattached panel.
  readonly data: BackgroundData;
  // The body this panel rides, or null for decoration fixed in the world.
  readonly body: CollisionObject2D | null;
  // Placement in that body's frame - meaningless when `body` is null.
  readonly localPos: Vec2;
  readonly localRot: number;
}

// Where a panel is drawn this render frame, in world metres. An attached panel
// is resolved against the body's INTERPOLATED transform, not its sim transform:
// every other piece of derived geometry (the rope's wrap nodes, the ball's loop)
// is drawn that way, and a backdrop tracking the 60 Hz pose while the body it is
// bolted to draws interpolated would visibly detach from it between steps.
export function backgroundTransform(
  g: SceneBackground,
  alpha: number,
): { pos: Vec2; rot: number } {
  if (!g.body) return { pos: new Vec2(g.data.x, g.data.y), rot: g.data.rot };
  const rot = g.body.renderRotation(alpha);
  return { pos: g.body.renderPosition(alpha).add(g.localPos.rotated(rot)), rot: rot + g.localRot };
}

// Resolve every panel in `data` (metres) against the bodies `buildLevelBodies`
// made. A tag no body carries is not an error - a group of panels and nothing
// else is a legitimate thing to author, and so is a group whose bodies have been
// deleted - it simply leaves the panel where it was authored.
export function buildSceneBackgrounds(
  backgrounds: readonly BackgroundData[],
  byGroup: ReadonlyMap<string, CollisionObject2D>,
): SceneBackground[] {
  return backgrounds.map((g) => {
    const body = (g.group !== undefined ? byGroup.get(g.group) : undefined) ?? null;
    if (!body) return { data: g, body: null, localPos: Vec2.ZERO, localRot: 0 };
    const rot = body.globalRotation;
    return {
      data: g,
      body,
      localPos: new Vec2(g.x - body.globalPosition.x, g.y - body.globalPosition.y).rotated(-rot),
      localRot: g.rot - rot,
    };
  });
}
