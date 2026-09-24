// The lights a level puts IN itself, as opposed to the one at infinity that
// `environment.ts` calls the sun.
//
// The two are different statements about where the level is. A directional light
// reaches every surface in the frame equally, which is exactly right outdoors and
// exactly wrong underground: it says the whole scene is under one sky, so a
// corridor and the rock around it are lit the same and neither has an inside.
// What an interior looks like is a small number of sources with a POSITION and a
// REACH, falling off as the inverse square, and the geometry beyond that reach
// going black. That falloff is doing three jobs at once and each of them is a
// thing a flat renderer needed a hand-authored gradient for:
//
// - It says where the play space is. A lamp near the gameplay plane lights the
//   plane; parallax decoration 20 m behind it is far outside the same lamp, so
//   the background darkens on its own and stays readable as background.
// - It frames. Geometry in FRONT of the plane is out of reach too, so a pillar
//   or a wall drawn over the level reads as a black silhouette rather than as a
//   lit object in the way.
// - It is depth. Two walls at different depths are lit differently by the same
//   lamp, which is the cue the narrow FOV takes out of the picture.
//
// EVERY LIGHT IS A CHILD OF ITS BODY, and that is the whole of what this rig
// arranges. A light is a scene object like any other, so it is parented to the
// group its body is drawn in and rides that body's pose for nothing: a lantern
// welded into a swinging crate swings with its light, and there is no
// per-frame transform here at all.
//
// It replaces two mechanisms that used to sit either side of the same gap. The
// level had a top-level light list, whose lights had no parent and therefore
// could not ride anything; and a lamp the player could SEE had to be that plus
// an emissive shape at the same point, which nothing kept in step, so moving the
// sconce left the light behind. The patch for that was to DERIVE a light from a
// glowing shape, out of seven fields on the visual that described a light in a
// second vocabulary - its reach, its cone, its aim, its shadow, its flicker -
// and to re-place it on the model's own bounding box once a GLB arrived. All of
// it is gone. A light in the same body as the fitting cannot drift from it,
// because it is inside it.
//
// SHADOWS ARE THE EXPENSIVE PART, and the asymmetry with the sun is worth
// stating: a directional light's shadow is ONE render of the scene into an
// orthographic map, and so is a spot's, while a point light's is a CUBE - six.
// A corridor of eight point torches asking for shadows is forty-eight shadow
// passes a frame, which is not a cost that announces itself as anything but the
// frame rate quietly halving. So `castShadow` is opt-in per light and capped at
// LIGHT_SHADOW_BUDGET; past the cap a light still lights, it just does not
// occlude. That is a much smaller lie than it sounds - most of what a torch
// contributes to a wall behind a crate is bounce, which none of this models
// anyway.
//
// FLICKER is render-only and driven by a clock this rig is handed, never by the
// frame counter. The sim is a fixed 60 Hz and deterministic; a light that read
// sim state would be a rendering detail with a path into a replay. It is handed
// the time rather than reading it so a headless grab can pin it (see
// `Scene3D.pinClock`) - a screenshot whose lighting depends on when it was taken
// is evidence of nothing.
//
// WAKING LIGHTS (a point light with a `wake` distance, see `glow.ts`) mount no
// THREE light of their own. They are served by a fixed POOL of point lights,
// built once at `setLevel` (`buildPool`) and never removed while the level is
// loaded, handed each frame to the awake sources nearest the ball. Three
// compiles every lit program against the NUMBER of lights in the scene, so a
// light that came and went with the player would be a fresh program on a
// played frame - the stutter `Scene3D.prewarm` exists to prevent.
//
// FIREFLY SWARMS (a point light with `fireflies`, see `fireflies.ts`) are the
// same idea taken off the body: the light object is only the swarm's HOME, the
// motes fly in world space once they notice the ball, and a second fixed pool
// (`FIREFLY_POOL`) hangs a light at the centre of each of the swarms nearest
// the ball. The motes of every swarm are one draw (`FireflyVisual`).

import * as THREE from "three";
import type { LightObjectData } from "../level/levelFormat";
import { Beam, buildBeam } from "./beam";
import {
  FIREFLY_COLOR,
  FIREFLY_INTENSITY,
  FIREFLY_RANGE,
  fireflyPoolSizeFor,
  Swarm,
  swarmParams,
  type SwarmParams,
  type SwarmPlace,
  OPEN_PLACE,
} from "./fireflies";
import { FireflyVisual } from "./fireflyVisual";
import { assignPool, GlowState, poolSizeFor, wakeParams, type PoolCandidate } from "./glow";
import { threeY } from "./space";
import { Vec2 } from "../engine/vec2";
import { LAYER_SCENERY } from "../engine/body";
import { circleOverlap } from "../engine/collision";
import type { World } from "../engine/world";
import {
  pointAtArcLength,
  projectOntoPolyline,
  projectOntoPolylineWindow,
  tangentAtArcLength,
  type PolylineIndex,
} from "../lib/path";

