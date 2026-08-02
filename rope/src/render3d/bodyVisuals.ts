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
// WHAT A BODY LOOKS LIKE is decided by its geometry objects, and the default is
// the whole design:
//
// - NO geometry object: every collision shape is extruded through z and wears
//   the surface its own `material` names. The player then sees exactly what they
//   collide with, which is the property the reference games' silhouettes have
//   and the reason this is the default rather than a fallback - a level is fully
//   3D the moment it loads.
// - A geometry object with NO `shape`: the same outlines, dressed by that
//   object instead. This is how a wall wears brick at twice life size without
//   the file carrying its collision outline a second time where the two could
//   drift apart.
// - A geometry object WITH a `shape`: a form of its own - a backdrop, a sign, a
//   prop's placeholder - drawn wherever the object is placed.
//
// and `mountVisual` is where the mesh-or-primitive choice inside any of those is
// cashed out, so a body's own outline and a drawn-only form cannot end up with
// two different ideas of what a geometry object means.
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
import { DECOR_DEPTH, DECOR_Z } from "../level/decor";
import { localPlacement, objectDepth, type BuiltBody } from "../level/buildBodies";
import {
  isCollisionObject,
  isGeometryObject,
  isLightObject,
  type CollisionObjectData,
  type GeometryObjectData,
  type LevelBodyData,
} from "../level/levelFormat";
import { DEFAULT_BEVEL, extrudeOutline } from "./extrude";
import { isAuthoredSurface, loadMesh, surfaceFor, surfaceName } from "./assets";
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

// What one drawn thing is made of, gathered from the object that draws it and
// the body it belongs to. A body with no geometry object at all still has one of
// these, assembled from its collision object alone, which is exactly what makes
// the implicit default and an authored dressing the same code path.
export interface DrawSpec {
  // The geometry object, when there is one.
  geometry?: GeometryObjectData;
  // The collision object whose outline is being drawn and whose material and
  // thickness stand in for anything the geometry object does not say. Absent for
  // a form with a shape of its own, which has no collision object behind it.
  collision?: CollisionObjectData;
  // The body's own fill, for the tint.
  color?: string;
}

// A code-built circle is a SPHERE and an authored one is a disc seen face on.
// That is not a rendering choice, it is the same split `lib/shapeGeometry.ts`
// makes about mass: the ball, its hook and the sandbox's rocks are round objects
// and go through `computeMass`'s sphere rule, while authored level geometry is a
// prism `thickness` deep whatever its outline. Drawing them by the same rule is
// what keeps a 4 cm hook from being drawn as a 20 cm slab.
function autoGeometry(shape: CollisionShape2D, spec: DrawSpec): THREE.BufferGeometry {
  const s = shape.shape;
  if (s.kind === "circle" && spec.collision === undefined && spec.geometry === undefined) {
    return new THREE.SphereGeometry(s.radius, 24, 16);
  }
  return primitiveGeometry(outlineOfShape(s), spec);
}

