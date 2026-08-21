// The light and the air. What separates a scene that reads as lit space from one
// that reads as flat-shaded geometry is almost entirely here rather than in the
// meshes: one warm directional sun with a shadow map, a cool hemisphere fill so
// nothing is ever pure black, an environment for surfaces to REFLECT, and filmic
// tone mapping so the sun has range to work in.
//
// ALL OF THAT IS THE OUTDOOR ANSWER, and a level may decline it. The sun is a
// light at infinity, so it reaches every surface in the frame equally - which is
// what a sky does, and is exactly wrong underground, where it lights a corridor
// and the rock around it identically and neither has an inside. `sunIntensity: 0`
// removes it outright (no light, no shadow map, no lobe in the generated sky) and
// `envIntensity` near zero takes the ambient with it; what is left is whatever
// `LevelData.lights` puts in the level, which falls off with distance and
// therefore has somewhere it ENDS. See `render3d/lights.ts`.
//
// FOG IS OFF BY DEFAULT AND AUTHORED PER LEVEL (`fogAmount`), which is the
// arrangement the removed version should have had. As a default it muted every
// distant surface at exactly the moment the authored textures and the
// environment started giving those surfaces something worth seeing, and depth
// was already said by parallax, by the shadow the sun throws, by the
// environment's own gradient and - in a level lit from inside - by the lights'
// own falloff. None of that is an argument against a level ASKING for air.
//
// IT THICKENS WITH DISTANCE FROM THE CAMERA, which is what air does: every
// surface in the frame is behind some of it, and one further back is behind more.
// `THREE.FogExp2` is that law directly - the density is a property of the air
// rather than of where the level happens to be, so nothing has to be re-anchored
// per frame and the picture cannot disagree with itself about which of two
// surfaces is further away.
//
// It was briefly a LINEAR fog pinned to the gameplay plane, on the argument that
// the plane sits ~16 m from the camera (zoom is dolly distance here - see
// `space.ts`) so a camera-relative fog thick enough to see also tints the plane
// itself. That is true and it is not a defect: the plane IS 16 m of air away,
// the level's own foreground props stand 3 m in front of it and its scenery 2 m
// behind, and a fog that starts exactly at the plane draws those three at the
// same haze as each other and the foreground at none. Pinning it also made the
// fog a function of the zoom, so a camera region that pulled back moved the fog
// with it - the air thinning as you zoom out, which is the wrong way round.
//
// What that costs, stated once: zooming out now puts more air between the camera
// and the level, so a pulled-back camera region is hazier. That is the same
// statement as the one above and it is the correct direction.
//
// The environment is what makes the PBR maps mean anything. A
// `MeshStandardMaterial` gets its specular response from reflections, so with
// lights alone there is nothing for a surface to reflect but one directional
// sun: a roughness map has almost no visible effect, and a metal - which is
// ALMOST ENTIRELY reflection - renders as a dark, dead shape. It is generated
// rather than loaded, from the level's own sky, ground and sun colours, so it
// costs no asset, matches whatever a level authored, and cannot disagree with
// the fill about what colour the air is.
//
// Every number is a default a level may override (`LevelData.environment`), and
// every default is chosen to sit against the palette the 2D renderer already
// uses: the page background `#1f2430` is the sky, so the 3D scene's horizon and
// the letterbox bars around the frame are the same colour and the frame does not
// read as a window cut into a different game.

import * as THREE from "three";
import type { EnvironmentData } from "../level/levelFormat";
import { loadedHdri, loadHdri } from "./assets";
import { threeY } from "./space";
import type { Camera } from "../render/camera";

// The page's own background (see index.html and LETTERBOX_COLOR): the frame's
// surround, so the scene fades into it rather than ending at it.
export const DEFAULT_SKY = "#1f2430";