// Metres either side of a swarm's own progress along a route that its next
// projection of the ball is confined to, so on a switchback it stays on the
// branch the ball is on (`projectOntoPolylineWindow`, as the camera does).
const ROUTE_WINDOW = 4;

// A warm flame. Deliberately well off white: a lamp reading as a lamp is mostly
// about the contrast between its own colour and the cool fill around it, which
// is the same warm-key/cool-fill trick the sun and the hemisphere already play.
export const DEFAULT_LIGHT_COLOR = "#ffb066";

// Candela, against the sim's metres (see `LightObjectData`). Sized so that a
// lamp at the default range puts a surface a metre away at roughly the
// brightness the sun used to, which is what makes swapping one for the other a
// change of mood rather than a change of exposure.
export const DEFAULT_LIGHT_INTENSITY = 14;

// Metres. This, not `intensity`, is the field that authors the look: falloff is
// inverse-square, so past a couple of metres a brighter lamp is barely a wider
// pool, and where the light ENDS is what says where the room does.
export const DEFAULT_LIGHT_RANGE = 6;

// Metres in front of the gameplay plane. A body's extrusion is centred on the
// plane (see extrude.ts), so a light at z 0 sits INSIDE the wall it is mounted
// on and lights the level from within its own geometry - which reads as the
// wall glowing rather than as a lamp on it. A third of a metre is clear of a
// default 0.2 m slab and still close enough that the pool it throws is on the
// plane rather than on the camera.
export const DEFAULT_LIGHT_Z = 0.35;

// Spot cone half-angle in degrees, and how soft its edge is.
export const DEFAULT_SPOT_ANGLE = 30;
export const DEFAULT_SPOT_PENUMBRA = 0.4;

// How many lights a level may have burning at once, spent in authored order -
// by body, then by object within the body. Each is a light every lit material in
// the scene shades against, which is a real per-fragment cost rather than a
// memory bound, and past the cap a light simply does not light.
//
// It exists because a light stopped being a scarce top-level thing and became an
// object anybody can drop into a body: a corridor authored as thirty identical
// sconces is now an easy thing to write and an expensive thing to draw. Spent in
// authored order rather than by picking the "important" ones, because there is
// no measure of important here that is not the author's own ordering - and a
// rule the author can see (the first N that ask, get) is one they can author
// around.
export const LIGHT_BUDGET = 16;

// ...and how many of those may occlude. See the header: a point light's shadow
// is six renders of the scene and a spot's is one, which is why a level wanting
// several shadow-casting lamps wants them to be spots.
export const LIGHT_SHADOW_BUDGET = 4;

// Read as a TEXEL SIZE rather than as a count, because a texel is the STEP a
// shadow moves in. A caster's silhouette is rasterised into this grid, so its
// edge cannot land between two texels: a slowly swinging prop does not slide its
// shadow, it holds it still and then jumps it a whole texel, which is what reads
// as the shadows updating at some lower frame rate than everything else.
//
// A spot's map covers a disc `2·range·tan(angle)` across at the end of its
// reach, so this level's 12 m lamps at 30° spend it over 13.9 m: 27 mm a texel
// at 512 and 14 mm at 1024. That the number is a grid and not a resolution is
// directly visible - the same frame drawn at 512 and at 4096 differs by 37,576
// pixels, all of them shadow edges standing in different places for geometry
// that has not moved.
//
// 1024 rather than more because it is one render per spot (a point light's is
// six) against the sun's single 2048, and because halving the step twice more
// costs sixteen times the memory for a step that is already under the width of
// the things casting it. What it cannot do is remove the step; only a filtered
// shadow map (VSM) would, at the price of light bleeding through thin geometry,
// which this level is made of.
const LIGHT_SHADOW_MAP_SIZE = 1024;