// An authored outline as the solid it stands for: the primitive extruded to the
// thickness the shape's own mass is computed from, so a body is as thick as it
// weighs unless the geometry object says otherwise.
function primitiveGeometry(outline: Outline, spec: DrawSpec): THREE.BufferGeometry {
  return extrudeOutline(outline, {
    depth:
      spec.geometry?.depth ??
      spec.collision?.thickness ??
      (spec.collision ? DEFAULT_THICKNESS : DECOR_DEPTH),
    bevel: spec.geometry?.bevel ?? (spec.collision ? DEFAULT_BEVEL : 0),
  });
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
  const name = surfaceName(g?.texture ?? spec.collision?.material);
  return surfaceFor({
    texture: g?.texture,
    material: spec.collision?.material,
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
  const kind = g?.kind ?? "auto";
  const owned: THREE.BufferGeometry[] = [];

  // Drawn by nothing - an invisible wall. It exists because absence already
  // means "the default look", so without an explicit way to say it a body could
  // not opt out of being drawn at all. A body that wants a light and no fitting
  // says so by having a light object and no geometry object, which is cheaper
  // still.
  if (kind === "none") return { geometry: owned };

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

// Which geometry object draws each of a body's collision outlines, in the body's
// authored collision order - `undefined` where NOTHING does, which is a body
// whose shapes are solid and invisible.
//
// A geometry object with no shape of its own DRESSES the body's collision
// outlines rather than being a form in its own right. They pair with the
// collision objects in authored order, and one dressing covers all of them -
// which is the two cases that actually occur: a whole wall wearing brick at
// twice life size (one dressing, several pieces), and a compound body whose
// pieces are each their own prop (one dressing each).
//
// Split out of the constructor so the claim can be checked without a GPU, a
// canvas or a DOM: building a `BodyVisual` needs all three, and "does a bare
// collision shape draw?" is a question about this list alone.
export function outlineDressings(data: LevelBodyData): (GeometryObjectData | undefined)[] {
  const collisions = data.objects.filter(isCollisionObject);
  const dressings = data.objects.filter(
    (o): o is GeometryObjectData => isGeometryObject(o) && o.shape === undefined,
  );
  return collisions.map((_, i) => dressings[i] ?? dressings[0]);
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

    if (data) {
      this.buildAuthored(data, solidZ);
    } else if (body) {
      // A body the level never authored: extrude what it collides as, which is
      // every default.
      body.getShapes().forEach((shape) => {
        const piece = this.piece(shape.localOffset.x, shape.localOffset.y, shape.localRotation);
        const spec: DrawSpec = {};
        this.mount(piece, () => autoGeometry(shape, spec), spec, solidZ, true);
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
    const collisions = data.objects.filter(isCollisionObject);
    const shapes = this.body?.getShapes() ?? [];
    const geometries = data.objects.filter(isGeometryObject);
    const dressings = outlineDressings(data);

    // The body's own outlines, drawn ONLY where a geometry object asks for them.
    // A collision shape is what the body is made of and nothing else: it used to
    // draw itself whenever no one said otherwise, which made "what this collides
    // as" and "what this looks like" the same authored thing and left no way to
    // say they differ without also saying how. Every level that relied on the old
    // default is given the geometry object that states it, once, at load
    // (`withGeometryTwin`), so nothing on disk changes appearance.
    collisions.forEach((c, i) => {
      const dressing = dressings[i];
      if (!dressing) return;
      const spec: DrawSpec = {
        geometry: dressing,
        collision: c,
        ...(data.color !== undefined ? { color: data.color } : {}),
      };
      // An AUTO dressing is appearance only: what it draws is this piece's own
      // outline, so it has to be drawn at this piece. A MESH (or `none`) one
      // REPLACES the outline, so it is drawn at its own authored placement -
      // which is what the offset on a prop is for, and the only reading that
      // stays right for a body of several pieces.
      const atPiece = (dressing.kind ?? "auto") === "auto";
      const z = objectDepth(dressing.z, solidZ);
      const shape = shapes[i];
      if (atPiece && shape) {
        const piece = this.piece(shape.localOffset.x, shape.localOffset.y, shape.localRotation);
        this.mount(piece, () => autoGeometry(shape, spec), spec, z, true);
        return;
      }
      // Either a prop standing where it was placed, or a body that built no
      // engine shapes at all (a `killzone` or `force` area, which the 3D scene
      // still draws) - both fall back to the authored outline in its own frame.
      const local = localPlacement(built, atPiece ? c : dressing);
      const piece = this.piece(local.pos.x, local.pos.y, local.rot);
      const outline = outlineOfData(c.shape);
      this.mount(piece, () => primitiveGeometry(outline, spec), spec, z, true);
    });

    // Forms of their own: decoration, signs, standalone props.
    for (const g of geometries) {
      if (g.shape === undefined) continue;
      const local = localPlacement(built, g);
      const piece = this.piece(local.pos.x, local.pos.y, local.rot);
      const spec: DrawSpec = {
        geometry: g,
        ...(data.color !== undefined ? { color: data.color } : {}),
      };
      // A form on a body with collision is an object among objects and is drawn
      // on the plane; one on a body without is decoration and sits behind it,
      // which is what a flat fill drawn before every body already was.
      const defaultZ = objectDepth(g.z, collisions.length > 0 ? solidZ : DECOR_Z);
      const outline = g.shape
        ? outlineOfData(g.shape)
        : outlineOfData({ kind: "rect", w: ORPHAN_PLACEHOLDER, h: ORPHAN_PLACEHOLDER });
      this.mount(
        piece,
        () => primitiveGeometry(outline, spec),
        spec,
        defaultZ,
        // Decoration BEHIND the gameplay plane is backdrop and throws no shadow
        // across the level in front of it - the rule the retired background
        // layer had, kept because the reason is unchanged: a shadow is what
        // makes a shape read as an object in the scene rather than as a painted
        // distance. Anything on or in front of the plane casts like an object.
        defaultZ >= 0,
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
    this.root.clear();
  }
}