// Warm key light, cool fill: the oldest trick in the book and the reason a grey
// rock reads as stone rather than as grey.
export const DEFAULT_SUN_COLOR = "#ffe8c8";
export const DEFAULT_SKY_FILL = "#9fb6d8";
export const DEFAULT_GROUND_FILL = "#3a3226";
export const DEFAULT_SUN_INTENSITY = 3.1;
export const DEFAULT_FILL_INTENSITY = 1.3;

// The sun travels down-and-right-and-back in sim terms: from the upper left and
// slightly in front of the plane, so a body's front face is lit, its left edge
// catches the highlight and its shadow falls to the lower right. That is the
// reference games' light, and it is the one arrangement under which an extruded
// collision outline reads as a solid rather than as a sticker.
export const DEFAULT_SUN_DIR = { x: 0.55, y: 0.8, z: -0.5 };

// How far behind the camera the sun is placed and how wide its orthographic
// shadow frustum is. One cascade following the camera is enough at this scene
// scale (a frame is ~10 m of world), and a second would cost more than it buys.
const SHADOW_DISTANCE = 30;
const SHADOW_MAP_SIZE = 2048;

// The generated environment, and how much of it is let in.
//
// `ENV_INTENSITY` is deliberately below 1 and the hemisphere fill comes DOWN to
// meet it: image-based lighting contributes diffuse as well as specular, so an
// environment dropped in at full strength on top of the existing fill lights the
// scene twice and flattens exactly the contrast the fill was tuned for. What is
// wanted from it here is mostly the specular - a surface that has something to
// reflect - so it is mixed in at a level where the scene's overall brightness is
// where it was and the highlights are new.
export const ENV_INTENSITY = 0.6;
const FILL_WITH_ENV = 0.7; // multiplies the hemisphere fill, which now shares the job
// Equirectangular, and small: PMREM blurs it into roughness levels immediately,
// so the source only has to carry a gradient and a sun lobe. 128x64 is under
// 32 KB of canvas and indistinguishable from 512 once convolved.
const ENV_MAP_WIDTH = 128;
const ENV_MAP_HEIGHT = 64;
// How wide the sun's lobe is in the environment, as a fraction of the sphere,
// and how much brighter than the sky it is. A tight, bright lobe is what puts a
// travelling highlight on a rough surface as it turns; a wide one just raises
// the ambient.
const SUN_LOBE_SIZE = 0.09;
const SUN_LOBE_GAIN = 6;

// The distance `fogAmount` is measured at, in metres. 20 m is about where the
// gameplay plane sits at the ball level's own zoom, so the authored number reads
// as "how much haze the level itself has" while everything nearer and further
// scales off it continuously.
export const FOG_REFERENCE_DISTANCE = 20;

// The `FogExp2` density that puts `amount` of fog on a surface
// `FOG_REFERENCE_DISTANCE` away. Exponential fog leaves `exp(-(density*z)^2)` of
// the surface showing, so the fraction the air takes is `1 - that`, and this is
// what inverts it. Exported because it is the whole of what the authored number
// means, and `cli render3d` checks it without a GPU.
//
// Clamped just below 1 because a surface fully replaced by fog at a finite
// distance needs infinite density, and an author dragging the field to its top
// should get "very thick" rather than a scene of flat colour and a NaN.
export function fogDensity(amount: number): number {
  const f = Math.min(0.99, Math.max(0, amount));
  if (f <= 0) return 0;
  return Math.sqrt(-Math.log(1 - f)) / FOG_REFERENCE_DISTANCE;
}

export class Environment {
  // NULL when the level authors `sunIntensity: 0`, which is how a level says it
  // is underground. It is an absent light rather than a light at zero strength
  // on purpose: a `DirectionalLight` with `castShadow` still renders its shadow
  // map every frame however dark it is, so a cave lit entirely by its own lamps
  // would go on paying for a 2048² map of a sun that contributes nothing.
  readonly sun: THREE.DirectionalLight | null;
  readonly fill: THREE.HemisphereLight;
  private readonly dir = new THREE.Vector3();
  private readonly target = new THREE.Object3D();
  private readonly sunColor: THREE.Color;