// Nearest the light a shadow is computed from. Too small and the depth range is
// wasted on space nothing occupies (which is what makes shadow acne); a lamp is
// mounted clear of its own fitting by about this much anyway.
//
// A lamp whose fitting SURROUNDS its light - a lantern with the source inside
// it - authors `shadowNear` past the fitting's radius instead: the fitting then
// never enters this light's shadow map (a shadow camera renders nothing nearer
// than its near plane), so it neither acnes nor dims the room with its own
// silhouette, while still casting shadows from the sun and every other light.
export const LIGHT_SHADOW_NEAR = 0.1;

// Flicker shape. Two incommensurate rates summed: one alone is a sine wave and
// reads as a pulse rather than as a flame, and their ratio being irrational is
// what stops the pair repeating on any period a player would notice.
const FLICKER_RATE_A = 11.3;
const FLICKER_RATE_B = 4.7;

// One authored light, built. Kept alongside its own authored intensity because
// flicker needs it every frame: modulating the light's CURRENT intensity
// compounds, so a guttering torch would wander away from what was authored and
// never come back.
interface BuiltLight {
  light: THREE.PointLight | THREE.SpotLight;
  // The frame the light and its target live in: a child of the body's group at
  // the object's own placement. Owning it here is what lets `drop` take the
  // whole lamp out in one move, and what makes an authored `rot` turn the beam.
  holder: THREE.Object3D;
  baseIntensity: number;
  flicker: number;
  // Phase offset, so a row of identical torches does not gutter in unison. It is
  // derived from the order lights were added rather than from a random number:
  // two builds of the same level must light it the same way, and a headless grab
  // must be reproducible.
  phase: number;
  // A spot's visible beam and dust (see `beam.ts`), or null for every light
  // that asked for neither.
  beam: Beam | null;
}

// A material whose emission follows a waking light: a glowing shape in the same
// body (see `BodyVisual`), on its own instance-keyed copy of its surface so no
// other shape in the level pulses with it. `authored` is the geometry object's
// own `emissiveIntensity`, taken from the level rather than read off the
// material, which this rig has been writing.
export interface DrivenEmission {
  material: THREE.MeshStandardMaterial;
  authored: number;
}

// One waking light (a point light with `wake`), recorded instead of built. Its
// holder is still a child of the body's group, so it rides the body's pose and
// its world position is read off the holder each frame.
interface GlowSource extends PoolCandidate {
  holder: THREE.Object3D;
  color: THREE.Color;
  intensity: number;
  range: number;
  state: GlowState;
  flicker: number;
  phase: number;
  driven: readonly DrivenEmission[];
  // World position in three's frame, refreshed every `update`.
  z: number;
}

// One firefly swarm (a point light with `fireflies`), recorded instead of built.
// Its holder is its HOME, a child of the body's group like any light; the
// swarm itself is hatched on the first `update`, once the holder's world
// position can be read, and flies in world space from then on. `x`, `y`, `z`
// are its centre (`Swarm.lightAt`), where a pool light hangs for it.
interface SwarmSource extends PoolCandidate {
  holder: THREE.Object3D;
  params: SwarmParams;
  seed: number;
  swarm: Swarm | null;
  count: number;
  color: THREE.Color;
  intensity: number;
  range: number;
  flicker: number;
  phase: number;
  z: number;
}

// A built light, handed back to its owner so it can be given up as a unit. Half
// a lamp is not a thing an owner should be able to hold.
export interface MountedLight {
  readonly holder: THREE.Object3D;
}

// Where the waking lights are judged from this frame, in the sim's frame (metres,
// y down): the ball's centre, and the view's centre for the editor's awake
// preview (which has no one to wake anything).
export interface GlowFocus {
  ball: { x: number; y: number } | null;
  view: { x: number; y: number };
  // The level's world, whose solid scenery the fireflies never come to rest
  // in front of (they fly through it freely). Absent = nothing to avoid.
  world?: World;
}

// Where a light object sits in the frame its body is drawn in.
export interface LightPlacement {
  x: number;
  y: number;
  rot: number;
  // Already composed through the body's own depth by the caller, for the same
  // reason x and y are composed through its frame: a body is a frame in three
  // axes, not two and a half.
  z: number;
}

