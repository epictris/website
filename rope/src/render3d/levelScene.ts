// One level's drawn objects - its bodies' visuals, its Blender scene, its
// lights, its vines and its ball - under one group of their own, so that a
// level can be taken down and put back up without being rebuilt (see
// `Scene3D.show`).
//
// WHY A LEVEL IS AN OBJECT OF ITS OWN. Rebuilding a level's scene disposes its
// materials, and three releases a compiled program the moment the last
// material using it is disposed: rebuilding the SAME level therefore linked
// the same programs again. The editor did it twice a ▶ Test - its own scene
// thrown away for the test's, then the test's for a fresh one of its own - and
// on `ball` that was nine programs, ~800 ms of link at the start of a test and
// again on the way back (2026-10-17, measured headless on the RTX 4070). Held
// as one of these, the editor's scene is parked while a test plays and put
// back when it stops, and a level that does go is disposed only after the one
// replacing it has taken its programs over (`Scene3D.retire`).
//
// Everything here belongs to this level alone. What the page keeps across
// levels - the environment, the chains, the shards, the passes - is the
// scene's (`Scene3D`).

import * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import type { BallVisual } from "./ballVisual";
import type { BodyVisual } from "./bodyVisuals";
import { LightRig } from "./lights";
import type { Scene3DLevel } from "./scene";
import type { SceneDressing } from "./sceneDressing";
import type { SceneLens } from "./space";
import { VineLayer } from "./vineVisual";

export class LevelScene {
  // What is added to the scene while this level is the one drawn.
  readonly root = new THREE.Group();
  // Every light in the level. A light is an object inside a body, a child of
  // the group its body is drawn in, so its lifetime is that body's - and so
  // this level's.
  readonly lights = new LightRig();
  readonly vines: VineLayer;
  // Bodies that are IN THE WORLD, keyed by their engine object. Reconciled every
  // frame, because bodies come and go at runtime (the hook is destroyed and
  // rebuilt on every throw, the sandbox spawns rocks).
  readonly bodies = new Map<CollisionObject2D, BodyVisual>();
  // Authored bodies that built no engine object - decoration, a light with no
  // fitting. They are not in the world, so they can neither be found by the
  // reconciliation nor go stale: they live exactly as long as the level does.
  readonly standing: BodyVisual[] = [];
  // Every AUTHORED body's visual, built or standing, in the level's body order
  // - the order an edited copy of the level lists them in (`restyleDebug`).
  readonly authored: BodyVisual[] = [];
  // The level's Blender scene, when it names one (see `SceneDressing`), and
  // whether it has landed (or there is none).
  dressing: SceneDressing | null = null;
  sceneryLanded = false;
  // The pool's water worn by the scene's own flat water
  // (`Scene3D.adoptSceneryWater`), freed with the level.
  readonly sceneryWaterMaterials: THREE.Material[] = [];
  ballVisual: BallVisual | null = null;
  // The glass ball's glow on the world (see `Scene3D.setLevel`).
  ballGlow: THREE.PointLight | null = null;

  constructor(
    // What this was built for: `Scene3D.render` draws a level only through the
    // scene built for it.
    readonly level: Scene3DLevel,
    // The lens and z offset the level asked for (`LevelCameraData`).
    readonly lens: SceneLens,
  ) {
    this.root.name = "level";
    this.vines = new VineLayer(this.root);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const visual of this.bodies.values()) visual.dispose();
    this.bodies.clear();
    for (const visual of this.standing) visual.dispose();
    this.standing.length = 0;
    this.authored.length = 0;
    this.dressing?.dispose();
    this.dressing = null;
    for (const m of this.sceneryWaterMaterials) m.dispose();
    this.sceneryWaterMaterials.length = 0;
    this.ballVisual?.dispose();
    this.ballVisual = null;
    this.ballGlow?.dispose();
    this.ballGlow = null;
    this.vines.dispose();
    // Every visual has handed its lights back on the way through, so this is
    // the backstop rather than the mechanism.
    this.lights.dispose();
    this.root.clear();
  }
}