  private envTarget: THREE.WebGLRenderTarget | null = null;
  // A captured sky can arrive after the scene is already being drawn, and the
  // scene outlives this object (a level change builds a new `Environment` into
  // the same one), so a load that lands after `dispose` must be dropped rather
  // than written over whatever replaced it.
  private disposed = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private envIntensity = ENV_INTENSITY;
  private rotation = 0;
  private hdriAsBackground = false;

  constructor(
    private readonly scene: THREE.Scene,
    env?: EnvironmentData,
    // Optional so a host that has no renderer to hand (a test, a scene built
    // before the canvas exists) still gets the lights; it simply gets no
    // reflections, which is what this looked like before there were any.
    renderer?: THREE.WebGLRenderer,
  ) {
    const sunDir = {
      x: env?.sunX ?? DEFAULT_SUN_DIR.x,
      y: env?.sunY ?? DEFAULT_SUN_DIR.y,
      z: env?.sunZ ?? DEFAULT_SUN_DIR.z,
    };
    // Two conversions, in this order: into three's frame (the y-negation every
    // placement in render3d/ goes through), then negated, because the authored
    // vector is the direction the light TRAVELS and what a DirectionalLight
    // needs is the direction its lamp sits in.
    this.dir.set(sunDir.x, threeY(sunDir.y), sunDir.z).normalize().negate();

    const sunIntensity = env?.sunIntensity ?? DEFAULT_SUN_INTENSITY;
    this.sunColor = new THREE.Color(env?.sunColor ?? DEFAULT_SUN_COLOR);
    if (sunIntensity > 0) {
      this.sun = new THREE.DirectionalLight(this.sunColor, sunIntensity);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      const cam = this.sun.shadow.camera;
      cam.near = 0.5;
      cam.far = SHADOW_DISTANCE * 2.5;
      cam.left = -SHADOW_DISTANCE / 2;
      cam.right = SHADOW_DISTANCE / 2;
      cam.top = SHADOW_DISTANCE / 2;
      cam.bottom = -SHADOW_DISTANCE / 2;
      // AND SAY SO. `DirectionalLightShadow` never calls this for you - three
      // only re-derives a shadow camera's projection where it derives the
      // camera's own parameters, which for a spot is the cone and for the sun is
      // nothing at all. Every line above is therefore inert without it, and
      // inert in the quietest possible way: the shadow still renders, through
      // the class default's 10 m box at a far plane of 500, so a level wider
      // than that box simply has shadows over part of itself and none over the
      // rest, which reads as the geometry rather than as the frustum.
      cam.updateProjectionMatrix();
      // Peter-panning versus acne: a normal-offset bias handles the sloped faces
      // an extruded level is mostly made of, and the constant bias is small enough
      // that a shadow still touches the thing casting it. It is safe HERE, where
      // a spot's is not, because an orthographic depth buffer is linear - see
      // the note in `lights.ts`.
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.03;
      scene.add(this.sun);
      scene.add(this.target);
      this.sun.target = this.target;
    } else {
      this.sun = null;
    }

    const skyFill = new THREE.Color(env?.skyColor ?? DEFAULT_SKY_FILL);
    const groundFill = new THREE.Color(env?.groundColor ?? DEFAULT_GROUND_FILL);
    this.fill = new THREE.HemisphereLight(
      skyFill,
      groundFill,
      (env?.fillIntensity ?? DEFAULT_FILL_INTENSITY) * (renderer ? FILL_WITH_ENV : 1),
    );
    scene.add(this.fill);

    const background = env?.backgroundColor ?? DEFAULT_SKY;
    scene.background = new THREE.Color(background);
    // Stated rather than left: the scene outlives this object, so a level that
    // authors no sky rotation must not inherit the last one's.
    scene.environmentRotation.set(0, 0, 0);
    scene.backgroundRotation.set(0, 0, 0);

    if (renderer) {
      this.renderer = renderer;
      this.envIntensity = env?.envIntensity ?? ENV_INTENSITY;
      this.rotation = THREE.MathUtils.degToRad(env?.hdriRotation ?? 0);
      this.hdriAsBackground = env?.hdriBackground === true;
      // A CAPTURED sky, if the level named one and this build has it. It is
      // taken synchronously where it is already decoded, because a scene rebuilt
      // mid-drag that starts on the generated sky and swaps a frame later is the
      // level's whole lighting flickering once per rebuild.
      const named = env?.hdri;
      const ready = named ? loadedHdri(named) : null;
      if (ready) {
        this.useEnvMap(ready, false);
      } else {
        // The generated sky: what every level had before there were captures,
        // and what one whose capture has not arrived yet (or does not exist in
        // this build) is lit by. Same rule as an authored texture, which is
        // drawn in its generated fallback until its images land.
        //
        // With no sun there is no sun LOBE either: the lobe is what puts a
        // travelling highlight on a rough surface as it turns, and a level lit
        // by its own lamps has no business carrying a bright spot in its sky
        // where a sun it does not have would be.
        this.useEnvMap(
          equirectEnvironment(skyFill, groundFill, this.sunColor, this.dir, this.sun !== null),
          true,
        );
        if (named) {
          void loadHdri(named).then((tex) => {
            if (tex && !this.disposed) this.useEnvMap(tex, false);
          });
        }
      }
    }

    // Absent, zero (and a negative, which means nothing) are all "no fog", so a
    // level that authors none has no `scene.fog` at all rather than a fog of zero
    // density - three.js runs the fog chunks either way.
    const amount = env?.fogAmount ?? 0;
    scene.fog =
      amount > 0
        ? new THREE.FogExp2(new THREE.Color(env?.fogColor ?? background), fogDensity(amount))
        : null;
  }

