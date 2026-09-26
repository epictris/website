// The Visuals workspace's editor furniture, drawn INTO the 3D scene: the
// gameplay plane's grid, every collision outline, the lights' icons and rings,
// the spawn, the camera regions and paths, the notes, the selected polygon's
// corners and a tool's draft (plans/visuals-workspace.md, "What is drawn").
//
// The Level workspace draws all of this on the 2D overlay, which is exact only
// while the gameplay plane is parallel to the screen; once the camera is free
// the overlay would be drawing on a plane that is no longer there, which is why
// a turned view draws none of it. Drawn in the scene instead, each mark is
// where the thing it describes is, from any angle, and it is picked by the
// same raycast as the models (`Scene3D.pick`) through the guide tag it carries
// (`tags.ts`).
//
// The marks are the overlay's marks, in the overlay's colours (imported, never
// restated): a collision outline in its body's colour or the hook-proof steel
// or the mud ochre, dashed where the overlay dashes it, the selection orange on
// what is selected and the member blue on the pieces of a selected body.
// Collision outlines are drawn with the depth test OFF and after the scene, so
// the collision stays readable through the geometry that dresses it - which is
// what the head-on overlay was for.
//
// Rebuilt when the model's revision, the selection or the layers change
// (`sync`), never per frame; per frame only the pixel-sized parts are resized
// (`update`), in place. The plane grid is kept apart from that rebuild: a drag
// moves the revision every frame, and the grid (up to `GRID_MAX_LINES` lines)
// changes only when the level's extent crosses a whole major cell.
//
// Nothing here needs a DOM: the icons are drawn into `DataTexture`s, and three's
// fat lines (`Line2`) build and raycast in bun, so `cli render3d` counts and
// picks the guides of a model headlessly.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { Vec2 } from "../../engine/vec2";
import { PX } from "../../engine/units";
import { cubicAt } from "../../lib/path";
import { BallLevel } from "../../level/ballLevel";
import { pathOutlineInto, type OutlineSink } from "../../render/shapePath";
import { AXIS, MAJOR, MAJOR_M, MINOR, MINOR_M } from "../../render/trainingGrid";
import { MASK_ALL } from "../../engine/body";
import {
  arrowEnds,
  bodyBounds,
  CAMERA_REGION_COLOR,
  collidingBodyIds,
  ED_LAYERS,
  FIREFLY_PATH_COLOR,
  halfExtents,
  isArrowNote,
  isCheckpointNote,
  itemDepth,
  NOTE_COLOR,
  pathPolyline,
  toWorld,
  type EdItem,
  type EdLayer,
  type EdModel,
} from "../model";
import {
  BODY_MEMBER,
  HANDLE,
  HANDLE_FILL,
  HANDLE_SIZE_PX,
  IMPERMEABLE_EDGE,
  lightPlaneReach,
  lightTrigger,
  lightWakes,
  MID_HANDLE_RADIUS_PX,
  outlineOf,
  PLAYER,
  SELECT,
  VISCOUS_EDGE,
} from "../render";
import { DraftView, type GuideDraft } from "./draftView";
import { guideTag, SPAWN_GUIDE_ID, type GuidePart, type GuideTag } from "./tags";

export type { GuideDraft, DraftPoint } from "./draftView";

// What the guides are built from: the editor's state, read, never written.
export interface GuideView {
  readonly model: EdModel;
  // The editor's `modelRev`: bumped by every edit, so the guides rebuild on it
  // rather than comparing the model.
  readonly rev: number;
  readonly selectedIds: ReadonlySet<number>;
  readonly selectedBodyIds: ReadonlySet<number>;
  // Which vertices of the selected polygon are picked (`selectedVerts`).
  readonly selectedVerts: ReadonlySet<number>;
  readonly visibleLayers: ReadonlySet<EdLayer>;
  // Drawn, but not picked: a locked layer's marks are there to be seen by.
  readonly lockedLayers: ReadonlySet<EdLayer>;
}

