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

import * as THREE from "three";
import type { LightObjectData } from "../level/levelFormat";
import { threeY } from "./space";

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
}

// A built light, handed back to its owner so it can be given up as a unit. Half
// a lamp is not a thing an owner should be able to hold.
export interface MountedLight {
  readonly holder: THREE.Object3D;
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

  // Hang a light on `parent` for `data`, at `place` in the parent's frame, or
  // nothing at all when the budget is spent. Returns it so its owner can hand it
  // back at dispose.
  add(
    parent: THREE.Object3D,
    data: LightObjectData,
    place: LightPlacement,
  ): MountedLight | null {
    if (this.built.length >= LIGHT_BUDGET) return null;

    const color = new THREE.Color(data.color ?? DEFAULT_LIGHT_COLOR);
    const intensity = data.intensity ?? DEFAULT_LIGHT_INTENSITY;
    const range = data.range ?? DEFAULT_LIGHT_RANGE;
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
      // Golden-ratio stride: any fixed step lands neighbours in step with each
      // other eventually, and this one takes longest to.
      phase: this.nextPhase++ * 2.399963,
    });
    return { holder };
  }

  // Give one back. The visual that owns it is going away, and a rig holding a
  // light whose parent has been cleared is both a leak and a slot of the budget
  // spent on nothing.
  drop(mounted: MountedLight): void {
    const i = this.built.findIndex((b) => b.holder === mounted.holder);
    if (i < 0) return;
    const b = this.built[i]!;
    if (b.light.castShadow) this.shadowsLeft++;
    b.light.dispose();
    b.holder.removeFromParent();
    b.holder.clear();
    this.built.splice(i, 1);
    this.flickers = this.built.some((x) => x.flicker > 0);
  }

  // Advance the flicker. `seconds` is a wall clock and never the sim's - see the
  // header - and a rig with no flickering light in it does nothing at all.
  update(seconds: number): void {
    if (!this.flickers) return;
    for (const b of this.built) flick(b, seconds);
  }

  dispose(): void {
    for (const b of this.built) {
      b.light.dispose();
      b.holder.removeFromParent();
      b.holder.clear();
    }
    this.built.length = 0;
    this.shadowsLeft = LIGHT_SHADOW_BUDGET;
    this.flickers = false;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// One light's guttering, against its own authored intensity.
function flick(b: BuiltLight, seconds: number): void {
  if (b.flicker <= 0) return;
  const t = seconds + b.phase;
  // Two rates summed and halved, so the swing is -1..1 before the depth is
  // applied; the light is modulated DOWN from its authored intensity rather
  // than around it, because a flame gutters below its own brightness and a
  // lamp that spent half its time brighter than authored would make the
  // authored number mean nothing.
  const wave = (Math.sin(t * FLICKER_RATE_A) + Math.sin(t * FLICKER_RATE_B)) * 0.5;
  b.light.intensity = b.baseIntensity * (1 - b.flicker * 0.5 * (1 - wave));
}
