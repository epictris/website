// `Scene3D` - the WebGL half of the renderer. It owns a renderer, a scene, a
// camera, the lighting, and one visual per body; it consumes exactly the same
// interpolated state the 2D renderer does, and it never touches the sim.
//
// TWO CANVASES, ONE CAMERA. The WebGL canvas sits under the existing 2D one,
// which clears transparent and keeps everything that is genuinely 2D: the debug
// overlay, the aim reticle, the area glyphs, the FPS counter, and in the editor
// the collision outlines and handles. Both are driven from the same `Camera`
// through `space.ts`, so an outline drawn on the top canvas lands pixel-exact on
// the geometry it describes underneath (asserted by `cli render3d`, not eyeballed).
//
// NO MODULE-GLOBAL STATE. Two of these exist at once - the game page and the
// editor - so everything mutable lives on the instance. `playerRig.ts` is the
// anti-pattern this is written against. What IS shared is the material cache in
// `assets.ts`, which is immutable once built and belongs to no scene.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D } from "../engine/body";
import { AnchorBody } from "../engine/body";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import { Hook } from "../classes/hook";
import { Player } from "../classes/player";
import type { World } from "../engine/world";
import type { SceneDecor } from "../level/decor";
import type { SceneChain } from "../level/chains";
import type { LevelVisualSource } from "../level/buildBodies";
import type { EnvironmentData } from "../level/levelFormat";
import type { Camera } from "../render/camera";
import type { ViewTransform } from "../render/viewport";
import {
  BodyVisual,
  DecorVisual,
  type AuthoredVisual,
  type VisualLookup,
} from "./bodyVisuals";
import { BallVisual } from "./ballVisual";
import { ChainLayer } from "./chainVisual";
import { configureRenderer, Environment } from "./environment";
import { FOV_Y_DEG, placeAt, syncCamera, VIEW_ASPECT } from "./space";

// What the 3D renderer needs of a level. Deliberately structural rather than
// `Level | BallLevel`: the editor drives one of these from a model that is
// neither, and a scene that names a concrete level class would have to grow a
// branch per host.
export interface Scene3DLevel {
  readonly world: World;
  readonly decor: readonly SceneDecor[];
  readonly sceneChains: readonly SceneChain[];
  readonly visualSource: LevelVisualSource;
  // The ball & chain avatar, when this level has one. Its sphere, its mounting
  // loop and its chain are drawn by their own modules; a grapple level has none
  // and stays on the 2D path for the avatar (see "Explicitly out of scope").
  readonly ball?: BallPlayer;
}

