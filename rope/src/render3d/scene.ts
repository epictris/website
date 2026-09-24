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
import { VineLink } from "../engine/body";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import { Hook } from "../classes/hook";
import { Player } from "../classes/player";
import type { World } from "../engine/world";
import type { SceneChain } from "../level/chains";
import type { VineCord } from "../level/vines";
import type { LevelVisualSource } from "../level/buildBodies";
import type { EnvironmentData } from "../level/levelFormat";
import type { Camera } from "../render/camera";
import type { ViewTransform } from "../render/viewport";
import { GpuTimer } from "../render/gpuTimer";
import { BodyVisual, pickTagOf, surfaceOf } from "./bodyVisuals";
import { BallVisual } from "./ballVisual";
import { ChainLayer } from "./chainVisual";
import { VineLayer } from "./vineVisual";
import type { ChainRetract } from "../render/chainRetract";
import { configureRenderer, Environment } from "./environment";
import { LightRig } from "./lights";
import { cloneWithPatches, isOrthographicMaterial, orthoFramedZ } from "./projection";
import {
  CAMERA_FAR,
  DEFAULT_LENS,
  FOV_Y_DEG,
  lensOf,
  NO_ORBIT,
  placeAt,
  syncCamera,
  VIEW_ASPECT,
  type CameraOrbit,
  type SceneLens,
  type ViewCamera,
  type ViewProjection,
} from "./space";
import { updateWater, waterTextures } from "./water";

// What the 3D renderer needs of a level. Deliberately structural rather than
// `Level | BallLevel`: the editor drives one of these from a model that is
// neither, and a scene that names a concrete level class would have to grow a
// branch per host.
export interface Scene3DLevel {
  readonly world: World;
  readonly sceneChains: readonly SceneChain[];
  // The vines to draw, as cords rather than as `Vine`s: the editor draws them
  // too and has no links to read, so what it hands over is the rest pose (see
  // `VineCord`). Absent = a level with no vines, which is every level and every
  // host that predates them.
  readonly vines?: readonly VineCord[];
  readonly visualSource: LevelVisualSource;
  // The ball & chain avatar, when this level has one. Its sphere, its mounting
  // loop and its chain are drawn by their own modules; a grapple level has none
  // and stays on the 2D path for the avatar (see "Explicitly out of scope").
  readonly ball?: BallPlayer;
}

// Bodies the 3D scene deliberately does not extrude, because something else
// draws them: the grapple avatar and its hook (still 2D), the ball and its hook
// (drawn by `ballVisual`/`chainVisual` as a cast-iron sphere and a manacle, not
// as an extruded disc), and a vine's links.
//
// A vine link is the one of these that is not an avatar, and it is here for the
// plainest reason of all: a link's circle is its GRAB radius, several times the
// gauge a vine is drawn at, and a vine is one cord rather than twenty beads.
// Extruded like scenery it draws as a stack of brown spheres with the cord
// painted down the middle of them. `drawVines` on the 2D overlay is what draws a
// vine in both render modes, exactly as the rope is.
// A host with no vines at all, so `sync` takes one list rather than a branch.
const NO_VINES: readonly VineCord[] = [];

function drawnElsewhere(body: CollisionObject2D): boolean {
  return (
    body instanceof Player ||
    body instanceof Hook ||
    body instanceof BallPlayer ||
    body instanceof BallHook ||
    body instanceof VineLink
  );
}