export class LightRig {
  private readonly built: BuiltLight[] = [];
  private shadowsLeft = LIGHT_SHADOW_BUDGET;
  // Whether any light actually flickers, so a level of steady lamps pays nothing
  // per frame rather than paying a loop over every light to multiply by one.
  private flickers = false;
  // Handed out in build order and never reused, so a light dropped and re-added
  // cannot land in step with a neighbour that outlived it.
  private nextPhase = 0;
  // The clock and the viewport's half height, shared by reference with every
  // beam in the rig so a frame writes them once (see `update`).
  private readonly beamTime = { value: 0 };
  private readonly beamViewHalfHeight = { value: 540 };
  // Waking lights, in the order they were added (which is authored order, the
  // pool's tie-break), and the pool of real lights that serves them.
  private readonly glows: GlowSource[] = [];
  private pool: THREE.PointLight[] = [];
  // Firefly swarms in authored order, the pool of real lights that serves them,
  // and the one draw every mote is in (see `fireflies.ts`).
  private readonly swarms: SwarmSource[] = [];
  private fireflyPool: THREE.PointLight[] = [];
  private fireflyVisual: FireflyVisual | null = null;
  // The level's authored routes as the swarms read them (see `setRoutes`).
  private place: SwarmPlace = OPEN_PLACE;
  // The world handed to the last `update`, for `solidAt`.
  private world: World | null = null;
  // The clock at the last `update`, so a glow steps by the time that passed.
  private lastSeconds: number | null = null;
  // The editor's preview: every waking light held at full without stepping its
  // state, and the pool spent nearest the view's centre. An author must be able
  // to see what a mushroom lights before there is anyone to wake it.
  previewAwake = false;
  private readonly scratch = new THREE.Vector3();

