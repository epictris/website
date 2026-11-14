// A shelter's front wall (`ShelterData`): the wall of an enclosed cave that
// stands between the camera and the play space, put back for the sun alone.
//
// WHY THE SUN NEEDS IT. The level's sun shines from the camera's side
// (`sunZ` < 0 travels away from the camera), and a cave in a side-on level is
// drawn cut open on exactly that side, so the player can be seen in it. With
// the cut-away wall gone nothing stands between the sun and the rock faces
// that face the camera, or the cave's back wall: they take full daylight, and
// the cave reads as an alcove in a sunlit cliff instead of somewhere enclosed.
// Putting the wall back, invisible, gives the sun what a real cave gives it - a
// wall to cast a shadow from - and nothing else changes: the fill, the
// environment and the fog, the cave's blue-grey air, light it as before, and
// the shadow map does the rest, the ball and its chain included.
//
// HOW IT STAYS INVISIBLE: by material. It writes neither colour nor depth, so
// every pass that draws it - the view, the reflection probe's cube, the depth
// of field's - draws nothing; the shadow pass draws it with three's own depth
// material, which does not copy either flag, so it writes the shadow map like
// any rock. Raycasts pass through it (`raycast` is a no-op), so the editor's
// clicks reach what is behind it.
//
// It could not be done by LAYER (2026-11-14, tried first): three tests a
// caster's layers against the VIEW camera's in the shadow pass
// (`WebGLShadowMap.renderObject(object, camera, shadowCamera, ...)`), not the
// shadow camera's, so a wall on a layer the view does not see casts nothing -
// the render with it was identical to the render without.
//
// Every light's shadow sees it, not only the sun's. That is the wall being a
// wall: a lamp in the cave stands behind it, as does everything the lamp
// lights, so it never comes between them; one in front of it would be lit out
// of the cave by it, as a real wall would.
//
// A shadow from a wall `front` in front of the plane lands offset along the
// sun's travel: on the plane, by front / |sunZ| times the sun's (x, y). The
// editor draws that edge (`shelterShadowOffset`) so the wall can be placed
// by where its shadow falls.

import * as THREE from "three";
import { DEFAULT_SHELTER_FRONT, SHELTER_THICKNESS, type ShapeData, type ShelterData } from "../level/levelFormat";
import { outlineOfData } from "../render/shapePath";

// A circle as a polygon: 48 sides are within 0.2% of the radius.
const CIRCLE_SIDES = 48;

// The outline of a shape in its own frame (sim: +y down), or null for one
// that encloses nothing.
function localOutline(shape: ShapeData): { x: number; y: number }[] | null {
  if (shape.kind === "rect") {
    const hx = shape.w / 2;
    const hy = shape.h / 2;
    return [{ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy }];
  }
  if (shape.kind === "circle") {
    return Array.from({ length: CIRCLE_SIDES }, (_, i) => {
      const a = (i / CIRCLE_SIDES) * Math.PI * 2;
      return { x: Math.cos(a) * shape.r, y: Math.sin(a) * shape.r };
    });
  }
  if (shape.kind === "poly") {
    const o = outlineOfData(shape);
    return o.kind === "poly" && o.verts.length >= 3 ? o.verts.map((v) => ({ x: v.x, y: v.y })) : null;
  }
  return null;
}

// One shelter's outline in three's frame: placed as every authored shape is
// (`Vec2.rotated`), y flipped into three's (`threeY`). Null for a shape that
// encloses nothing.
export function placedOutline(s: ShelterData): THREE.Vector2[] | null {
  const local = localOutline(s.shape);
  if (!local) return null;
  const c = Math.cos(s.rot);
  const n = Math.sin(s.rot);
  return local.map((p) => new THREE.Vector2(s.x + p.x * c - p.y * n, -(s.y + p.x * n + p.y * c)));
}

// One shelter's wall as a mesh: its outline extruded from `front` toward the
// camera by SHELTER_THICKNESS.
function wallOf(s: ShelterData, material: THREE.Material): THREE.Mesh | null {
  const points = placedOutline(s);
  if (!points) return null;
  const outline = new THREE.Shape(points);
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: SHELTER_THICKNESS, bevelEnabled: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "shelter-wall";
  mesh.position.z = s.front ?? DEFAULT_SHELTER_FRONT;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

// A level's shelter walls, in one group to add beside its bodies and dispose
// with them.
export class ShelterWalls {
  readonly root = new THREE.Group();
  // Both sides cast: the wall is a closed solid, but which faces the shadow
  // pass draws is three's choice by material side, and a sun seen from the
  // wall's far side must still be stopped by it.
  private readonly material = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    colorWrite: false,
    depthWrite: false,
  });

  constructor(shelters: readonly ShelterData[]) {
    this.root.name = "shelter-walls";
    for (const s of shelters) {
      const wall = wallOf(s, this.material);
      if (wall) this.root.add(wall);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const child of this.root.children) (child as THREE.Mesh).geometry.dispose();
    this.root.clear();
    this.material.dispose();
  }
}

// Where a wall's shadow lands on the play plane, relative to the wall's own
// outline, in sim metres: along the sun's travel by front / |sunZ|. Null when
// the sun never reaches the plane through the wall (no sun, or one that does
// not travel away from the camera).
export function shelterShadowOffset(
  front: number,
  sun: { x: number; y: number; z: number } | null,
): { x: number; y: number } | null {
  if (!sun || !(sun.z < -1e-6)) return null;
  const t = front / -sun.z;
  return { x: sun.x * t, y: sun.y * t };
}