  // Convolve one equirectangular sky into the mip chain a rough surface samples,
  // and hang it on the scene. `PMREMGenerator` is what turns an image into
  // lighting: without it a `MeshStandardMaterial` has only the mirror level to
  // sample, so a rough surface reflects a sharp picture of the sky and a diffuse
  // one reflects nothing at all.
  //
  // `ownSource` says whether this object made the source. The generated sky is
  // built here and finished with the moment it is convolved; a captured one is
  // shared - one decode serves every scene that names it - so disposing it would
  // take the sky out from under the next level to ask for it.
  private useEnvMap(source: THREE.Texture, ownSource: boolean): void {
    if (!this.renderer) return;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const target = pmrem.fromEquirectangular(source);
    // The generator's own scratch targets are finished with; only the cube
    // target survives, and the one this replaces (the fallback, where a capture
    // has just arrived) goes with it.
    pmrem.dispose();
    if (ownSource) source.dispose();
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = this.envIntensity;
    this.scene.environmentRotation.set(0, this.rotation, 0);
    // Only a CAPTURE is ever drawn behind the level: the generated sky is a
    // 128x64 gradient built to be convolved, and stretched across the frame it
    // is a wash of colour with a band in it rather than a picture of anything.
    if (this.hdriAsBackground && !ownSource) {
      this.scene.background = source;
      this.scene.backgroundRotation.set(0, this.rotation, 0);
    }
  }