export interface Scene3DOptions {
  // Report shader compile/link failures where a harness can see them, and keep
  // the drawing buffer readable after a frame (see the constructor). `shotMain`
  // is the only caller: the game wants neither, and `preserveDrawingBuffer`
  // costs real frame time.
  diagnostics?: boolean;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  // The two lenses (see `ViewProjection`). Both exist for the whole life of the
  // scene rather than one being rebuilt on a toggle: a camera is a transform and
  // a frustum, both rewritten from the 2D camera every frame, so keeping the
  // pair costs nothing and leaves the gizmo something stable to be attached to.
  private readonly perspective = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_ASPECT, 0.1, CAMERA_FAR);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_FAR);
  // The lens and z offset the current level asked for (`LevelCameraData`).
  private lens: SceneLens = DEFAULT_LENS;
  // The game never touches this: it is played through the perspective camera the
  // levels are framed against, and only the editor offers the other.
  private projection: ViewProjection = "perspective";
  private readonly renderer: THREE.WebGLRenderer;
  private env: Environment;
  // What the current `Environment` was built from. The editor rebuilds the whole
  // scene on every model revision - every drag - and an environment is the one
  // part of it whose construction is not free: PMREM convolves the generated sky
  // into a mip chain on the GPU. The lights and the fog are cheap; the
  // convolution is not, and nothing about dragging a wall changes it.
  private envKey: string | null = null;
  // Every light in the level. It is rebuilt with the BODIES rather than kept
  // across a level change, because a light is an object inside a body now: each
  // one is a child of the group its body is drawn in, so its lifetime is that
  // body's and there is nothing to key it separately on.
  private readonly lights = new LightRig();
  // Wall-clock seconds, or a PINNED value. The flicker and the water read it,
  // and only
  // a headless grab pins it: a screenshot whose lighting depends on when it was
  // taken is evidence of nothing, which is the same reason the SVG snapshot
  // pins the force areas' arrow phase at 0.
  private pinnedClock: number | null = null;
  // Bodies that are IN THE WORLD, keyed by their engine object. Reconciled every
  // frame, because bodies come and go at runtime (the hook is destroyed and
  // rebuilt on every throw, the sandbox spawns rocks).
  private readonly bodies = new Map<CollisionObject2D, BodyVisual>();
  // Authored bodies that built no engine object - decoration, a light with no
  // fitting. They are not in the world, so they can neither be found by the
  // reconciliation nor go stale: they live exactly as long as the level does.
  private readonly standing: BodyVisual[] = [];
  private ballVisual: BallVisual | null = null;
  private chains: ChainLayer;
  private vines: VineLayer;
  private probe: THREE.Mesh | null = null;
  // Picking and highlighting (editor only; the game never clicks the scene).
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly forward = new THREE.Vector3();
  // What each highlighted tag is painted with, and the materials the meshes
  // under it were wearing before. The set is diffed rather than rebuilt, so a
  // prop that arrives after the selection was made is picked up on the next
  // frame with no bookkeeping at the call site.
  private highlight: ReadonlyMap<unknown, string> = new Map();
  // The colour a mesh is currently painted, and what it was wearing before. The
  // colour is kept because it CHANGES without the set changing: picking an object
  // out of the body that was selected repaints the same meshes from "part of the
  // selected body" to "the selection", and a diff on membership alone leaves them
  // saying the first of those.
  private readonly highlighted = new Map<
    THREE.Mesh,
    { color: string; material: THREE.Material | THREE.Material[] }
  >();
  // Clones this scene made and must free, keyed by colour and source material.
  private readonly highlightMaterials = new Map<string, THREE.Material>();
  // Frame counter used to spot bodies that have left the world (see `render`).
  private stamp = 0;
  private viewportRect: { x: number; y: number; w: number; h: number } | null = null;
  private readonly size = new THREE.Vector2();

  // Diagnostics: the shader-error log and the frame readback below cost the game
  // nothing because only `shotMain` asks for them.
  private readonly diagnostics: boolean;
  // The GPU's own clock around the draw (see render/gpuTimer.ts). Always on: an
  // asynchronous query is a couple of GL calls a frame, and it is the only
  // reading that distinguishes a GPU-bound frame from a CPU-bound one.
  private readonly gpuTimer: GpuTimer | null;

  constructor(canvas: HTMLCanvasElement, opts: Scene3DOptions = {}) {
    this.diagnostics = opts.diagnostics === true;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The 2D canvas above is transparent, so this one is what the player sees
      // through it; alpha here would let the page background show through the
      // sky instead of the scene's own.
      alpha: false,
      powerPreference: "high-performance",
      // A frame grab has to read the drawing buffer back after it is drawn -
      // `drawImage` into a filmstrip tile, and the all-black check - and without
      // this the buffer is cleared the moment the frame is composited, so a
      // readback a task later hands back an empty picture that looks exactly
      // like a scene that drew nothing.
      preserveDrawingBuffer: this.diagnostics,
    });
    if (this.diagnostics) this.installShaderErrorReporting();
    this.renderer.setPixelRatio(1); // the canvas is already sized in device pixels
    configureRenderer(this.renderer);
    this.env = new Environment(this.scene, undefined, this.renderer);
    this.envKey = JSON.stringify(null);
    this.chains = new ChainLayer(this.scene);
    this.vines = new VineLayer(this.scene);
    // Null wherever the driver has no timer extension (see GpuTimer); the perf
    // HUD says so rather than plotting a zero.
    this.gpuTimer = GpuTimer.create(this.renderer.getContext());
  }

  // GPU milliseconds for the most recently retired frame, or null while the
  // first query is still in flight - or for ever, on a context with no timer
  // extension. Read by the perf HUD (see render/perfHud.ts).
  gpuFrameMs(): number | null {
    return this.gpuTimer?.lastMs ?? null;
  }

  // Build the scene for a level. Called once per level instance (a reset builds
  // a new level, so it builds a new scene): every static extrusion is created
  // here and nothing but transforms is touched per frame.
  setLevel(level: Scene3DLevel): void {
    this.clearLevel();
    this.setEnvironment(level.visualSource.data.environment);
    this.lens = lensOf(level.visualSource.data.camera);
    // Authored bodies FIRST, and in authored order, because the light budgets
    // are spent in that order: a level whose lamps are drawn in a different
    // order from the one it was authored in is a level whose lamps go out
    // somewhere else every time it loads.
    //
    // A body that built an engine object is registered under it, so the
    // reconciliation below finds it already made rather than building a second,
    // authorless visual for the same body.
    for (const built of level.visualSource.built.bodies) {
      const visual = new BodyVisual(built.body, built, this.lights);
      this.scene.add(visual.root);
      if (built.body) this.bodies.set(built.body, visual);
      else this.standing.push(visual);
    }
    // Then whatever else the world already holds - the avatar's debris, a
    // sandbox rock spawned before the scene was built.
    for (const body of level.world.bodies) this.ensureBody(body);
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

  // Freeze the flicker clock at `seconds`, or hand it back to the wall clock
  // with null. `cli shot --3d` pins it so the same command twice is the same
  // picture.
  pinClock(seconds: number | null): void {
    this.pinnedClock = seconds;
  }

  // A shader that fails to compile draws NOTHING, so the failure reaches a
  // screenshot as an ordinary-looking scene with one mesh missing, or as a blank
  // page - which is why an entire day of renderer work went by with zero THREE
  // diagnostics seen. Reported through `console.error`, which the page-side
  // buffer (see shot.html) picks up like any other message.
  //
  // WHEN it fires is the part worth knowing. three checks the link status in
  // `onFirstUse`, which runs from `WebGLProgram.getUniforms()` - so neither
  // `compile()` nor `compileAsync()` triggers it, and the first `render()` does,
  // synchronously, whether or not `KHR_parallel_shader_compile` is present. A
  // grab that renders before it sets `shotReady` therefore has the diagnostic in
  // the buffer by then; the link check at the end of `prewarm` below is what
  // widens that from "every material drawn this frame" to "every material in
  // the scene".
  private installShaderErrorReporting(): void {
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const logs = [
        `program: ${gl.getProgramInfoLog(program)?.trim() ?? ""}`,
        `vertex: ${gl.getShaderInfoLog(vertexShader)?.trim() ?? ""}`,
        `fragment: ${gl.getShaderInfoLog(fragmentShader)?.trim() ?? ""}`,
      ].filter((l) => !l.endsWith(": "));
      console.error(`THREE shader error - ${logs.join(" | ")}`);
    };
  }

  // Every cost three defers to FIRST USE, paid here instead - under the loading
  // screen, where a long frame is nobody's problem. Run once per level, after
  // the assets have settled and after a warm frame from the camera the first
  // played frame uses (see `boot` in main.ts). The rule it enforces: nothing
  // is built, compiled or uploaded on a played frame that could have been
  // built here.
  //
  // What three defers, and what pays each one below:
  //
  // - A material's PROGRAM is compiled the first time a mesh wearing it is
  //   drawn inside the frustum. `compile()` over the scene compiles every
  //   material on every object, visible or not, and `compileAsync()` waits for
  //   the driver, in parallel where it can.
  // - The SHADOW PASS wears its own materials: one depth material for spot and
  //   directional lights and one distance material for point lights, which it
  //   reconfigures per caster (side, map, alpha test) and keys per object
  //   (instancing). Each caster variant is therefore a program of its own,
  //   compiled the first time such a caster is inside a shadow camera - the
  //   chain, the first time it is thrown near a lamp. `shadowVariants` builds
  //   one stand-in per variant and compiles them against this scene's lights.
  // - A TEXTURE is uploaded, and its mip chain generated, the first time a
  //   material sampling it is drawn. `initTexture` over every texture the
  //   scene's materials and the water shader sample does it now.
  // - A GEOMETRY's buffers are uploaded the first time it is drawn. One draw
  //   of the whole scene with culling off and nothing hidden does that, and is
  //   also what runs the real shadow pass for every static caster.
  //
  // `session-1697f` is the receipt: a lantern wearing the level's only emissive
  // map scrolled into view 26 s into a run and cost a 15 ms frame plus a 45 ms
  // GPU-process stall (docs/debugging-rendering.md). `cli shot --probe all`
  // is the check that nothing is left: over a whole replay after this has run,
  // the program and texture counts must not move.
  //
  // The link check at the end is the diagnostic half. three reads the link
  // status in `onFirstUse`, from `WebGLProgram.getUniforms()`, so neither
  // `compile()` nor `compileAsync()` reports a failed program; asking each one
  // for its uniforms is what turns the failure into the `console.error` of
  // `installShaderErrorReporting`, and the answer is cached for the frame that
  // asks next.
  async prewarm(
    level: Scene3DLevel,
    camera: Camera,
  ): Promise<{ ms: number; programs: number; textures: number }> {
    const t0 = performance.now();
    // As a frame would: reconcile the visuals, settle the camera and the
    // environment, size the shadow maps.
    this.render(level, camera, 1);

    const materials = this.renderer.compile(this.scene, this.camera);
    await this.renderer.compileAsync(this.scene, this.camera);

    const variants = this.shadowVariants();
    // The shadow pass compiles against an EMPTY scene, so no fog - and fog is
    // part of a program's key whether or not its material uses it.
    const fog = this.scene.fog;
    this.scene.fog = null;
    try {
      await this.renderer.compileAsync(variants.scene, this.camera, this.scene);
    } finally {
      this.scene.fog = fog;
      variants.dispose();
    }

    for (const texture of this.sampledTextures()) this.renderer.initTexture(texture);

    this.drawEverythingOnce();

    for (const material of materials) {
      // `WebGLProperties.get` is typed as an opaque bag; what is in it for a
      // material is the program three built for it.
      const props = this.renderer.properties.get(material) as {
        currentProgram?: { getUniforms(): unknown };
      };
      props.currentProgram?.getUniforms();
    }
    return {
      ms: performance.now() - t0,
      programs: this.renderer.info.programs?.length ?? 0,
      textures: this.renderer.info.memory.textures,
    };
  }

  // One stand-in per shadow-pass program the scene can ask for, mirroring how
  // `WebGLShadowMap.getDepthMaterial` dresses its material for a caster: the
  // side flipped (a PCF map is drawn from the back faces), the caster's map and
  // alpha map carried over for the alpha test, and the object's own instancing
  // reflected in the stand-in's class. Distinct variants only; the program
  // cache would fold the rest anyway.
  //
  // Real geometries are shared so the attribute set matches (a prop with a
  // second UV set is a different program from an extrusion). The one caster
  // that cannot be found in the scene is the one the sim spawns mid-play - the
  // hook, a sandbox rock - drawn as an extrusion wearing the spawned-body
  // surface (see `BodyVisual`); a box has the same attributes as an extrusion.
  private shadowVariants(): { scene: THREE.Scene; dispose(): void } {
    const scene = new THREE.Scene();
    const owned: THREE.Material[] = [];
    const spawnedGeometry = new THREE.BoxGeometry(1, 1, 1);
    let depth = false;
    let distance = false;
    this.scene.traverse((o) => {
      const light = o as THREE.Light;
      if (!light.isLight || !light.castShadow) return;
      if ((light as THREE.PointLight).isPointLight) distance = true;
      else depth = true;
    });
    const dispose = (): void => {
      for (const m of owned) m.dispose();
      spawnedGeometry.dispose();
    };
    if (!depth && !distance) return { scene, dispose };

    const flipped: Record<number, THREE.Side> = {
      [THREE.FrontSide]: THREE.BackSide,
      [THREE.BackSide]: THREE.FrontSide,
      [THREE.DoubleSide]: THREE.DoubleSide,
    };
    const seen = new Set<string>();
    const add = (object: THREE.Mesh, material: THREE.Material): void => {
      const bag = material as unknown as {
        map?: THREE.Texture | null;
        alphaMap?: THREE.Texture | null;
        alphaTest: number;
        alphaToCoverage: boolean;
        shadowSide: THREE.Side | null;
        side: THREE.Side;
      };
      const instanced = (object as THREE.InstancedMesh).isInstancedMesh === true;
      const coloured = instanced && (object as THREE.InstancedMesh).instanceColor !== null;
      const side = bag.shadowSide ?? flipped[bag.side] ?? bag.side;
      const alphaTest = bag.alphaToCoverage ? 0.5 : bag.alphaTest;
      const attributes = Object.keys(object.geometry.attributes).sort().join(",");
      const key = [instanced, coloured, side, !!bag.map, !!bag.alphaMap, alphaTest > 0, attributes].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      const standIn = (shadowMaterial: THREE.MeshDepthMaterial | THREE.MeshDistanceMaterial): void => {
        shadowMaterial.side = side;
        shadowMaterial.map = bag.map ?? null;
        shadowMaterial.alphaMap = bag.alphaMap ?? null;
        shadowMaterial.alphaTest = alphaTest;
        owned.push(shadowMaterial);
        const mesh = instanced
          ? new THREE.InstancedMesh(object.geometry, shadowMaterial, 1)
          : new THREE.Mesh(object.geometry, shadowMaterial);
        if (coloured) {
          (mesh as THREE.InstancedMesh).instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(3),
            3,
          );
        }
        mesh.castShadow = object.castShadow;
        mesh.receiveShadow = object.receiveShadow;
        scene.add(mesh);
      };
      if (depth) standIn(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
      if (distance) standIn(new THREE.MeshDistanceMaterial());
    };
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.castShadow || !mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) add(mesh, m);
    });
    const spawned = new THREE.Mesh(spawnedGeometry, surfaceOf({}));
    spawned.castShadow = true;
    spawned.receiveShadow = true;
    add(spawned, spawned.material);
    return { scene, dispose };
  }

  // Every texture a played frame could bind: the map slots of every material on
  // every object, hidden ones included, the sky, the environment, and the
  // water shader's own uniforms, which no material slot names.
  private sampledTextures(): Set<THREE.Texture> {
    const out = new Set<THREE.Texture>();
    const take = (value: unknown): void => {
      const texture = value as THREE.Texture | null;
      // A texture with no image yet would only log; its upload lands with it.
      if (texture && texture.isTexture && texture.image) out.add(texture);
    };
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(m)) take(value);
      }
    });
    take(this.scene.background);
    take(this.scene.environment);
    for (const texture of waterTextures()) take(texture);
    return out;
  }

  // Draw the scene once as synced by the last `render`, with nothing culled and
  // nothing hidden, so every geometry's buffers go up and every caster meets
  // the real shadow pass. Hidden things (the manacle between uses, a prop's
  // placeholder) are put back exactly as found; the next played frame's sync
  // would anyway.
  private drawEverythingOnce(): void {
    const restore: Array<() => void> = [];
    this.scene.traverse((o) => {
      const { visible, frustumCulled } = o;
      restore.push(() => {
        o.visible = visible;
        o.frustumCulled = frustumCulled;
      });
      o.visible = true;
      o.frustumCulled = false;
    });
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      for (const put of restore) put();
    }
  }

  // Fraction of the drawn frame that is not the clear colour, sampled from the
  // drawing buffer itself rather than from a composited canvas. The late-frame
  // blank flake (`shot --3d` returning a uniformly empty picture) has no other
  // detector: an empty frame is a perfectly valid PNG and every CLI view of the
  // sim calls the same run healthy.
  //
  // Diagnostics-only, since it needs `preserveDrawingBuffer` and reads the whole
  // buffer back off the GPU.
  litFraction(): number {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (w === 0 || h === 0) return 0;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // Against BLACK rather than against the clear colour: what is being detected
    // is a frame that never drew, and a canvas that has only been cleared still
    // carries the sky, which is exactly the case this must not call blank.
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! > 2 || pixels[i + 1]! > 2 || pixels[i + 2]! > 2) lit++;
    }
    return lit / (w * h);
  }

  // What the renderer drew this frame. Read-only, and read from three's own
  // counters rather than kept alongside them.
  renderStats(): { calls: number; triangles: number; programs: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  // Programs and textures the renderer has built so far, and every mesh whose
  // program is NEW since the last call - which is the frame three compiled it
  // on. A program is compiled the first time a mesh wearing it is drawn, not
  // when its material is made, so a material combination nothing on screen
  // used until now costs a compile (and its textures an upload) mid-play; this
  // is how `shot --probe` names the mesh that did it.
  //
  // `pending` is the other half of the same question: how many textures the
  // scene's materials name that the renderer has not uploaded yet, each of
  // which is an upload waiting for the first frame its mesh is drawn.
  private readonly probedPrograms = new Set<number>();
  programProbe(): { programs: number; textures: number; pending: number; fresh: string[] } {
    const fresh: string[] = [];
    const MAP_KEYS = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"] as const;
    // Per SOURCE, not per texture object: `buildSurface` clones its maps per
    // body, and three uploads a source once and binds every clone to it.
    const sources = new Set<object>();
    const uploaded = new Set<object>();
    this.scene.traverse((obj) => {
      // Anything drawn: meshes, but also lines and points, which wear a
      // material and a program of their own without being meshes.
      const mesh = obj as THREE.Mesh;
      if (!mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const bag = material as unknown as Record<string, unknown>;
        for (const k of MAP_KEYS) {
          const tex = bag[k] as THREE.Texture | undefined;
          if (!tex) continue;
          const tp = this.renderer.properties.get(tex) as { __webglTexture?: unknown };
          sources.add(tex.source);
          if (tp.__webglTexture !== undefined) uploaded.add(tex.source);
        }
        const props = this.renderer.properties.get(material) as {
          currentProgram?: { id: number; name: string };
        };
        const program = props.currentProgram;
        if (!program || this.probedPrograms.has(program.id)) continue;
        this.probedPrograms.add(program.id);
        const maps = MAP_KEYS.filter((k) => bag[k]).join(",");
        const p = new THREE.Vector3();
        mesh.getWorldPosition(p);
        const chain: string[] = [];
        for (let o: THREE.Object3D | null = mesh; o; o = o.parent) chain.push(o.name || o.type);
        fresh.push(
          `${program.name}#${program.id} ${material.type}[${maps}] ` +
            `at (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) via ${chain.join("<")}`,
        );
      }
    });
    // Programs no scene material wears are three's own: the depth and distance
    // materials of the shadow pass, compiled per caster variant (map, side,
    // instancing) the first time such a caster falls inside a shadow camera.
    for (const program of this.renderer.info.programs ?? []) {
      if (this.probedPrograms.has(program.id)) continue;
      this.probedPrograms.add(program.id);
      fresh.push(`${program.name}#${program.id} (shadow pass)`);
    }
    return {
      programs: this.renderer.info.programs?.length ?? 0,
      textures: this.renderer.info.memory.textures,
      pending: sources.size - uploaded.size,
      fresh,
    };
  }

  // A body the world holds that the level did not author: a spawned rock, the
  // hook. It extrudes what it collides as and has no objects of its own, which
  // is why it is built with no `BuiltBody` behind it.
  private ensureBody(body: CollisionObject2D): BodyVisual | null {
    const existing = this.bodies.get(body);
    if (existing) return existing;
    if (drawnElsewhere(body) || !body.hasShape()) return null;
    const visual = new BodyVisual(body, null, this.lights);
    this.bodies.set(body, visual);
    this.scene.add(visual.root);
    return visual;
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

  // The camera the next frame will be drawn through. It is the object the
  // editor's gizmo raycasts against, which is why the pair is stable: a toggle
  // hands out the other camera rather than replacing one.
  get camera(): ViewCamera {
    return this.projection === "orthographic" ? this.orthographic : this.perspective;
  }

  setProjection(projection: ViewProjection): void {
    this.projection = projection;
  }

  // WHAT IS UNDER THE POINTER, nearest first, as the pick tags the drawn objects
  // were built with (see `pickTagOf`). `x`/`y` are normalised device coordinates
  // - the ray is cast through the camera the LAST frame was drawn with, which is
  // the camera the thing on screen was drawn by, so the answer is about the
  // picture the pointer was actually aimed at.
  //
  // This is the only honest way to pick a scene that is drawn in 3D. A 2D test
  // against an object's authored outline answers about the rectangle a prop was
  // PLACED with rather than about the prop, so a lamp bracket 10 cm across is
  // clicked by a metre of empty air around it and a pipe running behind a wall
  // is clicked through the wall. It also holds at any depth and any lens, which
  // an outline test on the gameplay plane cannot.
  //
  // Duplicates are dropped rather than repeated: a prop is many meshes and one
  // thing, and a caller walking the list wants the next OBJECT down.
  //
  // An object drawn through the orthographic lens (`GeometryObjectData.projection`)
  // is on screen where the ORTHOGRAPHIC camera puts it, so it is picked by that
  // camera's ray - both cameras are synced to the same view every frame - and
  // the two lists are merged by depth along the view axis, the quantity the
  // depth buffer sorted them by when they were drawn.
  pick(x: number, y: number): unknown[] {
    this.pointer.set(x, y);
    const split = this.camera === this.perspective;
    const hits: { object: THREE.Object3D; depth: number }[] = [];
    const cast = (cam: ViewCamera, ortho: boolean): void => {
      cam.getWorldDirection(this.forward);
      this.raycaster.setFromCamera(this.pointer, cam);
      for (const hit of this.raycaster.intersectObjects(this.scene.children, true)) {
        const mesh = hit.object as THREE.Mesh;
        const drawnOrtho = mesh.isMesh && isOrthographicMaterial(mesh.material);
        // Under the orthographic scene camera there is one ray, and every
        // object is answered by it.
        if (split && drawnOrtho !== ortho) continue;
        hits.push({ object: hit.object, depth: this.forward.dot(hit.point.sub(cam.position)) });
      }
    };
    cast(this.camera, false);
    if (split) cast(this.orthographic, true);
    hits.sort((a, b) => a.depth - b.depth);
    const out: unknown[] = [];
    const seen = new Set<unknown>();
    for (const hit of hits) {
      const tag = pickTagOf(hit.object);
      if (tag === undefined || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
    return out;
  }

  // Paint the drawn objects named by these tags, each in its own colour. It is
  // the 3D scene's answer to the overlay's selection halo, and it exists for the
  // same reason `pick` does: what is selected is a MODEL, and a rectangle drawn
  // round it on the plane describes something else.
  //
  // Applied on the next rendered frame rather than here, so a caller may set it
  // as often as it likes and a prop that loads later still lights up.
  setHighlight(tags: ReadonlyMap<unknown, string>): void {
    this.highlight = tags;
  }

  private syncHighlight(): void {
    const want = new Map<THREE.Mesh, string>();
    if (this.highlight.size) {
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const color = this.highlight.get(pickTagOf(mesh));
        if (color !== undefined) want.set(mesh, color);
      });
    }
    for (const [mesh, painted] of this.highlighted) {
      if (want.get(mesh) === painted.color) continue;
      mesh.material = painted.material;
      this.highlighted.delete(mesh);
    }
    for (const [mesh, color] of want) {
      if (this.highlighted.has(mesh)) continue;
      const material = mesh.material;
      this.highlighted.set(mesh, { color, material });
      mesh.material = Array.isArray(material)
        ? material.map((m) => this.highlightMaterial(m, color))
        : this.highlightMaterial(material, color);
    }
  }

  // The selected look of one material: the surface it already wears, lit from
  // within. A tint over the albedo would be invisible on a dark prop and a flat
  // colour would hide the thing being judged, and this reads as selection at any
  // brightness while leaving the model's own shape and grain to be looked at.
  //
  // The emissive MAP is dropped with it: a lamp's own glow pattern is exactly
  // what the selection colour has to be told apart from.
  private highlightMaterial(src: THREE.Material, color: string): THREE.Material {
    const key = `${color}|${src.uuid}`;
    const existing = this.highlightMaterials.get(key);
    if (existing) return existing;
    // Keeping the source's shader patches: a plain clone drops the painted light
    // and an orthographic object's lens, so selecting a thing would change what
    // it looks like and, for an ortho one, where it is drawn.
    const clone = cloneWithPatches(src);
    const std = clone as THREE.MeshStandardMaterial;
    if (std.isMeshStandardMaterial) {
      std.emissive = new THREE.Color(color);
      std.emissiveIntensity = 0.5;
      std.emissiveMap = null;
    }
    this.highlightMaterials.set(key, clone);
    return clone;
  }

  private clearHighlight(): void {
    // The meshes are about to be disposed with their visuals, so only the
    // clones this scene made are its to free.
    this.highlighted.clear();
    for (const m of this.highlightMaterials.values()) m.dispose();
    this.highlightMaterials.clear();
  }

  // One rendered frame. `alpha` is the interpolation factor the 2D renderer
  // takes, and every transform below is read at it.
  // `orbit` turns the view about what it is looking at, and only the editor ever
  // passes one (see `CameraOrbit`); the game's view is always head-on.
  render(
    level: Scene3DLevel,
    camera: Camera,
    alpha: number,
    orbit: CameraOrbit = NO_ORBIT,
    // The released chain reeling back into the ball, if one is (see
    // render/chainRetract.ts); session state the host keeps, like the sparks.
    retract: ChainRetract | null = null,
  ): void {
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
    syncCamera(this.camera, camera, this.lens, orbit);
    // The lens not being drawn through is kept on the same view too: an object
    // drawn orthographically inside a perspective frame is where the
    // orthographic camera would put it, and `pick` asks that camera about it.
    syncCamera(
      this.camera === this.perspective ? this.orthographic : this.perspective,
      camera,
      this.lens,
      orbit,
    );
    // Written every frame rather than at `setLevel`, because it is shared by
    // every scene on the page (see `orthoFramedZ`).
    orthoFramedZ.value = this.lens.zOffset;
    this.env.follow(camera);
    const clock = this.pinnedClock ?? performance.now() / 1000;
    this.lights.update(clock);
    // The spray's point sprites are sized in metres and need the viewport's
    // pixel height to stay that size (see water.ts `updateWater`).
    updateWater(clock, rect ? rect.h : this.size.y);

    // Bodies come and go at runtime (the hook is destroyed and rebuilt on every
    // throw, the sandbox spawns rocks), so the visual set is reconciled rather
    // than assumed. Each body the world still has stamps its visual with this
    // frame; a count that does not match the map is a body that has gone, and
    // only then is the map swept. One pass over an array of ~154, no allocation
    // unless the set actually changed.
    //
    // Only the ones in the world take part. An authored body that built nothing
    // is not in `world.bodies` and never could be, so sweeping it would delete
    // every backdrop on the first frame.
    this.stamp++;
    let seen = 0;
    const stamp = (body: CollisionObject2D): void => {
      const visual = this.ensureBody(body);
      if (!visual) return;
      visual.stamp = this.stamp;
      seen++;
    };
    for (const body of level.world.bodies) stamp(body);
    // AREAS ARE A SECOND LIST. `World` keeps them apart from the physics bodies
    // (they are regions rather than things that collide), so a sweep that walked
    // `bodies` alone stamped none of them - and every area visual built in
    // `setLevel` was therefore swept as stale on the very first frame. Nothing
    // reported it, because for every area the 2D overlay's glyphs are the whole
    // of what the player is meant to see and the extrusion behind them is not
    // load-bearing - but a visual that cannot survive frame one is a bug waiting
    // for the first area that does need to be drawn.
    for (const area of level.world.areas) stamp(area);
    if (seen !== this.bodies.size) this.dropStaleBodies();

    for (const visual of this.bodies.values()) visual.sync(alpha);

    this.chains.sync(level, alpha, retract);
    this.vines.sync(level.vines ?? NO_VINES, alpha);
    this.ballVisual?.sync(alpha);
    // After the visuals are synced and before the frame is drawn: a highlight is
    // a material swap on meshes the reconciliation above may have only just
    // created, and it costs a traverse only while something is selected.
    this.syncHighlight();

    this.gpuTimer?.begin();
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer?.end();
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
    this.clearHighlight();
    for (const visual of this.bodies.values()) {
      this.scene.remove(visual.root);
      visual.dispose();
    }
    this.bodies.clear();
    for (const visual of this.standing) {
      this.scene.remove(visual.root);
      visual.dispose();
    }
    this.standing.length = 0;
    if (this.ballVisual) {
      this.scene.remove(this.ballVisual.root);
      this.ballVisual.dispose();
      this.ballVisual = null;
    }
    this.chains.clear();
    this.vines.clear();
    // Every visual has handed its lights back on the way through, so this is the
    // backstop rather than the mechanism: a rig holding a light whose parent has
    // gone is a slot of the budget spent on nothing.
    this.lights.dispose();
  }

  dispose(): void {
    this.clearLevel();
    this.chains.dispose();
    this.vines.dispose();
    this.lights.dispose();
    this.env.dispose();
    this.renderer.dispose();
  }
}

// Hook-only scenery is drawn behind the solid geometry it sits among in the 2D
// renderer, and the 3D one says the same thing with depth instead of order (see
// `BodyVisual`). Exported so the 2D overlay and this agree about which bodies
// they are each responsible for.
export function isPassThroughScenery(body: CollisionObject2D): boolean {
  return body.passable;
}
