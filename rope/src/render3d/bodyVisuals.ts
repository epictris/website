// One body's 3D presence, and its per-frame transform sync.
//
// A body is a Group holding one child per drawn piece. The group carries the
// body's interpolated pose; the children carry their pieces' placements in that
// frame, which are rigid within the body and therefore set ONCE at build. That
// is not a micro-optimisation, it is what makes the sync a two-number write per
// body per frame with no allocation at all (see "Allocation per frame" in
// docs/3d-rendering-plan.md).
//
// WHAT A BODY LOOKS LIKE IS NOT THE LEVEL'S TO SAY. A level's look is its
// Blender scene (docs/blender-scenes.md): a scene object named like a body is
// that body's dressing, mounted under this group's root when the file lands
// (`sceneDressing.ts`), and a level names the scene once. What is drawn HERE is
// only what the sim moves in a way a mesh cannot follow, and what a level with
// no scene is seen by:
//
// - WATER, whose surface the current runs across every frame (`water.ts`);
// - a CONVEYOR's band, whose texture or cleats run round its loop at the belt's
//   own speed (`beltTread.ts`);
// - the body's LIGHTS;
// - and, in a level that names NO scene, every piece the body collides as,
//   extruded through its `thickness` and filled with the body's own colour -
//   the grey box a level is blocked out in before it has a look, derived from
//   the collision and never authored (plans/blender-owns-appearance.md).
//
// The one case that is not authored at all is a body the SIM spawned (a rock,
// the hook), which has no authored objects and simply extrudes its own shapes,
// scene or no scene.
//
// Interpolation discipline: every transform read here is
// `renderPosition/renderRotation(alpha)`, never raw sim state. A body drawn at
// its 60 Hz pose while the chain welded to it draws interpolated visibly
// detaches between steps, which is the same rule the 2D renderer already keeps.

import * as THREE from "three";

import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { WaterArea } from "../engine/body";
import { DEFAULT_THICKNESS } from "../lib/shapeGeometry";
import { outlineOfData, outlineOfShape, type Outline } from "../render/shapePath";
import { localPlacement, objectDepth, type BuiltBody } from "../level/buildBodies";
import {
  DEFAULT_BODY_COLOR,
  isCollisionObject,
  isLightObject,
  type BeltLook,
  type BodyKind,
  type CollisionObjectData,
  type LevelBodyData,
} from "../level/levelFormat";
import { DEFAULT_BEVEL, cylinderSolid, extrudeOutline } from "./extrude";
import { isAuthoredSurface, isSolidSurface, surfaceFor, surfaceName, tileMetres } from "./assets";
import { buildWater } from "./water";
import type { FoamSurface, StillSurface } from "./stillWater";
import { DEFAULT_LIGHT_Z, LightRig, type DrivenEmission, type MountedLight } from "./lights";
import { isWaking } from "./glow";
import { BeltRing, BeltTread } from "./beltTread";
import { beltLoopOf } from "../render/beltTread";
import { orientTo, placeAt, threeY } from "./space";

// The floor an authored colour's brightness is lifted to before it tints a
// generated surface. A belt's `color` was authored for a flat 2D renderer, where
// a colour IS the appearance and most of them are dark greys - so multiplying a
// generated texture by `#000000` leaves a hole where a dark band is meant to be.
//
// The HUE is kept exactly and only the lightness is remapped, from 0..1 into
// TINT_FLOOR..1. That keeps the authored ORDERING - a black band is still darker
// than a grey one - while leaving the surface enough albedo to show its grain.
const TINT_FLOOR = 0.6;

// What a flat fill falls back to where nothing named a colour at all - a body
// the sim spawned, which carries no authored fill. White, so it is lit rather
// than black, and visibly undressed rather than pretending to be a choice.
const DEFAULT_SOLID_COLOR = "#ffffff";

// How far behind the gameplay plane hook-only scenery sits by default: far
// enough to read as background, near enough to still read as part of the level
// it decorates. In 3D this setback is the WHOLE cue - the 2D grate lattice is
// drawn only in 2D mode (see `render/renderer.ts`), so nothing else here says
// the player passes through it.
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