// Bodies the 3D scene deliberately does not extrude, because something else
// draws them: the grapple avatar and its hook (still 2D), and the ball and its
// hook (drawn by `ballVisual`/`chainVisual` as a cast-iron sphere and a manacle,
// not as an extruded disc).
function drawnElsewhere(body: CollisionObject2D): boolean {
  return (
    body instanceof Player ||
    body instanceof Hook ||
    body instanceof BallPlayer ||
    body instanceof BallHook
  );
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_ASPECT, 0.1, 400);
  private readonly renderer: THREE.WebGLRenderer;
  private env: Environment;
  // What the current `Environment` was built from. The editor rebuilds the whole
  // scene on every model revision - every drag - and an environment is the one
  // part of it whose construction is not free: PMREM convolves the generated sky
  // into a mip chain on the GPU. The lights and the fog are cheap; the
  // convolution is not, and nothing about dragging a wall changes it.
  private envKey: string | null = null;
  private readonly bodies = new Map<CollisionObject2D, BodyVisual>();
  private readonly decor: DecorVisual[] = [];
  private lookup: VisualLookup = () => undefined;
  private ballVisual: BallVisual | null = null;
  private chains: ChainLayer;
  private probe: THREE.Mesh | null = null;
  // Frame counter used to spot bodies that have left the world (see `render`).
  private stamp = 0;
  private viewportRect: { x: number; y: number; w: number; h: number } | null = null;
  private readonly size = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The 2D canvas above is transparent, so this one is what the player sees
      // through it; alpha here would let the page background show through the
      // sky instead of the scene's own.
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(1); // the canvas is already sized in device pixels
    configureRenderer(this.renderer);
    this.env = new Environment(this.scene, undefined, this.renderer);
    this.envKey = JSON.stringify(null);
    this.chains = new ChainLayer(this.scene);
  }

  // Build the scene for a level. Called once per level instance (a reset builds
  // a new level, so it builds a new scene): every static extrusion is created
  // here and nothing but transforms is touched per frame.
  setLevel(level: Scene3DLevel): void {
    this.clearLevel();
    this.setEnvironment(level.visualSource.data.environment);
    this.lookup = makeLookup(level.visualSource);
    for (const body of level.world.bodies) this.ensureBody(body);
    this.buildDecor(level.decor);
    if (level.ball) {
      this.ballVisual = new BallVisual(level.ball);
      this.scene.add(this.ballVisual.root);
    }
  }

  // The environment a level authored, so a host that rebuilds the scene without
  // a level (the editor, between loads) can still light it.
  setEnvironment(env: EnvironmentData | undefined): void {
    const key = JSON.stringify(env ?? null);
    if (key === this.envKey) return;
    this.envKey = key;
    this.env.dispose();
    this.env = new Environment(this.scene, env, this.renderer);
  }

  private ensureBody(body: CollisionObject2D): BodyVisual | null {
    const existing = this.bodies.get(body);
    if (existing) return existing;
    if (drawnElsewhere(body) || !body.hasShape()) return null;
    const visual = new BodyVisual(body, this.lookup);
    this.bodies.set(body, visual);
    this.scene.add(visual.root);
    return visual;
  }

  // Drawn-only shapes. They never reached `world.bodies` - that is what
  // `collision: false` means - so they are built from the level's resolved decor
  // list rather than from the body reconciliation above, and each gets exactly
  // the visual a body's piece gets.
  private buildDecor(decor: readonly SceneDecor[]): void {
    for (const d of decor) {
      const visual = new DecorVisual(d, {
        visual: d.data.visual,
        material: d.data.material,
        thickness: d.data.thickness,
        color: d.data.color,
      });
      this.decor.push(visual);
      this.scene.add(visual.root);
    }
  }

  // A known world rect drawn as a box on the gameplay plane, for checking that
  // the two canvases agree (see `?probe3d=1` in main.ts). It is the acceptance
  // criterion of the whole camera correspondence made visible: the 2D overlay
  // draws the same rect as an outline, and the two must coincide at every zoom
  // and camera position, including mid-blend.
  setProbe(rect: { x: number; y: number; w: number; h: number } | null): void {
    if (this.probe) {
      this.scene.remove(this.probe);
      this.probe.geometry.dispose();
      this.probe = null;
    }
    if (!rect) return;
    // FLAT, on the gameplay plane. A box would project its front face slightly
    // larger than the plane rect the overlay outlines - correct perspective, and
    // exactly the kind of "close but not equal" that makes an alignment check
    // useless. What is being checked is the plane, so the probe is in it.
    const geo = new THREE.PlaneGeometry(rect.w, rect.h);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff3366 }));
    placeAt(mesh, new Vec2(rect.x, rect.y));
    this.scene.add(mesh);
    this.probe = mesh;
  }

  // Size the drawing buffer. `view` is the same transform the 2D canvas is drawn
  // with, so the two buffers are the same size in device pixels and a pixel on
  // one is a pixel on the other.
  resize(view: ViewTransform): void {
    this.renderer.setSize(view.width * view.scale, view.height * view.scale, false);
  }

  // Size the drawing buffer to a canvas outright. The editor's canvas IS the
  // window rather than the fixed 16:9 frame, so it has no `ViewTransform` to be
  // sized by; the camera's own viewport is what says how much world is in it
  // (see `visibleHeightMetres`).
  resizeTo(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  // Draw into a sub-rectangle of the canvas rather than all of it, in device
  // pixels with the origin at the BOTTOM left (WebGL's convention, not the 2D
  // canvas's). The editor's `▶ Test` needs it: a test plays in the game's fixed
  // frame fitted into the whole editor canvas, and what is left over has to stay
  // letterbox rather than being filled with more scene.
  setViewportRect(rect: { x: number; y: number; w: number; h: number } | null): void {
    this.viewportRect = rect;
  }

  // One rendered frame. `alpha` is the interpolation factor the 2D renderer
  // takes, and every transform below is read at it.
  render(level: Scene3DLevel, camera: Camera, alpha: number): void {
    const rect = this.viewportRect;
    if (rect) {
      this.renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
      this.renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
      this.renderer.setScissorTest(true);
    } else {
      // Back to the whole canvas. `setViewport` persists on the renderer, so a
      // host that has ever drawn into a sub-rect (the editor's letterboxed
      // test) has to say so when it stops.
      this.renderer.getSize(this.size);
      this.renderer.setViewport(0, 0, this.size.x, this.size.y);
      this.renderer.setScissorTest(false);
    }
    syncCamera(this.camera, camera);
    this.env.follow(camera);

    // Bodies come and go at runtime (the hook is destroyed and rebuilt on every
    // throw, the sandbox spawns rocks), so the visual set is reconciled rather
    // than assumed. Each body the world still has stamps its visual with this
    // frame; a count that does not match the map is a body that has gone, and
    // only then is the map swept. One pass over an array of ~154, no allocation
    // unless the set actually changed.
    this.stamp++;
    let seen = 0;
    for (const body of level.world.bodies) {
      const visual = this.ensureBody(body);
      if (!visual) continue;
      visual.stamp = this.stamp;
      seen++;
    }
    if (seen !== this.bodies.size) this.dropStaleBodies();

    for (const visual of this.bodies.values()) visual.sync(alpha);

    for (const d of this.decor) d.sync(alpha);

    this.chains.sync(level, alpha);
    this.ballVisual?.sync(alpha);

    this.renderer.render(this.scene, this.camera);
  }

  private dropStaleBodies(): void {
    for (const [body, visual] of this.bodies) {
      if (visual.stamp === this.stamp) continue;
      this.scene.remove(visual.root);
      visual.dispose();
      this.bodies.delete(body);
    }
  }

  private clearLevel(): void {
    for (const visual of this.bodies.values()) {
      this.scene.remove(visual.root);
      visual.dispose();
    }
    this.bodies.clear();
    for (const d of this.decor) {
      this.scene.remove(d.root);
      d.dispose();
    }
    this.decor.length = 0;
    if (this.ballVisual) {
      this.scene.remove(this.ballVisual.root);
      this.ballVisual.dispose();
      this.ballVisual = null;
    }
    this.chains.clear();
  }

  dispose(): void {
    this.clearLevel();
    this.chains.dispose();
    this.env.dispose();
    this.renderer.dispose();
  }
}

