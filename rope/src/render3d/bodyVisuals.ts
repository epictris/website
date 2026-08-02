// One body's 3D presence, and its per-frame transform sync.
//
// A body is a Group holding one child per collision shape. The group carries the
// body's interpolated pose; the children carry their pieces' local offsets and
// angles, which are rigid within the body and therefore set ONCE at build. That
// is not a micro-optimisation, it is what makes the sync a two-number write per
// body per frame with no allocation at all (see "Allocation per frame" in
// docs/3d-rendering-plan.md).
//
// What a piece looks like is a choice between two answers, and `mountVisual` is
// where it is made - for a collision shape and for a drawn-only shape alike, so
// decoration and geometry cannot end up with two different ideas of what
// `VisualData` means:
//
// - AUTO (the default, and what every shape with no authored visual gets): the
//   shape's own PRIMITIVE - the authored rect, circle or convex loop - extruded
//   through z and wearing a tileable PBR surface. The player then sees exactly
//   what they collide with, which is the property the reference games'
//   silhouettes have and the reason this is the default rather than a fallback.
// - MESH: a GLTF prop from the manifest, replacing the extrusion, riding the
//   piece's frame through the authored offset/rotation/scale. It keeps the
//   materials its own file carries unless the visual names a `texture`, in
//   which case it wears that instead - which is what lets a bare ~20 KB
//   geometry-only export be dressed as the same stone the walls are made of.
// - NONE: nothing at all - an invisible wall.
//
// Interpolation discipline: every transform read here is
// `renderPosition/renderRotation(alpha)`, never raw sim state. A body drawn at
// its 60 Hz pose while the chain welded to it draws interpolated visibly
// detaches between steps, which is the same rule the 2D renderer already keeps.

import * as THREE from "three";

import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { AnchorBody } from "../engine/body";
import { DEFAULT_THICKNESS } from "../lib/shapeGeometry";
import { outlineOfData, outlineOfShape, type Outline } from "../render/shapePath";
import { DECOR_DEPTH, DECOR_Z, decorTransform, type SceneDecor } from "../level/decor";
import type { VisualData } from "../level/levelFormat";
import { DEFAULT_BEVEL, extrudeOutline } from "./extrude";
import { isAuthoredSurface, loadMesh, surfaceFor, surfaceName } from "./assets";
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
  if (s.kind === "circle" && spec === undefined) {
    return new THREE.SphereGeometry(s.radius, 24, 16);
  }
  return primitiveGeometry(outlineOfShape(s), spec);
}

// An authored outline as the solid it stands for: the primitive extruded to the
// thickness the shape's own mass is computed from, so a body is as thick as it
// weighs unless the visual says otherwise.
function primitiveGeometry(
  outline: Outline,
  spec: AuthoredVisual | undefined,
): THREE.BufferGeometry {
  return extrudeOutline(outline, {
    depth: spec?.visual?.depth ?? spec?.thickness ?? DEFAULT_THICKNESS,
    bevel: spec?.visual?.bevel ?? DEFAULT_BEVEL,
  });
}

// The surface an authored entry wears: its texture set (an authored PBR set or a
// generated one), at its tiling scale and offset, tinted by its authored fill
// colour - UNLESS the surface is an authored one.
//
// That exception is the whole reason the tint exists. Levels were authored for a
// flat 2D renderer where a body's colour IS its appearance, so the 3D scene
// keeps that colour as a tint over the generated noise, which has no colour of
// its own worth defending (see TINT_FLOOR). A photographed brick does: its
// albedo is the measured colour of a real wall, and multiplying it by the grey
// somebody typed to tell a flat renderer "this is a wall" makes it darker, less
// saturated and flatter - the exact opposite of what the photograph was added
// for. Naming an authored texture is the author saying what this thing looks
// like, and it outranks the stand-in.
export function surfaceOf(spec: AuthoredVisual | undefined): THREE.MeshStandardMaterial {
  const name = surfaceName(spec?.visual?.texture ?? spec?.material);
  return surfaceFor({
    texture: spec?.visual?.texture,
    material: spec?.material,
    tileScale: spec?.visual?.tileScale,
    offsetX: spec?.visual?.tileOffsetX,
    offsetY: spec?.visual?.tileOffsetY,
    color: isAuthoredSurface(name) ? undefined : tintFor(spec?.color),
  });
}

// What a mounted visual owns and must free. Materials are shared and cached (see
// assets.ts), so they are deliberately not in here.
export interface MountedVisual {
  geometry: THREE.BufferGeometry[];
}

export interface MountOptions {
  // Where the piece sits through z when the visual does not say: the gameplay
  // plane for anything solid, further back for scenery the player passes
  // through.
  defaultZ: number;
  // Whether this piece throws a shadow. Everything receives one.
  castShadow: boolean;
  // A live handle on whether the owner is still around, since a prop arrives
  // asynchronously and may outlive the thing that asked for it.
  alive: () => boolean;
}