// The surface a drawn thing wears: a texture set (an authored PBR set or a
// generated one) at a tiling scale, tinted by a fill colour - three answers,
// each the same rule read against what the author said. A SOLID fill (`"color"`)
// wears the colour exactly: naming it is saying "this is that colour". An
// AUTHORED set wears none: its albedo is a photograph of real stuff and a flat
// renderer's grey is not an opinion about it. A GENERATED surface is tinted,
// floored, because noise has no colour of its own worth defending.
export function surfaceOf(req: { texture?: string; tileScale?: number; color?: string }): THREE.MeshStandardMaterial {
  const name = surfaceName(req.texture);
  return surfaceFor({
    texture: req.texture,
    tileScale: req.tileScale,
    color: isSolidSurface(name)
      ? (req.color ?? DEFAULT_SOLID_COLOR)
      : isAuthoredSurface(name)
        ? undefined
        : tintFor(req.color),
  });
}

// A code-built circle is a SPHERE and an authored one is a disc seen face on.
// That is not a rendering choice, it is the same split `lib/shapeGeometry.ts`
// makes about mass: the ball, its hook and the sandbox's rocks are round objects
// and go through `computeMass`'s sphere rule, while authored level geometry is a
// prism `thickness` deep whatever its outline. Drawing them by the same rule is
// what keeps a 4 cm hook from being drawn as a 20 cm slab.
function spawnedGeometry(shape: CollisionShape2D): THREE.BufferGeometry {
  const s = shape.shape;
  if (s.kind === "circle") return new THREE.SphereGeometry(s.radius, 24, 16);
  return solidOf(outlineOfShape(s), DEFAULT_THICKNESS);
}

// An outline as the prism it stands for: a circle a cylinder, anything else the
// outline extruded, `depth` thick and centred on z = 0.
function solidOf(outline: Outline, depth: number): THREE.BufferGeometry {
  if (outline.kind === "circle") return cylinderSolid(outline.radius, depth);
  return extrudeOutline(outline, { depth, bevel: DEFAULT_BEVEL });
}

// The kinds that are VOLUMES rather than things: the player passes into them
// and nothing is drawn for them in 3D (the 2D overlay has their glyphs). Water
// is one, and draws its own surface instead.
const AREAS: ReadonlySet<BodyKind> = new Set(["killzone", "finish", "force", "water"]);

// Whether a body is drawn as its collision in a level that names no scene: a
// thing the player meets, as against a volume it enters.
export function drawsGreybox(data: LevelBodyData): boolean {
  return !AREAS.has(data.kind) && data.objects.some(isCollisionObject);
}

