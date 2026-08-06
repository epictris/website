// One body's 3D presence, and its per-frame transform sync.
//
// A body is a Group holding one child per drawn OBJECT. The group carries the
// body's interpolated pose; the children carry their objects' placements in that
// frame, which are rigid within the body and therefore set ONCE at build. That
// is not a micro-optimisation, it is what makes the sync a two-number write per
// body per frame with no allocation at all (see "Allocation per frame" in
// docs/3d-rendering-plan.md).
//
// ONE CLASS FOR EVERY BODY. A wall, a swinging crate, a backdrop 20 m behind the
// plane and a lamp with no fitting are all a body with objects in it, so they
// are all this. What used to be a second class for decoration is now the case
// where the body has no collision objects and therefore built no engine body:
// its root stands at the authored transform instead of tracking one, and
// `sync` has nothing to do. Nothing else about it differs, which is the point -
// a prop, its light and the wall behind it are drawn by one path.
//
// WHAT A BODY LOOKS LIKE is decided by its geometry objects and by NOTHING
// ELSE. A collision object is never drawn and is never read for a form, a
// placement, a depth or a surface: a geometry object states its own, so a body
// can be drawn as something other than what it collides as, which is the whole
// point of there being two kinds of object. A body with no geometry object is
// drawn by nothing at all - a solid, invisible wall, which is a thing a level
// may perfectly well want and which needs no field to say it.
//
// `mountVisual` is where the mesh-or-primitive choice is cashed out, and the one
// remaining case that is not authored at all is a body the SIM spawned (a rock,
// the hook), which has no authored objects and simply extrudes its own shapes.
//
// Interpolation discipline: every transform read here is
// `renderPosition/renderRotation(alpha)`, never raw sim state. A body drawn at
// its 60 Hz pose while the chain welded to it draws interpolated visibly
// detaches between steps, which is the same rule the 2D renderer already keeps.

import * as THREE from "three";

import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { AnchorBody, WaterArea } from "../engine/body";
import { DEFAULT_THICKNESS } from "../lib/shapeGeometry";
import { outlineOfData, outlineOfShape, type Outline } from "../render/shapePath";
import { DECOR_DEPTH, DECOR_Z } from "../level/decor";
import { localPlacement, objectDepth, type BuiltBody } from "../level/buildBodies";
import {
  isCollisionObject,
  isGeometryObject,
  isLightObject,
  type GeometryObjectData,
  type LevelBodyData,
} from "../level/levelFormat";
import { DEFAULT_BEVEL, cylinderSolid, extrudeOutline } from "./extrude";
import { isAuthoredSurface, loadMesh, surfaceFor, surfaceName } from "./assets";
import { buildWater } from "./water";
import { DEFAULT_LIGHT_Z, LightRig, type MountedLight } from "./lights";
import { orientTo, placeAt, threeY } from "./space";

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

// What one drawn thing wears: the object that draws it, and the one thing its
// BODY contributes to how it looks - the fill the level authored, which a
// geometry object may override and usually does not.
export interface DrawSpec {
  // The geometry object, when there is one. A body the sim spawned has none, and
  // is the only thing drawn without one.
  geometry?: GeometryObjectData;
  // The body's own fill, for the tint. A geometry object's own `color` wins.
  color?: string;
}

// What a primitive falls back to where its geometry object says nothing, which
// is a property of the BODY rather than of any collision shape: something solid
// is a slab on the gameplay plane, and something that collides with nothing is
// the thin backdrop a flat fill drawn before every body already was.
interface PrimitiveDefaults {
  depth: number;
  bevel: number;
}

const SOLID_DEFAULTS: PrimitiveDefaults = { depth: DEFAULT_THICKNESS, bevel: DEFAULT_BEVEL };
const DECOR_DEFAULTS: PrimitiveDefaults = { depth: DECOR_DEPTH, bevel: 0 };

