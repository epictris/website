// The light and the air. What separates a scene that reads as lit space from one
// that reads as flat-shaded geometry is almost entirely here rather than in the
// meshes: one warm directional sun with a shadow map, a cool hemisphere fill so
// nothing is ever pure black, exponential fog so distance means something, and
// filmic tone mapping so the sun has range to work in.
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
const DEFAULT_SUN_COLOR = "#ffe8c8";
const DEFAULT_SKY_FILL = "#9fb6d8";
const DEFAULT_GROUND_FILL = "#3a3226";
const DEFAULT_SUN_INTENSITY = 3.1;
const DEFAULT_FILL_INTENSITY = 1.3;
const DEFAULT_HAZE = 0.35;

// Haze 1 halves a surface's contrast against the sky at ~4 m of depth and buries
// it by ~10 m. Sized against the depth range levels actually author into - the
// gameplay plane at 0, props a metre or two either side, background layers out
// to -20 m - rather than against a real atmosphere, where a scene this small
// would show no aerial perspective at all. The point of the haze is to say which
// layer is further away, and it has ten metres in which to say it.
const FOG_DENSITY_AT_FULL_HAZE = 0.25;

// The sun travels down-and-right-and-back in sim terms: from the upper left and
// slightly in front of the plane, so a body's front face is lit, its left edge
// catches the highlight and its shadow falls to the lower right. That is the
// reference games' light, and it is the one arrangement under which an extruded
// collision outline reads as a solid rather than as a sticker.
const DEFAULT_SUN_DIR = { x: 0.55, y: 0.8, z: -0.5 };

// How far behind the camera the sun is placed and how wide its orthographic
// shadow frustum is. One cascade following the camera is enough at this scene
// scale (a frame is ~10 m of world), and a second would cost more than it buys.
const SHADOW_DISTANCE = 30;
const SHADOW_MAP_SIZE = 2048;

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly fill: THREE.HemisphereLight;
  private readonly dir = new THREE.Vector3();
  private readonly target = new THREE.Object3D();

  constructor(
    private readonly scene: THREE.Scene,
    env?: EnvironmentData,
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

    this.sun = new THREE.DirectionalLight(
      new THREE.Color(env?.sunColor ?? DEFAULT_SUN_COLOR),
      env?.sunIntensity ?? DEFAULT_SUN_INTENSITY,
    );
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

    this.fill = new THREE.HemisphereLight(
      new THREE.Color(env?.skyColor ?? DEFAULT_SKY_FILL),
      new THREE.Color(env?.groundColor ?? DEFAULT_GROUND_FILL),
      env?.fillIntensity ?? DEFAULT_FILL_INTENSITY,
    );
    scene.add(this.fill);

    const background = new THREE.Color(env?.backgroundColor ?? DEFAULT_SKY);
    scene.background = background;
    const haze = env?.haze ?? DEFAULT_HAZE;
    scene.fog =
      haze > 0
        ? new THREE.FogExp2(
            new THREE.Color(env?.fogColor ?? env?.backgroundColor ?? DEFAULT_SKY),
            haze * FOG_DENSITY_AT_FULL_HAZE,
          )
        : null;
  }

  // Keep the shadow frustum around what the camera is looking at. A single
  // cascade only covers SHADOW_DISTANCE of world, so it has to travel; sliding
  // it with the camera rather than fitting it to the scene is what keeps the
  // texel density constant as the view zooms, which is what stops shadow edges
  // shimmering during a camera blend.
  follow(camera: Camera): void {
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
    this.scene.remove(this.sun, this.fill, this.target);
    this.sun.dispose();
    this.fill.dispose();
  }
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