// Screen pixels. An outline is the overlay's hairline, slightly heavier so it
// holds up drawn over lit geometry; the selection wears a heavier one, as the
// overlay's halo is heavier than the border it sits under.
const OUTLINE_PX = 1.5;
const SELECTED_OUTLINE_PX = 2.5;
const FAINT_PX = 1;
// Screen pixels: a light's icon, and a vertex handle's sprite (the overlay's
// square plus its stroke's overhang, so the square is the overlay's size).
const LIGHT_ICON_PX = 18;
const VERTEX_SPRITE_PX = HANDLE_SIZE_PX + 2;
const MID_SPRITE_PX = MID_HANDLE_RADIUS_PX * 2 + 2;
// Segments per full circle, dimensionless: a ring 300 px across still reads
// as round.
const CIRCLE_SEGMENTS = 64;
// Metres of grid beyond the level's bounds on every side.
const GRID_MARGIN = 5;
// A grid line is faded out as the cell it rules shrinks toward this many
// screen pixels (gone at it, full at three times it) - the density the 2D
// training grid stops drawing a pass at.
const GRID_MIN_CELL_PX = 5;
// Dimensionless opacities of the grid's three passes over the scene.
const GRID_MINOR_OPACITY = 0.12;
const GRID_MAJOR_OPACITY = 0.28;
const GRID_AXIS_OPACITY = 0.6;
// The most lines one grid pass may hold, dimensionless. A level 400 m across
// would rule 8000 minor lines; past this the minor pass is dropped, since at
// any distance that shows the whole of such a level it would be faded out.
const GRID_MAX_LINES = 6000;
// Draw order: the plane grid with the scene, everything else after it, the
// sprites after the lines they sit on.
const LINE_RENDER_ORDER = 1000;
const SPRITE_RENDER_ORDER = 1050;
// Texels per sprite pixel in the icon textures: enough that a sprite resampled
// at a fractional size keeps its edges.
const ICON_SUPERSAMPLE = 4;

// A dash pattern in METRES, as the overlay's (`6 * PX` is six scene pixels at
// zoom 1): so a dash is the same length on the plane in both workspaces.
type Dash = readonly [number, number] | null;
const DASH_VOLUME: Dash = [6 * PX, 4 * PX];
const DASH_STEEL: Dash = [5 * PX, 3 * PX];
const DASH_MUD: Dash = [8 * PX, 3 * PX];
const DASH_DOTTED: Dash = [PX, 2 * PX];
const DASH_RANGE: Dash = [2 * PX, 6 * PX];
const DASH_WAKE: Dash = [14 * PX, 6 * PX];
const DASH_ROLL: Dash = [6 * PX, 6 * PX];

