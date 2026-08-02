// One body's 3D presence, and its per-frame transform sync.
//
// A body is a Group holding one child per collision shape. The group carries the
// body's interpolated pose; the children carry their pieces' local offsets and
// angles, which are rigid within the body and therefore set ONCE at build. That
// is not a micro-optimisation, it is what makes the sync a two-number write per
// body per frame with no allocation at all (see "Allocation per frame" in
// docs/3d-rendering-plan.md).
//
// What a piece looks like:
//
// - AUTO (the default, and what every body with no authored visual gets): the
//   collision outline extruded through z and textured from the shape's material.
//   The player then sees exactly what they collide with, which is the property
//   the reference games' silhouettes have and the reason this is the default
//   rather than a fallback.
// - MESH: a GLTF prop from the manifest, replacing the extrusion, riding the
//   piece's frame through the authored offset/rotation/scale.
// - NONE: nothing at all - an invisible wall, or a body whose whole look is a
//   background panel welded to it.
//
// Interpolation discipline: every transform read here is
// `renderPosition/renderRotation(alpha)`, never raw sim state. A body drawn at
// its 60 Hz pose while the chain welded to it draws interpolated visibly
// detaches between steps, which is the same rule the 2D renderer already keeps.

import * as THREE from "three";

import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { AnchorBody } from "../engine/body";
import { DEFAULT_THICKNESS } from "../lib/shapeGeometry";
import { outlineOfShape } from "../render/shapePath";
import type { VisualData } from "../level/levelFormat";
import { DEFAULT_BEVEL, extrudeOutline } from "./extrude";
import { loadMesh, tintedSurface } from "./assets";
import { orientTo, placeAt, threeY } from "./space";

// What the level authored for one piece of one body. Assembled by `scene.ts`
// from `LevelData.bodies` zipped with `BuiltBodies`, so a piece knows the entry
// it came from; a body with no authored entry at all (a runtime-spawned rock,
// the sandbox's cannonball) simply gets `undefined` and every default.
export interface AuthoredVisual {
  visual?: VisualData;
  material?: string;
  thickness?: number;
  color?: string;
}

export type VisualLookup = (
  body: CollisionObject2D,
  shapeIndex: number,
) => AuthoredVisual | undefined;

// The floor an authored colour's brightness is lifted to before it tints the
// material. The levels were authored for a flat 2D renderer, where a body's
// colour IS its appearance and most of them are dark greys - so multiplying a
// stone texture by `#000000` leaves a hole where a dark wall is meant to be, and
// the level reads as an unlit cave.
//
// The HUE is kept exactly (a gold ledge stays gold, a green bank stays green)
// and only the lightness is remapped, from 0..1 into TINT_FLOOR..1. That keeps
// the authored ORDERING - a black wall is still darker than a grey one - while
// leaving every surface enough albedo to show its own grain and to respond to
// the sun, which is the whole reason there is a material under the tint.
const TINT_FLOOR = 0.6;

// How far behind the gameplay plane hook-only scenery sits by default: far
// enough to read as background, near enough that the 2D grate lattice drawn over
// it still lands on it.
const ANCHOR_Z = -0.25;

// Scratch for the conversion below: `tintFor` runs at build time rather than per
// frame, but it runs once per body and there is no reason for it to allocate.
const hsl = { h: 0, s: 0, l: 0 };

function tintFor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const c = new THREE.Color(color);
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, TINT_FLOOR + (1 - TINT_FLOOR) * hsl.l);
  return `#${c.getHexString()}`;
}

// A code-built circle is a SPHERE and an authored one is a disc seen face on.
// That is not a rendering choice, it is the same split `lib/shapeGeometry.ts`
// makes about mass: the ball, its hook and the sandbox's rocks are round objects
// and go through `computeMass`'s sphere rule, while authored level geometry is a
// prism `thickness` deep whatever its outline. Drawing them by the same rule is
// what keeps a 4 cm hook from being drawn as a 20 cm slab.
function autoGeometry(
  shape: CollisionShape2D,
  spec: AuthoredVisual | undefined,
): THREE.BufferGeometry {
  const s = shape.shape;
  const authored = spec !== undefined;
  if (s.kind === "circle" && !authored) {
    return new THREE.SphereGeometry(s.radius, 24, 16);
  }
  const depth = spec?.visual?.depth ?? spec?.thickness ?? DEFAULT_THICKNESS;
  return extrudeOutline(outlineOfShape(s), {
    depth,
    bevel: spec?.visual?.bevel ?? DEFAULT_BEVEL,
  });
}