// A code-built circle is a SPHERE and an authored one is a disc seen face on.
// That is not a rendering choice, it is the same split `lib/shapeGeometry.ts`
// makes about mass: the ball, its hook and the sandbox's rocks are round objects
// and go through `computeMass`'s sphere rule, while authored level geometry is a
// prism `thickness` deep whatever its outline. Drawing them by the same rule is
// what keeps a 4 cm hook from being drawn as a 20 cm slab.
function spawnedGeometry(shape: CollisionShape2D): THREE.BufferGeometry {
  const s = shape.shape;
  if (s.kind === "circle") return new THREE.SphereGeometry(s.radius, 24, 16);
  return primitiveGeometry(outlineOfShape(s), undefined, SOLID_DEFAULTS);
}

// An authored form as the solid it stands for. A rect is a rectangular prism, a
// circle a cylinder and a polygon that outline extruded, each `depth` thick -
// which is what the geometry object says it is and NOT what the body's collision
// weighs, those having been separate statements since the two objects were.
function primitiveGeometry(
  outline: Outline,
  g: GeometryObjectData | undefined,
  defaults: PrimitiveDefaults,
): THREE.BufferGeometry {
  const depth = g?.depth ?? defaults.depth;
  if (outline.kind === "circle") return cylinderSolid(outline.radius, depth);
  return extrudeOutline(outline, { depth, bevel: g?.bevel ?? defaults.bevel });
}

// The surface a drawn thing wears: its texture set (an authored PBR set or a
// generated one), at its tiling scale and offset, tinted by the authored fill
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
export function surfaceOf(spec: DrawSpec): THREE.MeshStandardMaterial {
  const g = spec.geometry;
  // The geometry object's own `texture` and nothing else. A collision object's
  // `material` is what its MASS is computed from; reading it as a statement
  // about the look is the coupling these two objects exist to keep apart, and a
  // migrated level names the material here explicitly instead.
  const name = surfaceName(g?.texture);
  return surfaceFor({
    texture: g?.texture,
    tileScale: g?.tileScale,
    offsetX: g?.tileOffsetX,
    offsetY: g?.tileOffsetY,
    color: isAuthoredSurface(name) ? undefined : tintFor(g?.color ?? spec.color),
    // Emission is NOT subject to the authored-surface exception above. The tint
    // stands in for a flat renderer's "colour is appearance" and a photographed
    // brick has its own colour to defend; emission is not an appearance at all,
    // it is a statement that this thing is a source, and a photographed brick
    // has no opinion about whether it is on fire.
    emissive: g?.emissive,
    emissiveIntensity: g?.emissiveIntensity,
    emissiveTexture: g?.emissiveTexture,
  });
}

// What a mounted visual owns and must free. Materials are shared and cached (see
// assets.ts), so they are deliberately not in here.
export interface MountedVisual {
  geometry: THREE.BufferGeometry[];
}

export interface MountOptions {
  // Where the thing sits through z, ALREADY composed through the body's own
  // depth: the gameplay plane for anything solid, further back for scenery the
  // player passes through and for a form with no collision behind it.
  defaultZ: number;
  // Whether this throws a shadow. Everything receives one.
  castShadow: boolean;
  // A live handle on whether the owner is still around, since a prop arrives
  // asynchronously and may outlive the thing that asked for it.
  alive: () => boolean;
}