// Collects `pathOutlineInto`'s moves, lines and arcs as closed loops of plane
// points, which is how the overlay's own outline code is made to draw into the
// scene: the same outline, traced by the same function.
class LoopSink implements OutlineSink {
  readonly loops: Vec2[][] = [];
  private current: Vec2[] | null = null;
  moveTo(x: number, y: number): void {
    this.current = [new Vec2(x, y)];
    this.loops.push(this.current);
  }
  lineTo(x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else this.current.push(new Vec2(x, y));
  }
  closePath(): void {
    const c = this.current;
    // An arc already ends where it began; a polygon's loop does not.
    if (c && c.length > 1 && c[c.length - 1]!.distanceTo(c[0]!) > 1e-9) c.push(c[0]!);
    this.current = null;
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const n = Math.max(2, Math.ceil((CIRCLE_SEGMENTS * Math.abs(a1 - a0)) / (Math.PI * 2)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const p = new Vec2(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (i === 0 && this.current) continue;
      this.lineTo(p.x, p.y);
    }
  }
}

// A closed circle on a plane, as a loop of plane points.
function circleLoop(c: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const a = (i * Math.PI * 2) / CIRCLE_SEGMENTS;
    out.push(new Vec2(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
  }
  return out;
}

// Where an item's guides sit through z, metres: the plane its outline is drawn
// in. A collision object is the gameplay plane by definition; a drawn object
// is its own depth (`itemDepth`, the rule the renderer places it by), so a
// primitive pushed back by its `off z` has its corners on the face it is
// drawn at rather than floating in front of it; a light is at its own `z`.
// Exported so a gesture that drags a guide drags it in the same plane
// (`unprojectToPlane`'s `z`).
export function guidePlaneZ(item: EdItem, bodyCollides: boolean): number {
  if (item.object === "light") return item.light.z;
  if (item.object === "geometry") return itemDepth(item, bodyCollides);
  return 0;
}

// Linear-light copy of an sRGB hex colour's bytes, for writing an icon texture
// that is tagged sRGB.
function srgbBytes(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  const s = c.clone().convertLinearToSRGB();
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
}

// An icon drawn by a coverage function over the sprite's own pixel grid:
// `shade(x, y)` answers the RGBA of the point (x, y) in sprite pixels from
// the centre, supersampled.
function iconTexture(
  px: number,
  shade: (x: number, y: number) => [number, number, number, number] | null,
): THREE.DataTexture {
  const size = Math.ceil(px * ICON_SUPERSAMPLE);
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * px;
      // Texture rows run bottom-up.
      const y = (0.5 - (j + 0.5) / size) * px;
      const c = shade(x, y);
      if (!c) continue;
      const o = (j * size + i) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c[3];
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// The overlay's handle glyphs (see `square`, `filledSquare`, `midHandle` in
// editor/render.ts) and its light burst (`drawLightGizmo`), as textures.
function buildIcons(): Record<"vertex" | "vertexPicked" | "midpoint" | "burst", THREE.DataTexture> {
  const stroke = srgbBytes(HANDLE);
  const fill = srgbBytes(HANDLE_FILL);
  const half = HANDLE_SIZE_PX / 2;
  // The stroke is 1.5 px centred on the square's edge, as the overlay strokes it.
  const edge = 0.75;
  const square = (picked: boolean) => (x: number, y: number): [number, number, number, number] | null => {
    const d = Math.max(Math.abs(x), Math.abs(y));
    if (d > half + edge) return null;
    if (d >= half - edge || picked) return [...stroke, 255];
    return [...fill, 255];
  };
  const mid = (x: number, y: number): [number, number, number, number] | null => {
    const d = Math.hypot(x, y);
    if (d > MID_HANDLE_RADIUS_PX + edge) return null;
    if (d >= MID_HANDLE_RADIUS_PX - edge) return [...stroke, 255];
    return [...fill, 255];
  };
  // White, tinted by the sprite's colour: one texture for every light.
  const r = LIGHT_ICON_PX / 2;
  const rays = 8;
  const burst = (x: number, y: number): [number, number, number, number] | null => {
    const d = Math.hypot(x, y);
    if (d <= r * 0.35) return [255, 255, 255, 255];
    if (d < r * 0.4 || d > r) return null;
    const a = Math.atan2(y, x);
    const step = (Math.PI * 2) / rays;
    const off = Math.abs(a - Math.round(a / step) * step) * d;
    return off <= 1 ? [255, 255, 255, 255] : null;
  };
  return {
    vertex: iconTexture(VERTEX_SPRITE_PX, square(false)),
    vertexPicked: iconTexture(VERTEX_SPRITE_PX, square(true)),
    midpoint: iconTexture(MID_SPRITE_PX, mid),
    burst: iconTexture(LIGHT_ICON_PX, burst),
  };
}

// The grid's shader: a line fades as the cell it rules shrinks on screen,
// measured per fragment, so the plane fades out into the distance at an angle
// and the minor lines fade as the view dollies back - one rule for both.
const GRID_VERTEX = /* glsl */ `
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const GRID_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float spacing;
uniform float pxScale;
uniform float perspective;
uniform float minPx;
varying float vDepth;
void main() {
  float cell = spacing * pxScale / mix(1.0, max(vDepth, 1e-3), perspective);
  float a = opacity * smoothstep(minPx, minPx * 3.0, cell);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(color, a);
  #include <colorspace_fragment>
}`;

function gridMaterial(color: string, opacity: number, spacing: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GRID_VERTEX,
    fragmentShader: GRID_FRAGMENT,
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: opacity },
      spacing: { value: spacing },
      pxScale: { value: 1 },
      perspective: { value: 1 },
      minPx: { value: GRID_MIN_CELL_PX },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

interface Stroke {
  color: string;
  px: number;
  dash: Dash;
  opacity?: number;
}

export class Guides {
  readonly group = new THREE.Group();
  // What `sync` rebuilds on every revision.
  private readonly built = new THREE.Group();
  // The plane grid's passes, rebuilt only when the extent they rule (snapped
  // out to whole major cells) changes: `gridExtent` says which it was built for.
  private readonly grid = new THREE.Group();
  private gridExtent = "";
  private readonly draft = new DraftView();
  private readonly icons = buildIcons();
  // Materials by stroke, shared by every line drawn in that stroke and kept
  // for the life of the guides: a rebuild on every drag must not recompile.
  private readonly lineMaterials = new Map<string, LineMaterial>();
  private readonly spriteMaterials = new Map<string, THREE.SpriteMaterial>();
  private readonly gridMaterials = {
    minor: gridMaterial(MINOR, GRID_MINOR_OPACITY, MINOR_M),
    major: gridMaterial(MAJOR, GRID_MAJOR_OPACITY, MAJOR_M),
    // The axes are always drawn: the cell they fade by is the major one.
    axis: gridMaterial(AXIS, GRID_AXIS_OPACITY, MAJOR_M),
  };
  private readonly gridPasses: readonly THREE.ShaderMaterial[] = Object.values(this.gridMaterials);
  // Every sprite and its size in screen pixels, resized in place by `update`.
  private sprites: { sprite: THREE.Sprite; px: number }[] = [];
  private signature = Number.NaN;
  // Zero until a frame is drawn or `setResolution` says otherwise: a fat line
  // raycasts as nothing at a zero resolution, where at three's default of 1x1
  // every line would be a viewport wide.
  private readonly resolution = new THREE.Vector2(0, 0);
  // Reusables for the per-frame hook, so it allocates nothing.
  private readonly viewport = new THREE.Vector4();
  private hashAcc = 0;
  private hashSalt = 0;
  private readonly hashId = (id: number): void => {
    this.hashAcc = (this.hashAcc + Math.imul((id ^ this.hashSalt) | 0, 0x9e3779b1)) | 0;
  };
  private readonly hashLayer = (l: EdLayer): void => {
    this.hashAcc = (this.hashAcc + Math.imul(ED_LAYERS.indexOf(l) + 1 + this.hashSalt, 0x85ebca6b)) | 0;
  };

  // An empty drawable whose only job is the per-frame hook in the constructor:
  // three calls `onBeforeRender` only for objects it draws, and this one (a
  // single degenerate triangle writing nothing) is always drawn - in the
  // opaque pass, so before any guide, all of which are transparent.
  private readonly hook = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
  );

  constructor() {
    this.group.name = "guides";
    this.built.name = "guides-built";
    this.grid.name = "guides-grid";
    this.group.add(this.grid, this.built, this.draft.group);
    // The fat lines are sized in screen pixels, and three sets their viewport
    // on every draw; the sprites and the grid are sized here, from the camera
    // the frame is actually drawn with, so a dolly never shows a frame of
    // last frame's sizes.
    this.hook.frustumCulled = false;
    this.hook.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(this.viewport);
      this.update(camera, this.viewport.w);
    };
    this.hook.raycast = () => undefined;
    this.group.add(this.hook);
  }

  // Rebuild if anything the guides are drawn from has changed since the last
  // call; cheap enough to call every frame (a hash over the selection, no
  // allocation) and true when it rebuilt.
  sync(view: GuideView): boolean {
    this.hashAcc = view.rev | 0;
    this.hashSalt = 0x1234567;
    view.selectedIds.forEach(this.hashId);
    this.hashSalt = 0x2345678;
    view.selectedBodyIds.forEach(this.hashId);
    this.hashSalt = 0x3456789;
    view.selectedVerts.forEach(this.hashId);
    this.hashSalt = 0x456789a;
    view.visibleLayers.forEach(this.hashLayer);
    this.hashSalt = 0x56789ab;
    view.lockedLayers.forEach(this.hashLayer);
    const sig =
      this.hashAcc ^
      Math.imul(view.selectedIds.size + 1, 0x27d4eb2f) ^
      Math.imul(view.selectedVerts.size + 3, 0x165667b1);
    if (sig === this.signature) return false;
    this.signature = sig;
    this.rebuild(view);
    return true;
  }

  // Draw a tool's draft (or none). Independent of `sync`: a draft changes
  // with every pointer move, the model only with an edit.
  setDraft(draft: GuideDraft | null): void {
    this.draft.set(draft);
    this.draft.material.resolution.copy(this.resolution);
  }

  // The drawing buffer's size in pixels, which every fat line is sized
  // against. Three sets it on each line as the line is drawn, so a host that
  // renders need not call this; a raycast before the first frame (or one with
  // no renderer at all, as in `cli render3d`) needs it.
  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    for (const m of this.lineMaterials.values()) m.resolution.set(width, height);
    this.draft.material.resolution.set(width, height);
  }

  // Size the pixel-sized parts for `camera` drawing into a viewport
  // `heightPx` tall. Runs from the per-frame hook with the camera the frame is
  // drawn through; public for a host (or a case) that raycasts without
  // drawing. Allocates nothing.
  //
  // A sprite with `sizeAttenuation: false` is drawn `scale * P[5] * H / 2`
  // pixels tall through either lens (perspective multiplies by the depth and
  // divides it back out; orthographic does neither), so the scale that makes
  // it `px` pixels is `2 px / (H P[5])`.
  update(camera: THREE.Camera, heightPx: number): void {
    const p5 = camera.projectionMatrix.elements[5]!;
    if (!(heightPx > 0) || !(p5 > 0)) return;
    const k = 2 / (heightPx * p5);
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      s.sprite.scale.set(s.px * k, s.px * k, 1);
      // The renderer took every world matrix at the top of this frame, before
      // the hook ran, so a scale set here would be drawn a frame late (and the
      // first frame at scale 1, a sprite the size of the view) without this.
      s.sprite.updateMatrixWorld();
    }
    const pxScale = (heightPx * p5) / 2;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
    for (let i = 0; i < this.gridPasses.length; i++) {
      const m = this.gridPasses[i]!;
      m.uniforms["pxScale"]!.value = pxScale;
      m.uniforms["perspective"]!.value = perspective;
    }
  }