  // Hang a light on `parent` for `data`, at `place` in the parent's frame, or
  // nothing at all when the budget is spent. Returns it so its owner can hand it
  // back at dispose.
  //
  // A WAKING light (`wake` on a point light) builds no THREE light: it is
  // recorded as a source for the pool, with `emission` - the body's glowing
  // materials - as the set its level drives. It spends none of `LIGHT_BUDGET`,
  // since it is not a light in the scene; the pool is the cost, and is fixed.
  add(
    parent: THREE.Object3D,
    data: LightObjectData,
    place: LightPlacement,
    emission: readonly DrivenEmission[] = [],
  ): MountedLight | null {
    // A FIREFLY SWARM builds no THREE light either: its light is a pool light
    // hung at the swarm's centre wherever it flies (`updateFireflies`), and it
    // spends none of `LIGHT_BUDGET`. Its defaults are the firefly's, not a
    // lamp's.
    const swarm = swarmParams(data);
    if (swarm) {
      const holder = new THREE.Object3D();
      holder.position.set(place.x, threeY(place.y), place.z);
      parent.add(holder);
      const phase = this.nextPhase++ * 2.399963;
      this.swarms.push({
        holder,
        params: swarm,
        // Authored order, so the same level hatches the same swarms.
        seed: this.swarms.length + 1,
        swarm: null,
        count: swarm.count,
        color: new THREE.Color(data.color ?? FIREFLY_COLOR),
        intensity: data.intensity ?? FIREFLY_INTENSITY,
        range: data.range ?? FIREFLY_RANGE,
        flicker: clamp01(data.flicker ?? 0),
        phase,
        level: 0,
        x: 0,
        y: 0,
        z: 0,
      });
      return { holder };
    }

    const color = new THREE.Color(data.color ?? DEFAULT_LIGHT_COLOR);
    const intensity = data.intensity ?? DEFAULT_LIGHT_INTENSITY;
    const range = data.range ?? DEFAULT_LIGHT_RANGE;

    const wake = wakeParams(data);
    if (wake) {
      const holder = new THREE.Object3D();
      holder.position.set(place.x, threeY(place.y), place.z);
      holder.rotation.z = -place.rot;
      parent.add(holder);
      const flicker = clamp01(data.flicker ?? 0);
      this.glows.push({
        holder,
        color,
        intensity,
        range,
        state: new GlowState(wake),
        flicker,
        phase: this.nextPhase++ * 2.399963,
        driven: emission,
        level: 0,
        x: 0,
        y: 0,
        z: 0,
      });
      // Dark until something wakes it (or the preview holds it up).
      for (const d of emission) d.material.emissiveIntensity = 0;
      return { holder };
    }

    if (this.built.length >= LIGHT_BUDGET) return null;
    // `decay` is fixed at 2 rather than authored: 2 IS the inverse square, and
    // every other value is a light that does not obey the physics the rest of
    // this renderer's materials are written against. A level wanting a softer
    // falloff wants a bigger `range`.
    const light =
      data.kind === "spot"
        ? new THREE.SpotLight(
            color,
            intensity,
            range,
            ((data.angle ?? DEFAULT_SPOT_ANGLE) * Math.PI) / 180,
            data.penumbra ?? DEFAULT_SPOT_PENUMBRA,
            2,
          )
        : new THREE.PointLight(color, intensity, range, 2);

    // At the holder's origin, EXPLICITLY. Three seeds a `SpotLight` (and a
    // `DirectionalLight`) at `Object3D.DEFAULT_UP` rather than at zero, so a
    // light left as constructed sits a metre above the fitting it belongs to -
    // which is not a subtle error, it is every wall lamp in the level lighting
    // the ceiling above itself.
    light.position.set(0, 0, 0);

    // The holder carries the object's placement, so the light sits at its own
    // origin and a spot's target is a plain offset along the authored aim. That
    // is what makes `rot` turn the beam: rotating the frame rotates both.
    const holder = new THREE.Object3D();
    holder.position.set(place.x, threeY(place.y), place.z);
    holder.rotation.z = -place.rot;
    holder.add(light);

    // Golden-ratio stride: any fixed step lands neighbours in step with each
    // other eventually, and this one takes longest to. Taken here, before the
    // beam, which drifts on the same phase.
    const phase = this.nextPhase++ * 2.399963;
    let beam: Beam | null = null;
    if (light instanceof THREE.SpotLight) {
      // The authored direction is in the object's own frame and goes through the
      // same y negation every placement in render3d/ does. Absent, it points
      // down the level (+y in sim terms), which is what a grate overhead does.
      const dir = new THREE.Vector3(data.dirX ?? 0, threeY(data.dirY ?? 1), data.dirZ ?? 0);
      // An authored direction of nothing is a lamp aiming nowhere, which would
      // render as a lamp that does not work. Fall back rather than refuse.
      if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
      dir.normalize();
      const target = new THREE.Object3D();
      // Aimed at a point one range away, so the target is inside the volume the
      // light actually reaches whatever the range is. A child of the holder, so
      // the beam cannot swing off its own fitting when the body turns - a spot
      // aims at an `Object3D`, and one left in world space does exactly that.
      target.position.copy(dir).multiplyScalar(Math.max(range, 1));
      holder.add(target);
      light.target = target;

      // The cone made visible, hung on the same holder along the same aim and
      // built from the light's own reach, cone and colour, so it cannot drift
      // off the lamp it belongs to. Nothing at all for a spot asking for
      // neither field, which is every spot authored before them.
      beam = buildBeam({
        range,
        angleDeg: data.angle ?? DEFAULT_SPOT_ANGLE,
        penumbra: data.penumbra ?? DEFAULT_SPOT_PENUMBRA,
        color,
        beam: data.beam ?? 0,
        dust: data.dust ?? 0,
        dir,
        phase,
        time: this.beamTime,
        viewHalfHeight: this.beamViewHalfHeight,
      });
      if (beam) holder.add(beam.root);
    }

    const wantsShadow = data.castShadow === true && this.shadowsLeft > 0;
    if (wantsShadow) this.shadowsLeft--;
    light.castShadow = wantsShadow;
    if (wantsShadow) {
      light.shadow.mapSize.set(LIGHT_SHADOW_MAP_SIZE, LIGHT_SHADOW_MAP_SIZE);
      // The authored near plane, for the lantern case (see LIGHT_SHADOW_NEAR).
      // Capped at half the reach so an over-authored value leaves a working
      // shadow camera rather than one whose near passes its far, and floored at
      // the default LAST - a near of 0 is a degenerate perspective camera, and
      // the cap alone would produce one on a light authored with `range: 0`
      // (three's "no cutoff").
      const near = Math.max(
        Math.min(data.shadowNear ?? LIGHT_SHADOW_NEAR, range / 2),
        LIGHT_SHADOW_NEAR,
      );
      light.shadow.camera.near = near;
      // The light reaches `range` and nothing past it is lit, so nothing past it
      // can be shadowed either: the depth range is spent exactly where it is
      // used, which is most of what keeps a small map from banding.
      light.shadow.camera.far = Math.max(range, near * 2);
      // NO CONSTANT BIAS. `shadow.bias` is an offset in the shadow camera's own
      // DEPTH BUFFER, and a lamp's camera is a perspective one, so that buffer
      // is wildly nonlinear: almost all of it is spent in the first metre and
      // the whole of the far half of a 12 m lamp's reach is worth about a
      // thousandth of it. A value that reads as a hair's breadth near the bulb
      // is therefore metres of peter-panning at the other end - and a shadow
      // whose caster is nearer its receiver than that simply never appears.
      // A cage hanging a metre off the floor under a lamp 9 m above it is
      // separated by 0.0012 of that buffer, against a bias of 0.002: the whole
      // shadow, cancelled by a number that was tuned against the sun's LINEAR
      // orthographic map, where the same figure is a millimetre.
      //
      // `normalBias` is the one that transfers, being a push along the surface
      // normal in METRES - the same distance wherever in the frustum it is
      // applied - and it is what handles the acne a constant bias was there for.
      light.shadow.normalBias = 0.03;
    }

    parent.add(holder);
    const flicker = clamp01(data.flicker ?? 0);
    if (flicker > 0) this.flickers = true;
    this.built.push({
      light,
      holder,
      baseIntensity: intensity,
      flicker,
      phase,
      beam,
    });
    return { holder };
  }