// Mount ONE drawn thing's look under `parent`, by whichever of the three answers
// its geometry object names. The single place `GeometryObjectData.kind` is
// cashed out: a body's own outline and a drawn-only form both come through here,
// so "mesh or primitive" cannot mean two different things depending on which of
// them is asking.
export function mountVisual(
  parent: THREE.Group,
  geometryFor: () => THREE.BufferGeometry,
  spec: DrawSpec,
  opts: MountOptions,
): MountedVisual {
  const g = spec.geometry;
  const kind = g?.kind ?? "primitive";
  const owned: THREE.BufferGeometry[] = [];

  const material = surfaceOf(spec);
  const z = opts.defaultZ;

  if (kind !== "mesh") {
    const geo = geometryFor();
    owned.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = opts.castShadow;
    mesh.receiveShadow = true;
    mesh.position.z = z;
    parent.add(mesh);
    return { geometry: owned };
  }

  // A prop replaces the extrusion. Until it arrives the object shows a neutral
  // placeholder of its own size: an asset that fails to load is then a visibly
  // wrong grey box rather than a hole in the level, and nothing about loading it
  // can block the sim.
  const holder = new THREE.Group();
  holder.position.z = z;
  holder.rotation.set(g?.rotX ?? 0, g?.rotY ?? 0, 0);
  holder.scale.setScalar(g?.scale ?? 1);
  parent.add(holder);

  const geo = geometryFor();
  owned.push(geo);
  const placeholder = new THREE.Mesh(geo, material);
  placeholder.castShadow = opts.castShadow;
  placeholder.receiveShadow = true;
  holder.add(placeholder);

  const key = g?.mesh;
  if (!key) return { geometry: owned };
  void loadMesh(key).then((obj) => {
    if (!obj || !opts.alive()) return;
    holder.remove(placeholder);
    // An authored texture is the level saying what this thing is made of, and it
    // outranks whatever the file was exported with - which is the whole point of
    // being able to author one: a bare geometry-only export wears the same
    // surface as the walls around it instead of glTF's default white. A prop
    // that authors no texture keeps its own materials untouched.
    if (g?.texture !== undefined) {
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

// A unit placeholder for a prop that authors no outline of its own. Small enough
// to read as "something is missing here" rather than as a wall.
const ORPHAN_PLACEHOLDER = 0.3;

// What a body draws, in authored order - its geometry objects and nothing else.
//
// It is a one-line filter and it is exported all the same, because the claim it
// makes is the one this file exists to keep: a collision object never appears in
// this list however bare the body is, so "does a collision shape draw?" can be
// answered without a GPU, a canvas or a DOM, all three of which building a
// `BodyVisual` needs.
export function drawnObjects(data: LevelBodyData): GeometryObjectData[] {
  return data.objects.filter(isGeometryObject);
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
  // The exception: water's material is built per body (it carries the body's
  // own flow and colour in its uniforms), so this visual frees it.
  private readonly ownedMaterials: THREE.Material[] = [];
  // Lights this body's light objects hang on it. Children of the root, so they
  // ride the pose with no per-frame cost; handed back to the rig at dispose,
  // which is what frees the budget slot as well as the objects.
  private readonly lights: MountedLight[] = [];
  private disposed = false;

  // `body` is what moves and is null for an authored body that built nothing;
  // `built` is the authored side and is null for a body the sim spawned at
  // runtime (a rock, the hook), which has no authored objects and simply
  // extrudes its own shapes.
  constructor(
    readonly body: CollisionObject2D | null,
    private readonly built: BuiltBody | null,
    private readonly rig?: LightRig,
  ) {
    const data = built?.data ?? null;
    // Hook-only scenery sits BEHIND the level it decorates by default, because
    // the player passes straight through it - and its glyph lattice still stamps
    // over it on the 2D overlay, which is what keeps "pass-through geometry
    // reads as pass-through" true in 3D (see docs/game-design.md). Anything else
    // sits on the gameplay plane unless the level says otherwise.
    const solidZ = body instanceof AnchorBody ? ANCHOR_Z : 0;

    if (data?.kind === "water") {
      // Water has its own renderer (see `water.ts`) rather than the dressing
      // machinery: its look is not a surface worn over an outline, so a
      // geometry object stating a depth, a texture and a material describes
      // none of it. Routing it through `buildAuthored` would extrude its
      // collision outline and dress it in ordinary stone.
      if (body instanceof WaterArea) {
        // The render controls live on the body's geometry object (water is a
        // visual effect); flow and drag stay on the body. Every water body has
        // one - `withGeometryTwin` gives a body that authors none its twin.
        const water = buildWater(this.root, body, data.objects.find(isGeometryObject));
        this.owned.push(...water.geometries);
        this.ownedMaterials.push(...water.materials);
      }
    } else if (data) {
      this.buildAuthored(data, solidZ);
    } else if (body) {
      // A body the level never authored: extrude what it collides as, which is
      // every default.
      body.getShapes().forEach((shape) => {
        const piece = this.piece(shape.localOffset.x, shape.localOffset.y, shape.localRotation);
        this.mount(piece, () => spawnedGeometry(shape), {}, solidZ, true);
      });
    }

    // A body that built nothing stands where it was authored, for ever. Written
    // once here rather than per frame, which is the whole difference between
    // this case and the one that tracks an engine body.
    if (!body && built) {
      placeAt(this.root, built.origin);
      orientTo(this.root, built.rotation);
    }
  }

  private buildAuthored(data: LevelBodyData, solidZ: number): void {
    const built = this.built!;
    // Whether the BODY collides, which is what the placement and depth defaults
    // turn on. Nothing past this line reads a collision object at all: what a
    // body is made of and what it looks like are two authored statements, and
    // this is the file where the second one is the only one consulted.
    const solid = data.objects.some(isCollisionObject);

    for (const g of drawnObjects(data)) {
      const local = localPlacement(built, g);
      const piece = this.piece(local.pos.x, local.pos.y, local.rot);
      const spec: DrawSpec = {
        geometry: g,
        ...(data.color !== undefined ? { color: data.color } : {}),
      };
      // A form on a body with collision is an object among objects and is drawn
      // on the body's own plane; one on a body without is decoration and sits
      // behind it, which is what a flat fill drawn before every body already was.
      const defaultZ = objectDepth(g.z, solid ? solidZ : DECOR_Z);
      // A primitive with no form of its own draws the same unit placeholder a
      // prop with no file does: something is missing HERE, said visibly rather
      // than by drawing nothing, which is what a body with no geometry object
      // means and is a different statement.
      const outline = outlineOfData(
        g.shape ?? { kind: "rect", w: ORPHAN_PLACEHOLDER, h: ORPHAN_PLACEHOLDER },
      );
      this.mount(
        piece,
        () => primitiveGeometry(outline, g, solid ? SOLID_DEFAULTS : DECOR_DEFAULTS),
        spec,
        defaultZ,
        // WHAT COLLIDES, CASTS - wherever its dressing has been nudged to.
        // A body with a collision object is a thing in the play space, and how
        // far behind its own plane the form drawn for it happens to sit is a
        // decision about how it READS, not about whether it is there: a hanging
        // cage set back 20 cm so the ball reads in front of it is still the
        // object the ball is standing in. Testing its depth is what silently
        // took the shadow off every prop authored that way, and a prop with no
        // shadow does not look like a prop set back - it looks like a sticker.
        //
        // Decoration keeps the rule the retired background layer had, because
        // the reason there is unchanged: a backdrop is a painted distance rather
        // than an object, and one throwing a shadow across the level in front of
        // it reads as geometry the player ought to be able to touch. Behind the
        // gameplay plane it casts nothing; on or in front of it, it is in the
        // scene and casts like anything else.
        solid || defaultZ >= 0,
      );
    }

    // Lights last, so the budgets are spent on geometry-bearing bodies in
    // authored order and a light is never built for a body that failed above.
    if (!this.rig) return;
    for (const l of data.objects) {
      if (!isLightObject(l)) continue;
      const local = localPlacement(built, l);
      const mounted = this.rig.add(this.root, l, {
        x: local.pos.x,
        y: local.pos.y,
        rot: local.rot,
        z: objectDepth(l.z, DEFAULT_LIGHT_Z),
      });
      if (mounted) this.lights.push(mounted);
    }
  }

  // One child group at a placement in the body's frame. Rigid, so written once.
  private piece(x: number, y: number, rot: number): THREE.Group {
    const piece = new THREE.Group();
    piece.position.set(x, threeY(y), 0);
    orientTo(piece, rot);
    this.root.add(piece);
    return piece;
  }

  private mount(
    piece: THREE.Group,
    geometryFor: () => THREE.BufferGeometry,
    spec: DrawSpec,
    defaultZ: number,
    castShadow: boolean,
  ): void {
    const mounted = mountVisual(piece, geometryFor, spec, {
      defaultZ,
      castShadow,
      alive: () => !this.disposed,
    });
    this.owned.push(...mounted.geometry);
  }

  // The whole per-frame cost of a body: two writes into vectors it already owns,
  // and nothing at all for one that never moves.
  sync(alpha: number): void {
    if (!this.body) return;
    placeAt(this.root, this.body.renderPosition(alpha));
    orientTo(this.root, this.body.renderRotation(alpha));
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.lights) this.rig?.drop(l);
    this.lights.length = 0;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.root.clear();
  }
}