// WHAT A PICK LANDS ON. A drawn piece's group carries the authored object it
// was built from, so a raycast that hits any mesh under it answers with the one
// thing an editor can act on - and a scene's dressing node carries its body's
// first object the same way (`DressTarget.tag`).
//
// It is the authored object by IDENTITY rather than an id, because the format
// has no id to carry and inventing one would put a field on disk that exists
// only for the editor. Whoever built the level data holds the map from those
// objects back to whatever it calls them (see the editor's
// `itemOfSceneObject`), and a host that built no map simply gets nothing back.
export function pickTagOf(obj: THREE.Object3D): unknown {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const tag = o.userData["pickTag"] as unknown;
    if (tag !== undefined) return tag;
  }
  return undefined;
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
  // own flow and colour in its uniforms), and so is a dressing's copy of a
  // material a waking light drives, so this visual frees them.
  private readonly ownedMaterials: THREE.Material[] = [];
  // A still water body's surface, for the scene's mirror. Null for everything
  // else.
  stillSurface: StillSurface | null = null;
  // Any water body's surface, pool or current, which the scene's splashes
  // watch the ball cross and move through (see stillWater.ts). Null for
  // everything else.
  foamSurface: FoamSurface | null = null;
  // Water's registrations (its top, its fall; see water.ts `buildWater`),
  // forgotten at dispose.
  private releaseWater: (() => void) | null = null;
  // Lights this body's light objects hang on it. Children of the root, so they
  // ride the pose with no per-frame cost; handed back to the rig at dispose,
  // which is what frees the budget slot as well as the objects.
  private readonly lights: MountedLight[] = [];
  // The glowing materials this body's WAKING lights drive (see `adoptDressing`).
  // Handed to the rig by reference when the lights are mounted and filled when
  // the scene lands, since a scene arrives after its bodies are built.
  private readonly driven: DrivenEmission[] = [];
  private readonly waking: boolean;
  // The conveyor cleat rings this body draws, one per untextured belt, and the
  // textured bands whose surface it scrolls, one per textured one. A band's
  // geometry is in `owned` like any other.
  private readonly treads: BeltTread[] = [];
  private readonly rings: BeltRing[] = [];

  // `body` is what moves and is null for an authored body that built nothing;
  // `built` is the authored side and is null for a body the sim spawned at
  // runtime (a rock, the hook), which has no authored objects and simply
  // extrudes its own shapes. `greybox` is whether the level names no scene, so
  // the body is seen by its collision (see the header).
  constructor(
    readonly body: CollisionObject2D | null,
    private readonly built: BuiltBody | null,
    private readonly rig?: LightRig,
    greybox = false,
  ) {
    const data = built?.data ?? null;
    this.waking = data?.objects.some((o) => isLightObject(o) && isWaking(o)) ?? false;
    // Hook-only scenery sits BEHIND the level it decorates by default, because
    // the player passes straight through it - and in 3D that setback is what
    // says so, the flat grate lattice being 2D-mode only (see docs/game-design.md
    // and `render/renderer.ts`). Anything else sits on the gameplay plane.
    const solidZ = body?.passable === true ? ANCHOR_Z : 0;

    if (data?.kind === "water") {
      // Water has its own renderer (see `water.ts`): its look is not a surface
      // worn over an outline.
      if (body instanceof WaterArea) {
        const water = buildWater(this.root, body, data);
        this.owned.push(...water.geometries);
        this.ownedMaterials.push(...water.materials);
        this.stillSurface = water.still;
        this.foamSurface = water.foam;
        this.releaseWater = water.release;
      }
    } else if (data) {
      this.buildAuthored(data, solidZ, greybox && drawsGreybox(data));
    } else if (body) {
      // A body the level never authored: extrude what it collides as, which is
      // every default.
      body.getShapes().forEach((shape) => {
        const piece = this.piece(shape.localOffset.x, shape.localOffset.y, shape.localRotation);
        this.mount(piece, spawnedGeometry(shape), surfaceOf({}), solidZ);
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

  private buildAuthored(data: LevelBodyData, solidZ: number, greybox: boolean): void {
    const built = this.built!;
    for (const o of data.objects) {
      if (!isCollisionObject(o)) continue;
      const local = localPlacement(built, o);
      if (o.shape.kind === "belt") {
        this.mountBelt(this.piece(local.pos.x, local.pos.y, local.rot, o), o.shape, data.color, solidZ);
      } else if (greybox) {
        this.mount(
          this.piece(local.pos.x, local.pos.y, local.rot, o),
          solidOf(outlineOfData(o.shape), o.thickness ?? DEFAULT_THICKNESS),
          surfaceOf({ texture: "color", color: data.color ?? DEFAULT_BODY_COLOR }),
          solidZ,
        );
      }
    }

    // Lights last, so the budgets are spent in authored order and a light is
    // never built for a body that failed above.
    if (!this.rig) return;
    for (const l of data.objects) {
      if (!isLightObject(l)) continue;
      const local = localPlacement(built, l);
      const mounted = this.rig.add(
        this.root,
        l,
        {
          x: local.pos.x,
          y: local.pos.y,
          rot: local.rot,
          z: objectDepth(l.z, DEFAULT_LIGHT_Z),
        },
        // Only a waking light reads it; an always-on light leaves the
        // emission as authored.
        this.driven,
      );
      if (mounted) this.lights.push(mounted);
    }
  }

  // A CONVEYOR is its own geometry, not an extruded outline: the band as a ring
  // whose running surface carries its texture round the loop, and on a band
  // with no texture to move (the flat colour) a ring of cleats as well
  // (`beltTread.ts`). Both run at the belt's own `speed`. Drawn in every level,
  // scene or not: what the scene cannot draw is a surface that moves.
  private mountBelt(
    piece: THREE.Group,
    shape: Extract<CollisionObjectData["shape"], { kind: "belt" }> & BeltLook,
    bodyColor: string | undefined,
    z: number,
  ): void {
    const loop = beltLoopOf(shape);
    if (!loop) return;
    const width = shape.width ?? DEFAULT_THICKNESS;
    const surface = surfaceName(shape.texture);
    const flat = isSolidSurface(surface);
    const ring = new BeltRing(loop, width, tileMetres(surface, shape.tileScale), flat ? 0 : shape.speed);
    if (flat) {
      const tread = new BeltTread(loop, shape.speed, width);
      tread.mesh.position.z = z;
      piece.add(tread.mesh);
      this.treads.push(tread);
      this.owned.push(tread.geometry);
    } else {
      this.rings.push(ring);
    }
    this.mount(
      piece,
      ring.geometry,
      surfaceOf({ texture: shape.texture, tileScale: shape.tileScale, color: shape.color ?? bodyColor }),
      z,
    );
  }

  // Take a dressing node from the level's scene, now a child of `root`
  // (`dressScene`). Only one thing about it is this body's business: a body
  // with a WAKING light drives the glow of what it is dressed in, as it drove
  // the glow of the shapes it used to carry (see `LightRig`), so the node's
  // emissive materials become this body's own copies - shared with nothing
  // else in the level, which would otherwise light up with it - and join the
  // set its lights drive.
  adoptDressing(node: THREE.Object3D): void {
    if (!this.waking) return;
    const copies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = (m: THREE.Material): THREE.Material => {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial || (std.emissive.getHex() === 0 && !std.emissiveMap)) return m;
        let copy = copies.get(m);
        if (!copy) {
          copy = std.clone();
          copies.set(m, copy);
          this.ownedMaterials.push(copy);
          this.driven.push({ material: copy, authored: copy.emissiveIntensity });
        }
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    });
  }

  // One child group at a placement in the body's frame. Rigid, so written once.
  // `tag` is what a raycast onto anything inside it answers with (see
  // `pickTagOf`); a body the sim spawned has no authored object to name and
  // passes none, which is what keeps a rock or a hook out of an editor pick.
  private piece(x: number, y: number, rot: number, tag?: unknown): THREE.Group {
    const piece = new THREE.Group();
    piece.position.set(x, threeY(y), 0);
    orientTo(piece, rot);
    if (tag !== undefined) piece.userData["pickTag"] = tag;
    this.root.add(piece);
    return piece;
  }

  // A solid on a piece, at `z` through the plane. Everything drawn here is a
  // thing in the play space, so everything casts.
  private mount(piece: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, z: number): void {
    this.owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.z = z;
    piece.add(mesh);
  }

  // The whole per-frame cost of a body: two writes into vectors it already owns,
  // and nothing at all for one that never moves - plus, on a conveyor, its
  // texture or its cleats carried to `time`, the sim instant the frame stands
  // for (`beltRenderTime`), which a belt at rest skips.
  sync(alpha: number, time = 0): void {
    for (const t of this.treads) t.sync(time);
    for (const r of this.rings) r.sync(time);
    if (!this.body) return;
    placeAt(this.root, this.body.renderPosition(alpha));
    orientTo(this.root, this.body.renderRotation(alpha));
  }

  dispose(): void {
    for (const l of this.lights) this.rig?.drop(l);
    this.lights.length = 0;
    this.driven.length = 0;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const t of this.treads) t.mesh.dispose();
    this.treads.length = 0;
    this.rings.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.releaseWater?.();
    this.releaseWater = null;
    this.root.clear();
  }
}