// The authored visual for a given piece of a given body, assembled once per
// level from `LevelData.bodies` zipped with what `buildLevelBodies` made of
// them. There is no stable authored id in this format - chains already link by
// array index through `byIndex` - so this links the same way, and
// `shapeIndexByIndex` says which PIECE of a compound body each entry became.
function makeLookup(source: LevelVisualSource): VisualLookup {
  const table = new Map<CollisionObject2D, AuthoredVisual[]>();
  source.data.bodies.forEach((b, i) => {
    const body = source.built.byIndex[i];
    if (!body) return;
    const shapeIndex = source.built.shapeIndexByIndex[i] ?? 0;
    let entries = table.get(body);
    if (!entries) {
      entries = [];
      table.set(body, entries);
    }
    entries[shapeIndex] = {
      visual: b.visual,
      material: b.material,
      thickness: b.thickness,
      color: b.color,
    };
  });
  return (body, shapeIndex) => table.get(body)?.[shapeIndex];
}

// Hook-only scenery is drawn behind the solid geometry it sits among in the 2D
// renderer, and the 3D one says the same thing with depth instead of order (see
// `BodyVisual`). Exported so the 2D overlay and this agree about which bodies
// they are each responsible for.
export function isPassThroughScenery(body: CollisionObject2D): boolean {
  return body instanceof AnchorBody;
}
