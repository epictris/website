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
// There is deliberately NO FOG. It was here to say which layer is further away -
// aerial perspective over the ten metres of depth a level authors into - and
// what it also did was mute every distant surface at exactly the moment the
// authored textures and the environment started giving those surfaces something
// worth seeing. Depth is said by parallax, by the shadow the sun throws and by
// the environment's own gradient instead. `THREE.FogExp2` is two lines if a
// level ever wants it back, and it would want to be per level rather than a
// default.
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
      // Peter-panning versus acne: a normal-offset bias handles the sloped faces
      // an extruded level is mostly made of, and the constant bias is small enough
      // that a shadow still touches the thing casting it.
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

    if (renderer) {
      // With no sun there is no sun LOBE either: the lobe is what puts a
      // travelling highlight on a rough surface as it turns, and a level lit by
      // its own lamps has no business carrying a bright spot in its sky where a
      // sun it does not have would be.
      const source = equirectEnvironment(
        skyFill,
        groundFill,
        this.sunColor,
        this.dir,
        this.sun !== null,
      );
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.envTarget = pmrem.fromEquirectangular(source);
      scene.environment = this.envTarget.texture;
      scene.environmentIntensity = env?.envIntensity ?? ENV_INTENSITY;
      // The convolution is done and both the source canvas and the generator's
      // own scratch targets are finished with; only the cube target survives.
      source.dispose();
      pmrem.dispose();
    }

    scene.background = new THREE.Color(env?.backgroundColor ?? DEFAULT_SKY);
    scene.fog = null;
  }

  // Keep the shadow frustum around what the camera is looking at. A single
  // cascade only covers SHADOW_DISTANCE of world, so it has to travel; sliding
  // it with the camera rather than fitting it to the scene is what keeps the
  // texel density constant as the view zooms, which is what stops shadow edges
  // shimmering during a camera blend.
  follow(camera: Camera): void {
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