  // Give one back. The visual that owns it is going away, and a rig holding a
  // light whose parent has been cleared is both a leak and a slot of the budget
  // spent on nothing.
  drop(mounted: MountedLight): void {
    // A swarm OUTLIVES its body: fireflies following the ball are not part of
    // the rock they were found on, and ones still at home keep hovering where
    // it was. Only the home marker goes; the swarm, its draw and its light stay
    // until the level does (`dispose`).
    const f = this.swarms.find((s) => s.holder === mounted.holder);
    if (f) {
      f.holder.updateWorldMatrix(true, false);
      const at = f.holder.getWorldPosition(this.scratch);
      f.holder.removeFromParent();
      f.holder.position.copy(at);
      f.holder.rotation.set(0, 0, 0);
      f.holder.updateMatrixWorld(true);
      return;
    }
    const g = this.glows.findIndex((s) => s.holder === mounted.holder);
    if (g >= 0) {
      const s = this.glows[g]!;
      // Handed back as authored: the materials are cached by their instance
      // key and outlive this rig (the editor rebuilds the scene on every edit).
      for (const d of s.driven) d.material.emissiveIntensity = d.authored;
      s.holder.removeFromParent();
      this.glows.splice(g, 1);
      return;
    }
    const i = this.built.findIndex((b) => b.holder === mounted.holder);
    if (i < 0) return;
    const b = this.built[i]!;
    if (b.light.castShadow) this.shadowsLeft++;
    b.light.dispose();
    b.beam?.dispose();
    b.holder.removeFromParent();
    b.holder.clear();
    this.built.splice(i, 1);
    this.flickers = this.built.some((x) => x.flicker > 0);
  }

  // Advance the flicker and the beams. `seconds` is a wall clock and never the
  // sim's - see the header. `viewportHeight` is the drawn viewport's height in
  // device pixels, which the beams' dust needs to draw its motes a size in
  // metres (see `beam.ts`, and the water's `updateWater`). Two shared writes,
  // and nothing else for a rig with no flickering light in it.
  //
  // `focus` is where the waking lights are judged from (see `updateGlows`);
  // absent, they are not stepped at all.
  update(seconds: number, viewportHeight: number, focus?: GlowFocus): void {
    this.beamTime.value = seconds;
    this.beamViewHalfHeight.value = viewportHeight / 2;
    const dt = this.lastSeconds === null ? 0 : seconds - this.lastSeconds;
    this.lastSeconds = seconds;
    if (focus && this.glows.length > 0) this.updateGlows(seconds, dt, focus);
    if (focus && this.swarms.length > 0) this.updateFireflies(seconds, dt, focus);
    if (!this.flickers) return;
    for (const b of this.built) flick(b, seconds);
  }

  // How many pool lights this rig carries (0 until `buildPool`).
  get poolSize(): number {
    return this.pool.length;
  }

  // The waking sources' current levels, in authored order. For the probe and
  // the cases; nothing drives from it.
  glowLevels(): number[] {
    return this.glows.map((s) => s.level);
  }