  // Every guide tag in the group, in build order - what `cli render3d` counts.
  tags(): GuideTag[] {
    const out: GuideTag[] = [];
    this.built.traverse((o) => {
      const tag = o.userData["pickTag"] as GuideTag | undefined;
      if (tag) out.push(tag);
    });
    return out;
  }

  // The draw-only parts by name (a light's reach ring is "light-reach"), for
  // the same cases.
  named(name: string): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (o.name === name) out.push(o);
    };
    this.grid.traverse(visit);
    this.built.traverse(visit);
    return out;
  }

  // How many times the grid has been built, for the cases.
  gridBuilds = 0;

  // The draft's drawn size, for the cases.
  draftCounts(): { segments: number; points: number } {
    return this.draft.counts();
  }

  dispose(): void {
    this.clearBuilt();
    this.clearGrid();
    this.draft.dispose();
    for (const m of this.lineMaterials.values()) m.dispose();
    for (const m of this.spriteMaterials.values()) m.dispose();
    for (const m of Object.values(this.gridMaterials)) m.dispose();
    for (const t of Object.values(this.icons)) t.dispose();
    this.hook.geometry.dispose();
    (this.hook.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }

  private clearBuilt(): void {
    this.built.traverse((o) => {
      const drawn = o as THREE.Mesh | THREE.LineSegments;
      // Materials are cached and shared; only geometry is per build. A
      // sprite's geometry is three's one shared quad and is not ours to free.
      if (!(o as THREE.Sprite).isSprite && drawn.geometry) drawn.geometry.dispose();
    });
    this.built.clear();
    this.sprites = [];
  }

  private clearGrid(): void {
    for (const o of this.grid.children) (o as THREE.LineSegments).geometry.dispose();
    this.grid.clear();
    this.gridExtent = "";
  }

  private rebuild(view: GuideView): void {
    this.clearBuilt();
    const { model } = view;
    const visible = (l: EdLayer): boolean => view.visibleLayers.has(l);
    const pickable = (l: EdLayer): boolean => !view.lockedLayers.has(l);
    const colliding = collidingBodyIds(model.items);
    this.buildGrid(model);

    // Collision outlines.
    if (visible("scene")) {
      for (const item of model.items) {
        if (item.layer !== "scene" || item.object !== "collision") continue;
        const selected = view.selectedIds.has(item.id);
        const member = !selected && view.selectedBodyIds.has(item.bodyId);
        this.outline(item, 0, this.collisionStroke(item, selected, member), pickable("scene") ? guideTag("outline", item.id) : null, "outline");
      }
    }

    // Camera regions and paths.
    if (visible("camera")) {
      for (const item of model.items) {
        if (item.layer !== "camera") continue;
        const selected = view.selectedIds.has(item.id);
        const color = selected ? SELECT : CAMERA_REGION_COLOR;
        const tagOk = pickable("camera");
        const px = selected ? SELECTED_OUTLINE_PX : OUTLINE_PX;
        if (item.shape.kind === "path") {
          this.polyline(pathPolyline(item), 0, { color, px, dash: null }, tagOk ? guideTag("path", item.id) : null, "camera-path");
        } else {
          this.outline(item, 0, { color, px, dash: DASH_VOLUME }, tagOk ? guideTag("region", item.id) : null, "region");
        }
      }
    }

    // Firefly paths.
    if (visible("fireflies")) {
      for (const item of model.items) {
        if (item.layer !== "fireflies" || item.shape.kind !== "path") continue;
        const selected = view.selectedIds.has(item.id);
        this.polyline(
          pathPolyline(item),
          0,
          { color: selected ? SELECT : FIREFLY_PATH_COLOR, px: selected ? SELECTED_OUTLINE_PX : OUTLINE_PX, dash: null },
          pickable("fireflies") ? guideTag("path", item.id) : null,
          "firefly-path",
        );
      }
    }

    // Notes.
    if (visible("notes")) {
      for (const item of model.items) {
        if (item.layer !== "notes") continue;
        const selected = view.selectedIds.has(item.id);
        const stroke: Stroke = { color: selected ? SELECT : NOTE_COLOR, px: selected ? SELECTED_OUTLINE_PX : OUTLINE_PX, dash: null };
        const tag = pickable("notes") ? guideTag("note", item.id) : null;
        if (isArrowNote(item)) {
          const { tail, head } = arrowEnds(item);
          this.segments([[tail, head]], 0, stroke, tag, "note-arrow");
        } else if (isCheckpointNote(item)) {
          const r = halfExtents(item).x;
          const p = item.pos;
          const t = r * 1.6;
          this.segments(
            [
              ...loopPairs(circleLoop(p, r)),
              [new Vec2(p.x - t, p.y), new Vec2(p.x + t, p.y)],
              [new Vec2(p.x, p.y - t), new Vec2(p.x, p.y + t)],
            ],
            0,
            { ...stroke, dash: null },
            tag,
            "note-checkpoint",
          );
        } else {
          this.outline(item, 0, { ...stroke, dash: DASH_VOLUME }, tag, "note");
        }
      }
    }

    // Lights.
    if (visible("scene")) {
      for (const l of model.items) {
        if (l.object !== "light") continue;
        this.light(l, view.selectedIds.has(l.id), pickable("scene"));
      }
    }

    // The spawn. On the scene layer, where the 2D overlay's spawn drag lives.
    if (visible("scene")) this.spawn(model, pickable("scene"));

    // The selected polygon's (or path's) corners and edge midpoints.
    if (view.selectedIds.size === 1) {
      const [id] = view.selectedIds;
      const item = model.items.find((i) => i.id === id);
      if (item && visible(item.layer) && pickable(item.layer)) {
        this.vertexHandles(item, guidePlaneZ(item, colliding.has(item.bodyId)), view.selectedVerts);
      }
    }
  }

  // The plane grid over the level's extent plus a margin, snapped out to whole
  // major cells so the lines fall where the training grid's do. Built only when
  // that snapped extent differs from the one the grid on hand was built for.
  private buildGrid(model: EdModel): void {
    const b = bodyBounds(model.items);
    const p = model.player.pos;
    const x0 = Math.floor((Math.min(b.min.x, p.x) - GRID_MARGIN) / MAJOR_M) * MAJOR_M;
    const x1 = Math.ceil((Math.max(b.max.x, p.x) + GRID_MARGIN) / MAJOR_M) * MAJOR_M;
    const y0 = Math.floor((Math.min(b.min.y, p.y) - GRID_MARGIN) / MAJOR_M) * MAJOR_M;
    const y1 = Math.ceil((Math.max(b.max.y, p.y) + GRID_MARGIN) / MAJOR_M) * MAJOR_M;
    const extent = `${x0},${x1},${y0},${y1}`;
    if (extent === this.gridExtent) return;
    this.clearGrid();
    this.gridExtent = extent;
    this.gridBuilds++;
    const perMajor = Math.round(MAJOR_M / MINOR_M);
    const minor: number[] = [];
    const major: number[] = [];
    const axis: number[] = [];
    const lines = ((x1 - x0) + (y1 - y0)) / MINOR_M;
    const withMinor = lines <= GRID_MAX_LINES;
    // Integer steps, so a line's position is computed rather than accumulated.
    const nx = Math.round((x1 - x0) / MINOR_M);
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * MINOR_M;
      const isMajor = i % perMajor === 0;
      if (!isMajor && !withMinor) continue;
      const into = Math.abs(x) < MINOR_M / 2 ? axis : isMajor ? major : minor;
      into.push(x, -y0, 0, x, -y1, 0);
    }
    const ny = Math.round((y1 - y0) / MINOR_M);
    for (let j = 0; j <= ny; j++) {
      const y = y0 + j * MINOR_M;
      const isMajor = j % perMajor === 0;
      if (!isMajor && !withMinor) continue;
      const into = Math.abs(y) < MINOR_M / 2 ? axis : isMajor ? major : minor;
      into.push(x0, -y, 0, x1, -y, 0);
    }
    const pass = (positions: number[], material: THREE.ShaderMaterial, name: string): void => {
      if (!positions.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const segs = new THREE.LineSegments(geo, material);
      segs.name = name;
      segs.raycast = () => undefined;
      this.grid.add(segs);
    };
    pass(minor, this.gridMaterials.minor, "grid-minor");
    pass(major, this.gridMaterials.major, "grid-major");
    pass(axis, this.gridMaterials.axis, "grid-axis");
  }

  private collisionStroke(item: EdItem, selected: boolean, member: boolean): Stroke {
    // The overlay's border rules (`drawEditor`), with the halo folded in: a
    // selected piece is drawn in the selection orange rather than haloed, since
    // a halo under a line drawn through the scene is two lines at an angle.
    const dash: Dash = item.impermeable
      ? DASH_STEEL
      : item.viscosity > 0
        ? DASH_MUD
        : item.passable || item.mask !== MASK_ALL
          ? DASH_DOTTED
          : null;
    if (selected) return { color: SELECT, px: SELECTED_OUTLINE_PX, dash };
    if (member) return { color: BODY_MEMBER, px: OUTLINE_PX, dash };
    const color = item.impermeable ? IMPERMEABLE_EDGE : item.viscosity > 0 ? VISCOUS_EDGE : item.color;
    return { color, px: OUTLINE_PX, dash };
  }

  private lineMaterial(stroke: Stroke): LineMaterial {
    const opacity = stroke.opacity ?? 1;
    const key = `${stroke.color}|${stroke.px}|${stroke.dash?.join(",") ?? "-"}|${opacity}`;
    const cached = this.lineMaterials.get(key);
    if (cached) return cached;
    const m = new LineMaterial({
      color: stroke.color,
      linewidth: stroke.px,
      dashed: stroke.dash !== null,
      dashSize: stroke.dash?.[0] ?? 1,
      gapSize: stroke.dash?.[1] ?? 1,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    m.resolution.copy(this.resolution);
    this.lineMaterials.set(key, m);
    return m;
  }

  // Pairs of plane points (sim frame, metres) as one fat-line object at depth
  // `z`, tagged if it is pickable.
  private segments(
    pairs: readonly (readonly [Vec2, Vec2])[],
    z: number,
    stroke: Stroke,
    tag: GuideTag | null,
    name: string,
  ): LineSegments2 | null {
    if (!pairs.length) return null;
    const positions: number[] = [];
    for (const [a, b] of pairs) positions.push(a.x, -a.y, z, b.x, -b.y, z);
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    const line = new LineSegments2(geo, this.lineMaterial(stroke));
    if (stroke.dash) line.computeLineDistances();
    line.name = name;
    line.renderOrder = LINE_RENDER_ORDER;
    if (tag) line.userData["pickTag"] = tag;
    else line.raycast = () => undefined;
    this.built.add(line);
    return line;
  }

  // An item's outline (`outlineOf`, the overlay's), as one object.
  private outline(item: EdItem, z: number, stroke: Stroke, tag: GuideTag | null, name: string): void {
    const sink = new LoopSink();
    pathOutlineInto(sink, item.pos, item.rot, outlineOf(item));
    this.segments(sink.loops.flatMap(loopPairs), z, stroke, tag, name);
  }

  private polyline(points: readonly Vec2[], z: number, stroke: Stroke, tag: GuideTag | null, name: string): void {
    this.segments(loopPairs(points), z, stroke, tag, name);
  }

  private sprite(
    texture: THREE.Texture,
    tint: string,
    px: number,
    at: { x: number; y: number; z: number },
    tag: GuideTag | null,
    name: string,
  ): THREE.Sprite {
    const key = `${texture.uuid}|${tint}`;
    let material = this.spriteMaterials.get(key);
    if (!material) {
      material = new THREE.SpriteMaterial({
        map: texture,
        color: tint,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
        fog: false,
      });
      this.spriteMaterials.set(key, material);
    }
    const s = new THREE.Sprite(material);
    s.position.set(at.x, -at.y, at.z);
    s.renderOrder = SPRITE_RENDER_ORDER;
    s.name = name;
    if (tag) s.userData["pickTag"] = tag;
    else s.raycast = () => undefined;
    this.built.add(s);
    this.sprites.push({ sprite: s, px });
    return s;
  }

  // The overlay's light gizmo (`drawLightGizmo`): the source icon, which is
  // what a light is picked by, and the reach, range and wake rings and a
  // spot's cone on the plane, which are readouts and are not. A light off the
  // plane also gets a stalk down to it, so where the icon stands over the
  // plane can be read at an angle.
  private light(l: EdItem, selected: boolean, pickable: boolean): void {
    const range = l.shape.kind === "circle" ? l.shape.r : 0;
    const planeReach = lightPlaneReach(l);
    const c = l.pos;
    if (planeReach > 0) {
      this.segments(
        loopPairs(circleLoop(c, planeReach)),
        0,
        { color: selected ? SELECT : l.color, px: selected ? SELECTED_OUTLINE_PX : OUTLINE_PX, dash: DASH_VOLUME },
        null,
        "light-reach",
      );
    }
    if (planeReach < range - 1e-6) {
      this.segments(loopPairs(circleLoop(c, range)), 0, { color: l.color, px: FAINT_PX, dash: DASH_RANGE, opacity: 0.35 }, null, "light-range");
    }
    if (lightWakes(l)) {
      this.segments(
        loopPairs(circleLoop(c, lightTrigger(l))),
        0,
        { color: l.color, px: OUTLINE_PX, dash: DASH_WAKE, opacity: 0.8 },
        null,
        "light-wake",
      );
    }
    if (l.light.kind === "spot" && planeReach > 0) {
      const aim = Math.atan2(l.light.dir.y, l.light.dir.x);
      const half = (l.light.angle * Math.PI) / 180;
      const pairs = [-1, 1].map(
        (s) => [c, new Vec2(c.x + Math.cos(aim + s * half) * planeReach, c.y + Math.sin(aim + s * half) * planeReach)] as const,
      );
      this.segments(pairs, 0, { color: l.color, px: FAINT_PX, dash: [4 * PX, 4 * PX] }, null, "light-cone");
    }
    if (l.light.z !== 0) {
      const positions = [c.x, -c.y, 0, c.x, -c.y, l.light.z];
      const geo = new LineSegmentsGeometry();
      geo.setPositions(positions);
      const stalk = new LineSegments2(geo, this.lineMaterial({ color: l.color, px: FAINT_PX, dash: DASH_DOTTED, opacity: 0.6 }));
      stalk.computeLineDistances();
      stalk.name = "light-stalk";
      stalk.renderOrder = LINE_RENDER_ORDER;
      stalk.raycast = () => undefined;
      this.built.add(stalk);
    }
    this.sprite(
      this.icons.burst,
      selected ? SELECT : l.color,
      LIGHT_ICON_PX,
      { x: c.x, y: c.y, z: l.light.z },
      pickable ? guideTag("light", l.id) : null,
      "light-icon",
    );
  }

  // The overlay's spawn marker: the ring at the avatar radius (picked, as the
  // overlay's spawn drag grips it), the ball's footprint at the radius it is
  // played at, half as strong, a crosshair, and a rolling entry's start.
  private spawn(model: EdModel, pickable: boolean): void {
    const p = model.player.pos;
    const r = model.player.radius;
    this.segments(loopPairs(circleLoop(p, r)), 0, { color: PLAYER, px: OUTLINE_PX, dash: null }, pickable ? guideTag("spawn", SPAWN_GUIDE_ID) : null, "spawn");
    this.segments(
      loopPairs(circleLoop(p, r * BallLevel.BALL_RADIUS_SCALE)),
      0,
      { color: PLAYER, px: FAINT_PX, dash: null, opacity: 0.5 },
      null,
      "spawn-footprint",
    );
    const t = r * 1.6;
    this.segments(
      [
        [new Vec2(p.x - t, p.y), new Vec2(p.x + t, p.y)],
        [new Vec2(p.x, p.y - t), new Vec2(p.x, p.y + t)],
      ],
      0,
      { color: PLAYER, px: OUTLINE_PX, dash: null },
      null,
      "spawn-cross",
    );
    if (model.player.roll !== 0) {
      const from = new Vec2(p.x + model.player.roll, p.y);
      this.segments(
        [[from, p], ...loopPairs(circleLoop(from, r))],
        0,
        { color: PLAYER, px: FAINT_PX, dash: DASH_ROLL },
        null,
        "spawn-roll",
      );
    }
  }

  // A polygon's corners and edge midpoints, or a path's (no closing edge, and
  // the midpoint of a curved edge is the curve's own, as `computeHandles`
  // places it), as pixel-sized sprites in the item's own plane.
  private vertexHandles(item: EdItem, z: number, picked: ReadonlySet<number>): void {
    const shape = item.shape;
    if (shape.kind !== "poly" && shape.kind !== "path") return;
    const world = shape.verts.map((v) => toWorld(item, v));
    world.forEach((w, i) => {
      this.sprite(
        picked.has(i) ? this.icons.vertexPicked : this.icons.vertex,
        "#ffffff",
        VERTEX_SPRITE_PX,
        { x: w.x, y: w.y, z },
        guideTag("vertex", item.id, i),
        "vertex",
      );
    });
    const mids: Vec2[] = [];
    if (shape.kind === "poly") {
      const n = world.length;
      for (let i = 0; i < n; i++) mids.push(world[i]!.add(world[(i + 1) % n]!).mul(0.5));
    } else {
      for (let i = 0; i + 1 < shape.verts.length; i++) {
        const a = shape.verts[i]!;
        const b = shape.verts[i + 1]!;
        const out = shape.handles[i]?.out ?? Vec2.ZERO;
        const inn = shape.handles[i + 1]?.in ?? Vec2.ZERO;
        mids.push(toWorld(item, cubicAt(a, a.add(out), b.add(inn), b, 0.5)));
      }
    }
    mids.forEach((m, i) => {
      this.sprite(this.icons.midpoint, "#ffffff", MID_SPRITE_PX, { x: m.x, y: m.y, z }, guideTag("midpoint", item.id, i), "midpoint");
    });
  }
}

// A run of points as consecutive pairs.
function loopPairs(points: readonly Vec2[]): (readonly [Vec2, Vec2])[] {
  const out: (readonly [Vec2, Vec2])[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i]!, points[i + 1]!]);
  return out;
}

export type { GuidePart, GuideTag };