  // Keep the shadow frustum around what the camera is looking at. A single
  // cascade only covers SHADOW_DISTANCE of world, so it has to travel; sliding
  // it with the camera rather than fitting it to the scene is what keeps the
  // texel density constant as the view zooms, which is what stops shadow edges
  // shimmering during a camera blend.
  follow(camera: Camera): void {
    // The fog needs nothing here: its density is a property of the air, and the
    // distance it is applied over is the one three.js already has per fragment.
    if (!this.sun) return;
    const cx = camera.position.x;
    const cy = threeY(camera.position.y);
    this.target.position.set(cx, cy, 0);
    this.target.updateMatrixWorld();
    this.sun.position.set(
      cx + this.dir.x * SHADOW_DISTANCE,
      cy + this.dir.y * SHADOW_DISTANCE,
      this.dir.z * SHADOW_DISTANCE,
    );
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.disposed = true;
    // The scene outlives this object (a level change rebuilds the environment
    // into the same scene), so the fog has to go with the environment that
    // authored it or the next level inherits this one's air.
    this.scene.fog = null;
    this.scene.remove(this.fill, this.target);
    if (this.sun) {
      this.scene.remove(this.sun);
      this.sun.dispose();
    }
    this.fill.dispose();
    if (this.envTarget) {
      this.scene.environment = null;
      this.envTarget.dispose();
      this.envTarget = null;
    }
  }
}

// The sky as one small equirectangular image: a vertical gradient from the
// ground colour through the horizon to the sky colour, with a warm lobe where
// the sun is. PMREM turns it into the mip chain a rough surface samples, so
// nothing here has to be sharp - what it has to be is DIRECTIONAL, since a
// uniform environment is indistinguishable from ambient light and puts no
// highlight anywhere.
function equirectEnvironment(
  sky: THREE.Color,
  ground: THREE.Color,
  sunColor: THREE.Color,
  sunDir: THREE.Vector3,
  withSun: boolean,
): THREE.DataTexture {
  const data = new Float32Array(ENV_MAP_WIDTH * ENV_MAP_HEIGHT * 4);
  const dir = new THREE.Vector3();
  for (let y = 0; y < ENV_MAP_HEIGHT; y++) {
    // Equirectangular: v maps to polar angle, u to azimuth.
    const theta = (y + 0.5) * (Math.PI / ENV_MAP_HEIGHT);
    const up = Math.cos(theta); // +1 straight up, -1 straight down
    for (let x = 0; x < ENV_MAP_WIDTH; x++) {
      const phi = (x + 0.5) * ((Math.PI * 2) / ENV_MAP_WIDTH) - Math.PI;
      dir.set(Math.sin(theta) * Math.sin(phi), up, Math.sin(theta) * Math.cos(phi));
      // Sky above, ground below, mixed smoothly across the horizon rather than
      // meeting at a line - a hard horizon shows up as a seam in the reflection
      // of anything polished.
      const t = up * 0.5 + 0.5;
      const r = ground.r + (sky.r - ground.r) * t;
      const g = ground.g + (sky.g - ground.g) * t;
      const b = ground.b + (sky.b - ground.b) * t;
      // The sun lobe, falling off with the angle to it.
      const cos = dir.dot(sunDir);
      const lobe =
        withSun && cos > 1 - SUN_LOBE_SIZE
          ? ((cos - (1 - SUN_LOBE_SIZE)) / SUN_LOBE_SIZE) ** 2
          : 0;
      const i = (y * ENV_MAP_WIDTH + x) * 4;
      data[i] = r + sunColor.r * lobe * SUN_LOBE_GAIN;
      data[i + 1] = g + sunColor.g * lobe * SUN_LOBE_GAIN;
      data[i + 2] = b + sunColor.b * lobe * SUN_LOBE_GAIN;
      data[i + 3] = 1;
    }
  }
  // Float rather than 8-bit: the sun lobe is several times brighter than the
  // sky, which is exactly the range an LDR texture cannot hold - clipped, the
  // highlight it puts on a metal is the same white as the sky around it.
  const tex = new THREE.DataTexture(
    data,
    ENV_MAP_WIDTH,
    ENV_MAP_HEIGHT,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Renderer-side half of the look: filmic tone mapping and correct colour space,
// so the lighting above has range instead of clipping to white at the first
// highlight. Applied once, when the renderer is created.
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