// Mount ONE authored shape's look under `parent`, by whichever of the two
// answers the visual names. The single place `VisualData.kind` is cashed out:
// a body's collision piece and a drawn-only shape both come through here, so
// "mesh or primitive" cannot mean two different things depending on which of
// them is asking.
export function mountVisual(
  parent: THREE.Group,
  geometryFor: () => THREE.BufferGeometry,
  spec: AuthoredVisual | undefined,
  opts: MountOptions,
): MountedVisual {
  const kind = spec?.visual?.kind ?? "auto";
  const owned: THREE.BufferGeometry[] = [];
  if (kind === "none") return { geometry: owned };

  const material = surfaceOf(spec);

  if (kind !== "mesh") {
    const geo = geometryFor();
    owned.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = opts.castShadow;
    mesh.receiveShadow = true;
    mesh.position.z = spec?.visual?.offsetZ ?? opts.defaultZ;
    parent.add(mesh);
    return { geometry: owned };
  }

  // A prop replaces the extrusion. Until it arrives the piece shows a neutral
  // placeholder of the shape's own size: an asset that fails to load is then a
  // visibly wrong grey box rather than a hole in the level, and nothing about
  // loading it can block the sim.
  const v = spec!.visual!;
  const holder = new THREE.Group();
  holder.position.set(v.offsetX ?? 0, threeY(v.offsetY ?? 0), v.offsetZ ?? opts.defaultZ);
  holder.rotation.set(v.rotX ?? 0, v.rotY ?? 0, -(v.rotZ ?? 0));
  holder.scale.setScalar(v.scale ?? 1);
  parent.add(holder);

  const geo = geometryFor();
  owned.push(geo);
  const placeholder = new THREE.Mesh(geo, material);
  placeholder.castShadow = opts.castShadow;
  placeholder.receiveShadow = true;
  holder.add(placeholder);

  const key = v.mesh;
  if (!key) return { geometry: owned };
  void loadMesh(key).then((obj) => {
    if (!obj || !opts.alive()) return;
    holder.remove(placeholder);
    // An authored texture is the level saying what this thing is made of, and it
    // outranks whatever the file was exported with - which is the whole point of
    // being able to author one: a bare geometry-only export wears the same
    // surface as the walls around it instead of glTF's default white. A prop
    // that authors no texture keeps its own materials untouched.
    if (v.texture !== undefined) {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = material;
      });
    }
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = opts.castShadow;
      mesh.receiveShadow = true;
    });
    holder.add(obj);
  });
  return { geometry: owned };
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
    // Hook-only scenery sits BEHIND the level it decorates by default, because
    // the player passes straight through it - and its glyph lattice still stamps
    // over it on the 2D overlay, which is what keeps "pass-through geometry
    // reads as pass-through" true in 3D (see docs/game-design.md). Anything else
    // sits on the gameplay plane unless the level says otherwise.
    const defaultZ = body instanceof AnchorBody ? ANCHOR_Z : 0;
    body.getShapes().forEach((shape, i) => {
      const spec = lookup(body, i);
      const piece = new THREE.Group();
      // The piece's placement in the body's frame: rigid, so written once.
      piece.position.set(shape.localOffset.x, threeY(shape.localOffset.y), 0);
      orientTo(piece, shape.localRotation);
      this.root.add(piece);
      const mounted = mountVisual(piece, () => autoGeometry(shape, spec), spec, {
        defaultZ,
        castShadow: true,
        alive: () => !this.disposed,
      });
      this.owned.push(...mounted.geometry);
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

// A drawn-only shape's visual (`LevelBodyData.collision: false`). It has no
// collision shapes of its own, so it is ONE mounted visual - the same "GLB or
// textured primitive" choice every body's piece gets - placed either in the
// world or in the frame of the body it is welded into.
//
// The depth placement is what turns the 2D renderer's flat fill into the
// reference games' parallax: a panel at `offsetZ` -20 m moves across the frame
// at a different rate from the gameplay plane as the camera pans, which is the
// whole of what a "background layer" is in 3D.
export class DecorVisual {
  readonly root = new THREE.Group();
  private readonly owned: THREE.BufferGeometry[] = [];
  private disposed = false;

  constructor(
    readonly decor: SceneDecor,
    spec: AuthoredVisual,
  ) {
    const outline = outlineOfData(decor.data.shape);
    const geometryFor = () =>
      extrudeOutline(outline, {
        depth: spec.visual?.depth ?? DECOR_DEPTH,
        bevel: spec.visual?.bevel ?? 0,
      });
    const mounted = mountVisual(this.root, geometryFor, spec, {
      defaultZ: DECOR_Z,
      // Decoration BEHIND the gameplay plane is backdrop and throws no shadow
      // across the level in front of it - the rule the retired background layer
      // had, kept because the reason is unchanged: a shadow is what makes a
      // shape read as an object in the scene rather than as a painted distance.
      // Decoration on or in front of the plane is an object among objects and
      // casts like one.
      castShadow: (spec.visual?.offsetZ ?? DECOR_Z) >= 0,
      alive: () => !this.disposed,
    });
    this.owned.push(...mounted.geometry);
  }

  sync(alpha: number): void {
    const t = decorTransform(this.decor, alpha);
    placeAt(this.root, t.pos);
    orientTo(this.root, t.rot);
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.root.clear();
  }
}