export class BodyVisual {
  readonly root = new THREE.Group();
  // Which frame the world was last seen holding this body. `Scene3D` stamps it
  // and sweeps what it did not stamp, which is how a destroyed hook's visual
  // leaves the scene without every frame paying for a membership search.
  stamp = -1;
  // Geometry this visual owns and must free. Materials are shared and cached
  // (see assets.ts), so they are deliberately NOT in here.
  private readonly owned: THREE.BufferGeometry[] = [];
  private disposed = false;

  constructor(
    readonly body: CollisionObject2D,
    lookup: VisualLookup,
  ) {
    const shapes = body.getShapes();
    shapes.forEach((shape, i) => {
      const spec = lookup(body, i);
      const kind = spec?.visual?.kind ?? "auto";
      if (kind === "none") return;
      const piece = new THREE.Group();
      // The piece's placement in the body's frame: rigid, so written once.
      piece.position.set(shape.localOffset.x, threeY(shape.localOffset.y), 0);
      orientTo(piece, shape.localRotation);
      this.root.add(piece);
      if (kind === "mesh") this.addMesh(piece, shape, spec!);
      else this.addAuto(piece, shape, spec);
    });
  }

  private material(spec: AuthoredVisual | undefined): THREE.Material {
    return tintedSurface(spec?.visual?.texture ?? spec?.material, tintFor(spec?.color));
  }

  private addAuto(
    piece: THREE.Group,
    shape: CollisionShape2D,
    spec: AuthoredVisual | undefined,
  ): void {
    const geo = autoGeometry(shape, spec);
    this.owned.push(geo);
    const mesh = new THREE.Mesh(geo, this.material(spec));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Depth placement. Hook-only scenery sits BEHIND the level it decorates by
    // default, because the player passes straight through it - and its glyph
    // lattice still stamps over it on the 2D overlay, which is what keeps
    // "pass-through geometry reads as pass-through" true in 3D (see
    // docs/game-design.md). Anything else sits on the gameplay plane unless the
    // level says otherwise.
    mesh.position.z =
      spec?.visual?.offsetZ ?? (this.body instanceof AnchorBody ? ANCHOR_Z : 0);
    piece.add(mesh);
  }

  // A prop replaces the extrusion. Until it arrives the piece shows a neutral
  // placeholder of the body's own size: an asset that fails to load is then a
  // visibly wrong grey box rather than a hole in the level, and nothing about
  // loading it can block the sim.
  private addMesh(piece: THREE.Group, shape: CollisionShape2D, spec: AuthoredVisual): void {
    const holder = new THREE.Group();
    const v = spec.visual!;
    holder.position.set(v.offsetX ?? 0, threeY(v.offsetY ?? 0), v.offsetZ ?? 0);
    holder.rotation.set(v.rotX ?? 0, v.rotY ?? 0, -(v.rotZ ?? 0));
    holder.scale.setScalar(v.scale ?? 1);
    piece.add(holder);

    const geo = autoGeometry(shape, spec);
    this.owned.push(geo);
    const placeholder = new THREE.Mesh(geo, this.material(spec));
    placeholder.castShadow = true;
    placeholder.receiveShadow = true;
    holder.add(placeholder);

    const key = v.mesh;
    if (!key) return;
    void loadMesh(key).then((obj) => {
      if (!obj || this.disposed) return;
      holder.remove(placeholder);
      holder.add(obj);
    });
  }

  // The whole per-frame cost of a body: two writes into vectors it already owns.
  sync(alpha: number): void {
    placeAt(this.root, this.body.renderPosition(alpha));
    orientTo(this.root, this.body.renderRotation(alpha));
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.root.clear();
  }
}

// A background panel's visual. A panel is decoration and never a body, so it has
// no shapes of its own - it is one extrusion of its authored outline, placed
// either in the world or in the frame of the body it is welded into.
//
// The depth placement is what turns the 2D renderer's flat fill into the
// reference games' parallax: a panel at `offsetZ` -20 m moves across the frame
// at a different rate from the gameplay plane as the camera pans, which is the
// whole of what "background layer" means in 3D.
export const DEFAULT_BACKGROUND_Z = -0.35;
export const DEFAULT_BACKGROUND_DEPTH = 0.1;

export function backgroundGeometry(v: VisualData | undefined, outline: ReturnType<typeof outlineOfShape>): THREE.BufferGeometry {
  return extrudeOutline(outline, {
    depth: v?.depth ?? DEFAULT_BACKGROUND_DEPTH,
    bevel: v?.bevel ?? 0,
  });
}

export function backgroundZ(v: VisualData | undefined): number {
  return v?.offsetZ ?? DEFAULT_BACKGROUND_Z;
}