  // Build the pool, once, after every body of the level has been added and
  // before `Scene3D.prewarm` compiles against the scene's lights: one point
  // light per waking source, capped at GLOW_POOL, so a level with none is the
  // scene it always was. In WORLD space (children of the scene, not of a body),
  // intensity 0, no shadow - a point light's shadow is six renders, and a map
  // handed between sources as they swap would flash.
  //
  // The fireflies' pool and their draw are built here too, for the same reason:
  // `min(FIREFLY_POOL, swarms)` lights and one `Points` holding every mote, so
  // a level with no swarm is the scene it always was.
  buildPool(scene: THREE.Object3D): void {
    this.disposePool();
    const n = poolSizeFor(this.glows.length);
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, DEFAULT_LIGHT_RANGE, 2);
      light.castShadow = false;
      light.name = `glow-pool-${i}`;
      scene.add(light);
      this.pool.push(light);
    }
    const f = fireflyPoolSizeFor(this.swarms.length);
    for (let i = 0; i < f; i++) {
      const light = new THREE.PointLight(0xffffff, 0, FIREFLY_RANGE, 2);
      light.castShadow = false;
      light.name = `firefly-pool-${i}`;
      scene.add(light);
      this.fireflyPool.push(light);
    }
    if (this.swarms.length > 0) {
      this.fireflyVisual = new FireflyVisual(this.swarms, this.beamViewHalfHeight);
      scene.add(this.fireflyVisual.root);
    }
  }

  // Each swarm's state, in authored order, for the probe and the cases:
  // whether it is following the ball, and where its light hangs (sim frame,
  // metres, y down). Nothing drives from it.
  swarmStates(): {
    following: boolean;
    x: number;
    y: number;
    ahead: { x: number; y: number } | null;
  }[] {
    return this.swarms.map((s) => {
      const a = s.swarm?.aheadDir() ?? null;
      return {
        following: s.swarm?.following ?? false,
        x: s.x,
        y: threeY(s.y),
        ahead: a ? { x: a.x, y: threeY(a.y) } : null,
      };
    });
  }

  // The level's authored routes - its camera PATHS, as level geometry - which
  // the fireflies hover ahead of the ball along (see `fireflies.ts`). Sim
  // frame. Set once a level, after `buildPool`.
  //
  // What the swarms read is built here once, in three's frame (y up): every
  // query flips y on the way in and on the way out.
  setRoutes(routes: readonly PolylineIndex[]): void {
    const flip = (v: Vec2): { x: number; y: number } => ({ x: v.x, y: threeY(v.y) });
    this.place = {
      routes: routes.length,
      project: (i, x, y, near) => {
        const ix = routes[i]!;
        const p = new Vec2(x, threeY(y));
        return near === null
          ? projectOntoPolyline(ix, p)
          : projectOntoPolylineWindow(ix, p, near - ROUTE_WINDOW, near + ROUTE_WINDOW);
      },
      point: (i, s) => flip(pointAtArcLength(routes[i]!, s)),
      tangent: (i, s) => flip(tangentAtArcLength(routes[i]!, s)),
      solid: (x, y, r) => this.solidAt(x, y, r),
    };
  }

  // Whether a disc at (x, y) in three's frame overlaps the level's solid
  // scenery - somewhere the player cannot go - in the world handed to the last
  // `update`. Solid scenery only: not the ball, its hook, a vine or a hook-only
  // body, whose layers are their own (see `LAYER_SCENERY`). Read-only.
  private solidAt(x: number, y: number, r: number): boolean {
    const world = this.world;
    if (!world) return false;
    const p = new Vec2(x, threeY(y));
    for (const shape of world.queryShapes(p.x - r, p.y - r, p.x + r, p.y + r)) {
      if ((shape.layer & LAYER_SCENERY) === 0) continue;
      if (circleOverlap(p, r, shape)) return true;
    }
    return false;
  }

  // Fly every swarm (hatching any not yet hatched at its home), refresh the
  // motes' draw, and hand the fireflies' pool to the swarms nearest the ball.
  private updateFireflies(seconds: number, dt: number, focus: GlowFocus): void {
    // In three's frame, on the plane: the ball is at z 0.
    const ball = focus.ball ? { x: focus.ball.x, y: threeY(focus.ball.y), z: 0 } : null;
    const view = { x: focus.view.x, y: threeY(focus.view.y) };
    this.world = focus.world ?? null;
    const place = this.place;
    for (const s of this.swarms) {
      s.holder.updateWorldMatrix(true, false);
      const w = s.holder.getWorldPosition(this.scratch);
      const home = { x: w.x, y: w.y, z: w.z };
      if (!s.swarm) s.swarm = new Swarm(s.params, home, s.seed);
      s.swarm.step(dt, home, ball, place);
      const c = s.swarm.lightAt();
      s.x = c.x;
      s.y = c.y;
      s.z = c.z;
      s.level = s.intensity > 0 ? 1 : 0;
    }
    this.fireflyVisual?.update();

    if (this.fireflyPool.length === 0) return;
    const served = assignPool(this.swarms, ball ?? view, this.fireflyPool.length);
    for (let i = 0; i < this.fireflyPool.length; i++) {
      const light = this.fireflyPool[i]!;
      const s = served[i] !== undefined ? this.swarms[served[i]!]! : null;
      if (!s) {
        light.intensity = 0;
        continue;
      }
      light.position.set(s.x, s.y, s.z);
      light.color.copy(s.color);
      light.distance = s.range;
      light.intensity = s.intensity * flickerLevel(s.flicker, s.phase, seconds);
    }
  }

  // Step every waking source against the ball, write its emission, and hand
  // the pool to the awake ones nearest the focus.
  private updateGlows(seconds: number, dt: number, focus: GlowFocus): void {
    // Judged on the GAMEPLAY PLANE, in three's frame (y up): the ball lives on
    // the plane, so the trigger is the distance the editor draws as the wake
    // circle, whatever the light's own z.
    const ball = focus.ball ? { x: focus.ball.x, y: threeY(focus.ball.y) } : null;
    const view = { x: focus.view.x, y: threeY(focus.view.y) };
    for (const s of this.glows) {
      // Lights ride their body, whose group three only walks at render time,
      // so the holder's world matrix is brought up to date here first.
      s.holder.updateWorldMatrix(true, false);
      s.holder.getWorldPosition(this.scratch);
      s.x = this.scratch.x;
      s.y = this.scratch.y;
      s.z = this.scratch.z;
      if (this.previewAwake) s.level = 1;
      else if (ball) s.level = s.state.step(Math.hypot(s.x - ball.x, s.y - ball.y), dt);
    }

    // Emission: a body with several waking lights follows the brightest.
    const levels = new Map<THREE.MeshStandardMaterial, { authored: number; level: number }>();
    for (const s of this.glows) {
      for (const d of s.driven) {
        const e = levels.get(d.material);
        if (e) e.level = Math.max(e.level, s.level);
        else levels.set(d.material, { authored: d.authored, level: s.level });
      }
    }
    for (const [m, e] of levels) m.emissiveIntensity = e.authored * e.level;

    if (this.pool.length === 0) return;
    const served = assignPool(this.glows, this.previewAwake || !ball ? view : ball, this.pool.length);
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]!;
      const s = served[i] !== undefined ? this.glows[served[i]!]! : null;
      if (!s) {
        light.intensity = 0;
        continue;
      }
      light.position.set(s.x, s.y, s.z);
      light.color.copy(s.color);
      light.distance = s.range;
      light.intensity = s.intensity * s.level * flickerLevel(s.flicker, s.phase, seconds);
    }
  }

  private disposePool(): void {
    for (const light of [...this.pool, ...this.fireflyPool]) {
      light.removeFromParent();
      light.dispose();
    }
    this.pool = [];
    this.fireflyPool = [];
    this.fireflyVisual?.dispose();
    this.fireflyVisual = null;
  }

  dispose(): void {
    for (const s of this.glows) {
      for (const d of s.driven) d.material.emissiveIntensity = d.authored;
      s.holder.removeFromParent();
    }
    this.glows.length = 0;
    for (const s of this.swarms) s.holder.removeFromParent();
    this.swarms.length = 0;
    this.disposePool();
    this.lastSeconds = null;
    for (const b of this.built) {
      b.light.dispose();
      b.beam?.dispose();
      b.holder.removeFromParent();
      b.holder.clear();
    }
    this.built.length = 0;
    this.shadowsLeft = LIGHT_SHADOW_BUDGET;
    this.place = OPEN_PLACE;
    this.world = null;
    this.flickers = false;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// A flicker's multiplier on the authored intensity at `seconds`, 1 for a steady
// light. Two rates summed and halved, so the swing is -1..1 before the depth is
// applied; the light is modulated DOWN from its authored intensity rather than
// around it, because a flame gutters below its own brightness and a lamp that
// spent half its time brighter than authored would make the authored number
// mean nothing.
function flickerLevel(flicker: number, phase: number, seconds: number): number {
  if (flicker <= 0) return 1;
  const t = seconds + phase;
  const wave = (Math.sin(t * FLICKER_RATE_A) + Math.sin(t * FLICKER_RATE_B)) * 0.5;
  return 1 - flicker * 0.5 * (1 - wave);
}

// One light's guttering, against its own authored intensity.
function flick(b: BuiltLight, seconds: number): void {
  if (b.flicker <= 0) return;
  const level = flickerLevel(b.flicker, b.phase, seconds);
  b.light.intensity = b.baseIntensity * level;
  // The beam is the same light made visible, so it gutters with it.
  b.beam?.setLevel(level);
}
