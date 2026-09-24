// Flowing water as a soft digital painting - smooth teal with wispy hairline
// highlights - lit by the scene (see "The look" below and docs/water.md). A
// channel with a `spill` pours off its downstream end as a fall, built into
// the same mesh under the same shader so the two are seamless by
// construction.
//
// The motion comes from one asset: a 60-layer flipbook of tangent-space normal
// maps (a looping capture of real choppy water), played by crossfading
// consecutive layers and scrolled along the flow. Two samples at different
// scales and rates drive the band field per pixel and distort the strokes, so
// the whole surface moves as one body of water rather than as stacked effects.
//
// WHAT WAS LEARNED FROM THE REMOVED RENDERER (assets-src/water-removed) and is
// kept here:
// - NO `transmission`. It re-renders the whole opaque scene every frame (2.2x
//   frame cost measured). This water is ordinary alpha-blended opacity: one
//   draw call, no extra passes.
// - The camera is near-orthographic, so a flat top face is edge-on and
//   invisible. The surface is therefore drawn RAKED - tilted toward the camera
//   like stage scenery - so the player actually sees the animated water plane.
// - The front of the slab is most of the on-screen pixels. It gets the same
//   animated normals (in its own elevation frame) plus a murk gradient, so it
//   reads as looking into the water instead of at a green rectangle.
// - Emission is a floor, not the look: lamps light the water, and a faint
//   shimmer modulated by the normals' own churn keeps unlit stretches alive.
// - Driven by the WALL CLOCK handed in by `Scene3D` (`updateWater`), so the
//   fixed-step sim never sees any of it and a pinned-clock headless grab is the
//   same picture twice.
//
// The flipbook and the foam mask live in the release asset store like every
// other binary (`RAW_ASSETS` in assets.ts - fetched to `public/water/`, sha256
// pinned, provenance recorded, budgeted by `cli assets`).

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import type { GeometryObjectData, LevelBodyData } from "../level/levelFormat";
import { RAW_ASSETS, trackPending } from "./assets";
import { withDownload } from "./download";

// ---------------------------------------------------------------------------
// The flipbook
// ---------------------------------------------------------------------------

// Path and weight both off the manifest (`RAW_ASSETS`), which is where the
// store's facts about a file live - a second copy of the path here is a second
// thing to forget when the atlas is re-published, and the size is what the
// loading bar counts down (see download.ts).
const FLIP = RAW_ASSETS["water-normal-flip"]!;
const FLIP_COLS = 10;
const FLIP_ROWS = 6;
const FLIP_SIZE = 256;
const FLIP_FRAMES = FLIP_COLS * FLIP_ROWS;
// The source is a 120-frame loop at 30 fps; every second frame is shipped, so
// playing the 60 layers at 15 layers/s (with crossfade) keeps the original 4 s
// loop and the original speed of the churn.
const FLIP_FPS = 15;

// One texture array shared by every water material in every scene. A
// `DataArrayTexture` rather than an atlas sampled with fract(), because layer
// edges then wrap in hardware: no gutters, no bleeding between frames.
let flipTexture: THREE.DataArrayTexture | null = null;
let flipStarted = false;
// 0 until the real frames are uploaded; the shader blends its perturbation in
// by this, so unloaded water is flat and dark rather than garbage.
const flipReady = { value: 0 };

function ensureFlipbook(): THREE.DataArrayTexture {
  if (flipTexture) return flipTexture;
  // Neutral "straight up" normal in every layer until the download lands.
  const data = new Uint8Array(FLIP_SIZE * FLIP_SIZE * 4 * FLIP_FRAMES);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataArrayTexture(data, FLIP_SIZE, FLIP_SIZE, FLIP_FRAMES);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  flipTexture = tex;

  if (!flipStarted) {
    flipStarted = true;
    // Tracked so `assetsSettled` (and therefore `cli shot --3d`) waits for it:
    // a screenshot that races this load photographs flat water one run and
    // rippled water the next, which is evidence of nothing.
    void trackPending(loadFlipbook(tex), "water flipbook").catch(() => {
      // Failed load leaves the neutral normal in place: flat, dark water.
    });
  }
  return tex;
}

async function loadFlipbook(tex: THREE.DataArrayTexture): Promise<void> {
  // An <img> load rather than fetch+createImageBitmap: it is what every other
  // texture here rides, and it is what the headless grab's virtual clock knows
  // to wait for - a createImageBitmap decode never resolved under it and hung
  // `assetsSettled`, which a screenshot reads as a silently blank page.
  // Counted on the way past like every other stored file, so the loading
  // screen's bar covers the atlas too (see render3d/download.ts).
  const image = await withDownload(FLIP.file, FLIP.bytes, (href) =>
    new THREE.ImageLoader().loadAsync(href),
  );
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const img = ctx.getImageData(0, 0, image.width, image.height).data;
  const bitmap = { width: image.width, height: image.height };
  const out = tex.image.data as Uint8Array;
  const rowBytes = FLIP_SIZE * 4;
  for (let f = 0; f < FLIP_FRAMES; f++) {
    const sx = (f % FLIP_COLS) * FLIP_SIZE;
    const sy = Math.floor(f / FLIP_COLS) * FLIP_SIZE;
    const dst = f * FLIP_SIZE * rowBytes;
    for (let y = 0; y < FLIP_SIZE; y++) {
      // Data textures have no flipY, so rows are written bottom-up to keep the
      // map in the orientation every image-based texture here has.
      const src = ((sy + y) * bitmap.width + sx) * 4;
      out.set(img.subarray(src, src + rowBytes), dst + (FLIP_SIZE - 1 - y) * rowBytes);
    }
  }
  tex.needsUpdate = true;
  flipReady.value = 1;
}

// ---------------------------------------------------------------------------
// The foam mask
// ---------------------------------------------------------------------------

// A baked tiling mask of where foam sits (see scripts/bake-foam.ts): long torn
// ribbons stretched along u, histogram shaped for the shader's soft threshold.
// One texture, image swapped in when the download lands - the placeholder is a
// 1x1 black canvas, and `foamReady` gates the effect until then.
const FOAM = RAW_ASSETS["water-foam"]!;
let foamTexture: THREE.Texture | null = null;
const foamReady = { value: 0 };

function ensureFoam(): THREE.Texture {
  if (foamTexture) return foamTexture;
  const placeholder = new OffscreenCanvas(1, 1);
  placeholder.getContext("2d")!.fillRect(0, 0, 1, 1);
  const tex = new THREE.Texture(placeholder as unknown as HTMLCanvasElement);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  foamTexture = tex;
  void trackPending(
    withDownload(FOAM.file, FOAM.bytes, (href) =>
      new THREE.ImageLoader().loadAsync(href),
    ).then((image) => {
      tex.image = image as unknown as HTMLCanvasElement;
      // The image is a different SIZE from the placeholder, and WebGL2 texture
      // storage is immutable once allocated: without a dispose the upload is a
      // texSubImage2D into the placeholder's 1x1 storage, which fails
      // (GL_INVALID_VALUE, offset overflows texture dimensions) and leaves the
      // foam black on any page that rendered before the download landed.
      // dispose() frees the GL object so the next bind allocates at full size.
      tex.dispose();
      tex.needsUpdate = true;
      foamReady.value = 1;
    }),
    "water foam",
  ).catch(() => {
    // Failed load leaves the placeholder: water without foam.
  });
  return tex;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Wall-clock seconds, shared by every water material so two bodies of water in
// one level can never drift apart. Written once per frame by `Scene3D`, from
// the same clock (pinnable) the light flicker reads.
const waterTime = { value: 0 };
// The viewport's height in device pixels, for the spray: a point sprite's size
// is set in pixels, and a droplet authored in metres needs the projection's
// pixels-per-metre at its depth to stay the same size when the window
// changes. Written beside the clock.
const waterViewHalfHeight = { value: 540 };

// The textures the water shader samples, for the prewarm (see
// `Scene3D.prewarm`): they ride the material as uniforms rather than as map
// slots, so a sweep of the scene's materials cannot see them. Empty until the
// first water material is built.
export function waterTextures(): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  if (flipTexture) out.push(flipTexture);
  if (foamTexture) out.push(foamTexture);
  return out;
}

export function updateWater(seconds: number, viewportHeight: number): void {
  waterTime.value = seconds;
  waterViewHalfHeight.value = viewportHeight / 2;
}

// ---------------------------------------------------------------------------
// The look
// ---------------------------------------------------------------------------

// A DIGITAL PAINTING of water, after the two reference pictures this was
// tuned against (2026-09-17): a river of smooth saturated teal with soft
// tonal drift and thin wispy highlight hairlines running with the flow, and
// a fall of long soft vertical ribbons under a bright brow, sparkling, into
// a wide soft cloud of white at its base. Soft everywhere: no outlines, no
// hard bands, no lace. (A cel-shaded cut into flat bands with inked edges was
// the first reading of "painterly" and was not it.)
//
// The water stays LIT BY THE SCENE - the same lamps, fog and tone mapping as
// the rock beside it - with a little gloss but no normal perturbation, so the
// sheen is a soft wash rather than glints. The flipbook does not light the
// water; it drives the tone field and distorts the strokes, so the painting
// moves like water.
//
// The palette is derived from the authored `color` so a level tunes the
// water by its one colour field, the way it tunes everything else.
//
// A CHANNEL AND ITS FALL ARE ONE MESH UNDER ONE SHADER. The fall is the
// channel's own water leaving its downstream end, and it is built that way:
// the tube's first ring IS the channel's end rectangle - the same vertices'
// positions, the same lit/alpha/frame attributes by face - so the top face
// and the front sheet run over the lip into the tube with no step, no cap,
// no second material and no second set of texture coordinates to line up.
// Every earlier fall was a separate body whose tube tried to meet the
// channel's end and never quite did: a step where the waves lifted the
// surface above a flat brow, a cap standing under a thin pour, a second
// translucent surface showing the first through it.

// Where the water sits through z, in metres - EXACTLY the extruder's own
// convention (see extrude.ts): `depth` is centred on the gameplay plane,
// -depth/2 to +depth/2, and the object's `z` shifts the whole slab, positive
// toward the camera. Water beside an extruded bank authored with the same two
// numbers aligns with it face for face, which is what makes the fields worth
// putting on the geometry object at all.
//
// Two constraints shaped this and are worth keeping:
// - `z` absent and `z: 0` MUST mean the same slab: the editor writes only
//   what differs from its defaults, so an authored 0 does not survive a save.
//   A default the author cannot re-type is a trap (an earlier tuned centre of
//   -0.34 snapped the slab the moment the field was touched).
// - The default depth keeps the front face past the ball (radius 0.12), so a
//   submerged ball reads as IN the water.
//
// The top face runs from the back to the front, and the perspective camera
// looking slightly down on it is what shows it - the slab is HORIZONTAL,
// exactly level with the waterline. (A raked stage-scenery surface was tried
// for more on-screen surface and read as the water being tilted against the
// level's own geometry.)
const DEFAULT_WATER_DEPTH = 1.12;
// Column spacing of the displaced grids, in metres. Must resolve the highest
// wave harmonic below or the surface aliases into channel-sized beats (the
// removed renderer's hard-won Nyquist lesson): 17.3 rad/m is a 0.36 m
// wavelength, so 0.06 m gives it six samples.
const WAVE_SEG = 0.06;
const SURFACE_ROWS = 10;
const FRONT_ROWS = 6;
// The wave train riding the surface: spatial frequencies along the flow
// (rad/m), amplitudes (of WAVE_HEIGHT), and each harmonic's own churn rate
// (rad/s) so the sum tumbles rather than sliding past as one frozen shape.
const WAVE_HARMONICS = [1.8, 4.1, 9.7, 17.3];
const WAVE_AMPLITUDES = [0.45, 0.3, 0.18, 0.09];
const WAVE_CHURN = [0.7, -1.3, 2.4, -3.8];
// ...and each harmonic's wavenumber ACROSS the flow (rad/m). Without these the
// wave sum is a function of x alone, so every crest is a perfect ridge
// spanning the slab's whole depth - a corrugated sheet. With them the surface
// is a genuine 2D field: crests wander and break up through depth, and the
// silhouette stops matching the surface behind it. Kept below ~8 rad/m so the
// grid's rows (SURFACE_ROWS across the depth) still resolve the finest one.
const WAVE_CROSS = [0.7, -1.9, 4.2, -7.3];
const WAVE_HEIGHT = 0.05;
// The waves die out over this many metres before a run's ends: a brink goes
// glassy as the water accelerates over it, and it is what lets the fall's
// flat first ring meet the surface exactly.
const WAVE_END_TAPER = 0.5;
// How far below the waterline the front sheet keeps waving before it hangs
// still, and how far down the light gets.
const WAVE_FALLOFF = 0.22;
const LIGHT_FALLOFF = 0.5;
// The two flipbook layers: metres per repeat, and how fast each pattern drifts
// as a fraction of the authored current. Under 1 on purpose - surface texture
// visibly lags the water carrying it, and at the current's full speed a
// scrolling pattern starts strobing.
const TILE_COARSE = 3.2;
const TILE_FINE = 1.3;
const DRIFT_COARSE = 0.55;
const DRIFT_FINE = 0.8;
// Playback rate of the flipbook as a fraction of its captured speed: at half
// speed its shapes swell and drift the way painted water is animated.
const PAINT_RATE = 0.5;

// THE STROKES. The baked cellular web (see scripts/bake-foam.ts) sampled with
// its tile stretched along the flow, so every cell edge is a long thin line
// running with the current: those lines ARE the reference's hairline
// highlights, once thresholded high enough that only the strongest survive.
// A second, finer sample breaks each line along its length so it is a wisp
// with soft ends rather than a rule. Distorted by the flipbook normals so the
// strokes churn with the water; carried at the current's speed. Down a fall
// the same lines are its ribbons, which is what keeps them continuous over
// the lip.
const STROKE_TILE = 1.4;
const STROKE_STRETCH = 8.0;
const STROKE_DISTORT = 0.04;
const STROKE_BREAK_TILE = 0.5;
const LINE_LO = 0.62;
const LINE_HI = 0.92;
const LINE_STRENGTH = 0.7;

// THE TONE. A smooth field, centred on the body colour, drifting toward the
// deep in the troughs and the light on the crests: the reference's soft
// tonal variation. Weights on the vertex waves, the flipbook's churn and the
// strokes; the field is mapped through deep -> body -> light continuously.
const TONE_CREST_W = 0.18;
const TONE_CHURN_W = 0.25;
const TONE_STROKE_W = 0.2;
// The front sheet darkens smoothly into the deep below the waterline, and a
// soft pale line sits AT the waterline, where painted water meets its bank.
const FRONT_DEEP_W = 0.7;
const WATERLINE_WIDTH = 0.06;
const WATERLINE_W = 0.45;
// Water lightens toward a run's ends, softly, the way the reference's river
// pales toward its banks; metres of reach. A fall is past the end, so it is
// pale all the way down, which is the reference's paler sheet.
const BANK_REACH = 0.9;
const BANK_W = 0.3;
// Water with no authored colour: the reference river's own body teal, so a
// water body dropped into a level is the right water before anyone tunes it.
const WATER_DEFAULT_COLOR = "#2c8896";
// The palette: the authored colour at four LIGHTNESSES, its hue kept and its
// saturation carried nearly whole up the ramp.
// The stops are k-means clusters of the reference river's own water (a
// turquoise gorge, masked to the water by hue): #1b4657 in the deep, #1e6c86
// and #3391aa through the body, #6ecad9 on the crests, #a1dce7 going into the
// foam - one teal at six lightnesses, hue 186-197 throughout.
// Saturation is the thing that reference settles. It does not fall as the
// water lightens the way a blue pool's does (0.53 at the deepest cluster,
// 0.58 at the brightest), so the light stop keeps the tint's own saturation
// outright and only the near-white pale eases off. A ramp that desaturates
// upward turns a teal's crests grey, which is the same failure as below by a
// different route.
// The ramp this replaced mixed the tint toward black and toward white in
// linear RGB, and both ends of that greyed: a whiten in linear space lifts a
// teal's weak red channel fastest, so the crests desaturated to paper, and
// the deep lerped a third of the way to near-black. A teal channel drew as
// wet concrete with white scum on it. Moving the stops in HSL instead keeps
// every one of them the same water.
// The deep as a fraction of the tint's own lightness; the light and the pale
// as how far the tint is lifted toward white. `body` IS the tint: the level
// authors the colour its water reads as, not a colour it is derived from.
const RAMP_DEEP_L = 0.62;
const RAMP_DEEP_S = 1.0;
const RAMP_LIGHT_L = 0.42;
const RAMP_LIGHT_S = 1.0;
const RAMP_PALE_L = 0.82;
const RAMP_PALE_S = 0.85;
// Sheen: a little gloss and a touch of the environment, as a soft wash.
const WATER_ROUGHNESS = 0.6;
const WATER_ENV = 0.2;

// The faint self-glow that keeps an unlit stretch of channel readable (a
// trace, not the look - lamps light the water).
const GLOW_INTENSITY = 0.1;

// Alpha: the surface is nearly solid, the front sheet is murky glass so the
// submerged ball stays a visible silhouette (an opaque front is better water
// and worse gameplay).
const ALPHA_SURFACE = 0.97;
const ALPHA_FRONT_TOP = 0.94;
const ALPHA_FRONT_BED = 0.8;
// The front sheet, and everything that meets it, sits this far behind the
// slab's nominal front. A bank authored to the same depth as the water has
// its face exactly there too, and two coplanar faces z-fight: the water won
// on some builds and the bank on others. Behind by a hair, the bank wins,
// which is what a channel sunk into rock means.
const FRONT_INSET = 0.002;

// The DRAWDOWN. Water approaching a brink speeds up and its surface dips
// into the drop - the taper into a fall that a level surface running to a
// hard edge never has. Over the last DRAWDOWN_REACH metres before the lip
// the surface lowers by DRAWDOWN of the channel's depth, smoothly, and the
// fall leaves from that lowered surface.
const DRAWDOWN = 0.3;
const DRAWDOWN_REACH = 0.8;

// ---------------------------------------------------------------------------
// The fall
// ---------------------------------------------------------------------------

// A channel with a `spill` pours off its downstream end, and the pour is a
// VOLUME: the slab leaving the channel's end goes where a thrown thing goes -
// level off the lip, then over, then down - thinning as it speeds up because
// the same water is passing every point per second. The geometry is a closed
// tube swept along that parabola. Its first ring is the channel's end
// rectangle exactly (see the note at the top), rounding into a superellipse
// over the brow the way a free surface does, and shrinking by v0/v(t) down
// the arc. A flat sheet with a picture of a waterfall on it was the first
// attempt, and it read as exactly that from any angle but the game's.
//
// Painted like the reference: the strokes become long soft ribbons down the
// sheet, a bright brow where the sheet curves over the lip, sparkle dots
// riding the surface, and the base dissolving into a wide soft white cloud
// (see `sprayPoints`).
const FALL_GRAVITY = 9.81;
// Samples along the arc and around a cross-section. Along is uniform in TIME,
// which packs the samples into the brow where the curve is and spreads them
// down the straight drop.
const FALL_STEPS = 48;
// A MULTIPLE OF EIGHT: the slice's vertices are sampled by angle, and the
// lip's rectangle has its corners at 45 degrees. A count that skips them
// cuts each corner to a chamfer, and the channel's sharp corner then stands
// off the tube's - a black triangle at every corner of the lip.
const FALL_RING = 32;
// How far past the pool's surface the tube keeps going.
const FALL_OVERSHOOT = 0.2;
// The cross-section rounds from the channel's rectangle at the lip into a
// superellipse (exponent: 2 an ellipse, higher squarer) over this fraction
// of the fall.
const FALL_CORNER = 3.5;
const FALL_CORNER_BLEND = 0.35;
// The tube's z-width contracts to this fraction by the base. Its thickness
// needs no rule: every layer of the slab follows the same parabola from its
// own height, so the sheet thins by v0/v exactly as continuity says (see
// `appendFall`).
const FALL_WIDTH_CONTRACT = 0.85;
// Over this fraction of the fall the channel's own attributes (its front
// sheet's murk and alpha, its top's) ease into the fall's, and the strokes'
// weights ease from the channel's into the ribbons'.
const FALL_BLEND_IN = 0.7;
const FALL_RIBBON_W = 0.6;
const FALL_CHURN_W = 0.12;
const FALL_LINE_STRENGTH = 0.7;
// The brow: a bump of light over the first fraction of the fall, where the
// sheet curves over the lip - zero AT the lip, so the channel's tone carries
// straight over it.
const FALL_BROW = 0.2;
const FALL_BROW_W = 0.5;
// Where (fraction) the sheet starts dissolving into white toward the base.
const FALL_WHITE_FROM = 0.72;
// The sheet's translucency down the drop, and solid where it goes white.
const FALL_ALPHA = 0.9;
const FALL_ALPHA_WHITE = 0.97;
const FALL_WHITE = "#eef6f8";

// SPRAY. One point cloud at the fall; three populations by `aKind`:
//   0 MIST     large soft white puffs born around the impact, drifting up and
//              out - the reference's cloud, wide and bright
//   1 SPLASH   small bright droplets thrown up from the impact, falling back
//   2 SPARKLE  tiny white dots riding the sheet's front face down the arc
const SPRAY_COUNT = 260;
const SPRAY_SPLASH_EVERY = 5;
const SPRAY_SPARKLE_EVERY = 7;
const MIST_RISE = 0.25;
const MIST_DRIFT = 0.4;
const MIST_SIZE = [0.2, 0.45];
const MIST_ALPHA = 0.35;
const MIST_LIFE = [1.8, 3.2];
// The mist is born low and wide: metres across the impact, and up.
const MIST_SPREAD_ACROSS = 0.5;
const MIST_SPREAD_UP = 0.2;
const SPLASH_UP = [1.2, 2.6];
const SPLASH_OUT = 1.2;
const SPLASH_SIZE = [0.015, 0.04];
const SPLASH_ALPHA = 0.7;
const SPLASH_LIFE = [0.35, 0.7];
const SPARKLE_SIZE = [0.012, 0.024];
const SPARKLE_ALPHA = 0.8;

const fmt = (n: number): string => n.toFixed(4);

function waveSumGlsl(phase: string, across: string): string {
  return WAVE_HARMONICS.map(
    (k, i) =>
      `sin(${phase} * ${fmt(k)} + ${across} * ${fmt(WAVE_CROSS[i]!)} + uTime * ${fmt(WAVE_CHURN[i]!)}) * ${fmt(WAVE_AMPLITUDES[i]!)}`,
  ).join(" + ");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// The fall's arc, in the channel's local frame (three's y-up: local +X is
// the flow axis, +Y up, +Z toward the camera). The water leaves the lip at
// `xEnd` travelling `side` along x at `v0` and falls under gravity.
interface FallArc {
  tEnd: number;
  // Centre of the cross-section at time t.
  centre: (t: number) => { x: number; y: number };
  velocity: (t: number) => { x: number; y: number };
}

function fallArc(xEnd: number, side: number, v0: number, halfY: number, drop: number): FallArc {
  const length = drop + halfY + FALL_OVERSHOOT;
  return {
    tEnd: Math.sqrt((2 * length) / FALL_GRAVITY),
    centre: (t) => ({ x: xEnd + side * v0 * t, y: -0.5 * FALL_GRAVITY * t * t }),
    velocity: (t) => ({ x: side * v0, y: -FALL_GRAVITY * t }),
  };
}

// Everything in one BufferGeometry, in the body's local frame: the surface
// strip, the front sheet hanging from its front edge down to the bed, a cap
// at the upstream end (and at the downstream end when nothing pours off it),
// and the fall's tube. Attributes beyond position/normal:
//   aWave   - how much of the wave displacement this vertex takes (1 at the
//             waterline, fading down the front sheet, 0 on the tube)
//   aLit    - how far the light gets: 1 at the surface, ~0 at the bed; on the
//             tube, the value of the channel face it continues, easing to 1
//   aAlpha  - opacity, by the same rule
//   aUp     - 1 on the surface (plan-view texture frame), 0 on the front
//             sheet (elevation frame); on the tube, by face, blended at the
//             corners. The two faces need different "across" coordinates or
//             every feature smears into bars.
//   aFrozen - the point whose world position the texture frame is taken
//             from: the vertex itself on the channel, and on the tube the
//             point of the LIP ring it descends from, so the frame is
//             constant down the fall and continuous at the lip
//   aArc    - metres of texture travelled past the lip: time from the lip at
//             the lip's speed, so a scrolling texture stretches exactly as
//             the water accelerates; 0 on the channel
//   aFall   - 0 at the lip (and on the channel), 1 at the tube's end
//   aFallOn - 1 on the tube
interface GridArrays {
  pos: number[];
  nor: number[];
  wave: number[];
  lit: number[];
  alpha: number[];
  up: number[];
  frozen: number[];
  arc: number[];
  fall: number[];
  fallOn: number[];
  index: number[];
}

function channelVertex(
  g: GridArrays,
  x: number,
  y: number,
  z: number,
  n: [number, number, number],
  wave: number,
  lit: number,
  alpha: number,
  up: number,
): void {
  g.pos.push(x, y, z);
  g.nor.push(n[0], n[1], n[2]);
  g.wave.push(wave);
  g.lit.push(lit);
  g.alpha.push(alpha);
  g.up.push(up);
  g.frozen.push(x, y, z);
  g.arc.push(0);
  g.fall.push(0);
  g.fallOn.push(0);
}

function quadIndices(index: number[], base: number, rows: number, cols: number, flip = false): void {
  const stride = cols + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = base + r * stride + c;
      const b = a + 1;
      const d = a + stride;
      const e = d + 1;
      if (flip) index.push(a, b, d, b, e, d);
      else index.push(a, d, b, b, d, e);
    }
  }
}

interface GridSpec {
  halfX: number;
  // Top and bottom edge y AT x: the surface draws down toward a lip, so the
  // top face and the front sheet's top row follow it.
  y0: (x: number) => number;
  y1: (x: number) => number;
  z0: number; // top edge z
  z1: number; // bottom edge z
  rows: number;
  up: number;
  wave: (t: number) => number; // t: 0 at top edge, 1 at bottom
  lit: (t: number) => number;
  alpha: (t: number) => number;
}

function appendGrid(spec: GridSpec, g: GridArrays): void {
  const cols = Math.max(2, Math.ceil((spec.halfX * 2) / WAVE_SEG));
  const base = g.pos.length / 3;
  // One normal for the whole grid: the plane's own, perpendicular to the row
  // direction (0, y1-y0, z1-z0) and the flow axis (1, 0, 0). The drawdown's
  // slope is gentle enough that the surface keeps the flat plane's normal.
  const n = new THREE.Vector3(0, spec.z1 - spec.z0, spec.y0(0) - spec.y1(0)).normalize();
  for (let r = 0; r <= spec.rows; r++) {
    const t = r / spec.rows;
    const z = spec.z0 + (spec.z1 - spec.z0) * t;
    for (let c = 0; c <= cols; c++) {
      const x = -spec.halfX + (c / cols) * spec.halfX * 2;
      const y = spec.y0(x) + (spec.y1(x) - spec.y0(x)) * t;
      channelVertex(g, x, y, z, [n.x, n.y, n.z], spec.wave(t), spec.lit(t), spec.alpha(t), spec.up);
    }
  }
  quadIndices(g.index, base, spec.rows, cols);
}

// An end cap: waterline to bed, back to front, at one end of the run, facing
// out along the flow axis. Without it a channel is an open box from any view
// but the game's own.
function appendCap(
  x: number,
  sign: number,
  yTop: number,
  halfY: number,
  frontZ: number,
  backZ: number,
  lit: (t: number) => number,
  alpha: (t: number) => number,
  g: GridArrays,
): void {
  const base = g.pos.length / 3;
  const cols = 4;
  for (let r = 0; r <= FRONT_ROWS; r++) {
    const t = r / FRONT_ROWS;
    const y = yTop + (-halfY - yTop) * t;
    for (let c = 0; c <= cols; c++) {
      const z = backZ + (frontZ - backZ) * (c / cols);
      channelVertex(g, x, y, z, [sign, 0, 0], 0, lit(t), alpha(t), 0);
    }
  }
  quadIndices(g.index, base, FRONT_ROWS, cols, sign > 0);
}

// The tube. `side` is the direction the water leaves in along x (the sign of
// the flow), `xEnd` the lip's x, `yTop` the drawn-down surface at the lip.
//
// Its cross-sections are VERTICAL SLICES, not planes perpendicular to the
// travel: every layer of the slab leaving the lip follows the same parabola
// from its own height, so a slice at time t is the lip's rectangle carried
// along the arc unturned. That is the physics - the perpendicular thickness
// then thins by exactly v0/v - and it is what keeps a thick slab from
// bulging under the lip, which a rigid ring turning with the tangent did:
// the slab's bottom swung out around a bend tighter than its own depth.
function appendFall(
  arc: FallArc,
  xEnd: number,
  side: number,
  v0: number,
  yTop: number,
  halfY: number,
  frontZ: number,
  backZ: number,
  lit: (t: number) => number,
  alpha: (t: number) => number,
  g: GridArrays,
): void {
  const base = g.pos.length / 3;
  const zMid = (frontZ + backZ) / 2;
  const halfW = (frontZ - backZ) / 2;
  // The slice: from the drawn-down surface to the bed, about its own centre.
  const yc0 = (yTop - halfY) / 2;
  const a = (yTop + halfY) / 2;
  const k = FALL_CORNER;
  const sgnPow = (v: number, e: number): number => Math.sign(v) * Math.abs(v) ** e;
  for (let i = 0; i <= FALL_STEPS; i++) {
    const f = i / FALL_STEPS;
    const t = arc.tEnd * f;
    const c = arc.centre(t);
    const v = arc.velocity(t);
    const speed = Math.hypot(v.x, v.y);
    // The top and bottom surfaces' outward normal: perpendicular to the
    // parabola here, pointing up-and-out.
    const upx = (-v.y / speed) * side;
    const upy = (v.x / speed) * side;
    const b = halfW * (1 - (1 - FALL_WIDTH_CONTRACT) * f);
    const round = Math.min(1, f / FALL_CORNER_BLEND);
    const w = round * round * (3 - 2 * round);
    for (let j = 0; j <= FALL_RING; j++) {
      const phi = (2 * Math.PI * j) / FALL_RING;
      const cs = Math.cos(phi);
      const sn = Math.sin(phi);
      // The rectangle's point on this ray, and the superellipse's; the slice
      // is the first at the lip and eases into the second.
      const m = Math.max(Math.abs(cs), Math.abs(sn));
      const rn = cs / m;
      const rz = sn / m;
      const sN = sgnPow(cs, 2 / k);
      const sZ = sgnPow(sn, 2 / k);
      const un = rn + (sN - rn) * w;
      const uz = rz + (sZ - rz) * w;
      g.pos.push(c.x, c.y + yc0 + a * un, zMid + b * uz);
      // Normals: the rectangle's face normal and the superellipse's
      // gradient in the slice, blended the same way; the vertical component
      // is then the parabola's own normal rather than straight up.
      const onTop = Math.abs(cs) >= Math.abs(sn);
      const rgn = onTop ? Math.sign(cs) : 0;
      const rgz = onTop ? 0 : Math.sign(sn);
      const sgn = (k * sgnPow(sN, k - 1)) / a ** k;
      const sgz = (k * sgnPow(sZ, k - 1)) / b ** k;
      const sl = Math.hypot(sgn, sgz) || 1;
      const gn = rgn + (sgn / sl - rgn) * w;
      const gz = rgz + (sgz / sl - rgz) * w;
      const gl = Math.hypot(gn, gz) || 1;
      g.nor.push((upx * gn) / gl, (upy * gn) / gl, gz / gl);
      // Which channel face this point of the slice continues: the top where
      // the ray points up, the front sheet everywhere else that shows,
      // blended over the corner. And its depth below the surface at the
      // lip, for the front sheet's murk and alpha there.
      const up = Math.max(0, Math.min(1, (cs - Math.abs(sn)) * 3 + 0.5));
      const below = (1 - rn) / 2;
      const lit0 = lit(below) + (1 - lit(below)) * up;
      const alpha0 = alpha(below) + (ALPHA_SURFACE - alpha(below)) * up;
      const ease = Math.min(1, f / FALL_BLEND_IN);
      const e = ease * ease * (3 - 2 * ease);
      g.wave.push(0);
      g.lit.push(lit0 + (1 - lit0) * e);
      g.alpha.push(alpha0 + (FALL_ALPHA - alpha0) * e);
      g.up.push(up);
      // The lip slice's point on this ray, frozen: the frame the texture is
      // painted in down the whole fall.
      g.frozen.push(xEnd, yc0 + a * rn, zMid + halfW * rz);
      g.arc.push(side * v0 * t);
      g.fall.push(f);
      g.fallOn.push(1);
    }
  }
  // Wound outward whichever way the water leaves: the sweep runs along
  // `side`, which mirrors the winding, so the first quad's face is checked
  // against the vertex normal it should agree with.
  const p = (i: number): THREE.Vector3 =>
    new THREE.Vector3(g.pos[3 * i]!, g.pos[3 * i + 1]!, g.pos[3 * i + 2]!);
  const a0 = base;
  const b0 = base + 1;
  const d0 = base + FALL_RING + 1;
  const face = p(d0).sub(p(a0)).cross(p(b0).sub(p(a0)));
  const n0 = new THREE.Vector3(g.nor[3 * a0]!, g.nor[3 * a0 + 1]!, g.nor[3 * a0 + 2]!);
  quadIndices(g.index, base, FALL_STEPS, FALL_RING, face.dot(n0) < 0);
}

interface WaterGeometry {
  geometry: THREE.BufferGeometry;
  // Where the fall meets the pool, in the body's frame, or null without one.
  impact: THREE.Vector3 | null;
}

function waterGeometry(
  halfX: number,
  halfY: number,
  frontZ: number,
  backZ: number,
  spill: { side: number; v0: number; drop: number } | null,
): WaterGeometry {
  const g: GridArrays = {
    pos: [], nor: [], wave: [], lit: [], alpha: [], up: [], frozen: [], arc: [], fall: [], fallOn: [], index: [],
  };
  // See FRONT_INSET: the water's front is a hair behind the slab's.
  frontZ -= FRONT_INSET;
  const depth = halfY * 2;
  const frontWave = (t: number): number => Math.max(0, 1 - (t * depth) / WAVE_FALLOFF) ** 2;
  const frontLit = (t: number): number => Math.max(0, 1 - (t * depth) / LIGHT_FALLOFF);
  const frontAlpha = (t: number): number =>
    ALPHA_FRONT_TOP + (ALPHA_FRONT_BED - ALPHA_FRONT_TOP) * t;
  // The surface: the waterline, drawing down into the brink before a lip.
  const surface = (x: number): number => {
    if (!spill) return halfY;
    const toLip = halfX - spill.side * x;
    const s = Math.max(0, Math.min(1, 1 - toLip / DRAWDOWN_REACH));
    return halfY * (1 - DRAWDOWN * (s * s * (3 - 2 * s)));
  };
  const bed = (): number => -halfY;

  // The top face: horizontal, AT the waterline, back of the scene to the
  // front of the slab. The camera sits above it, so perspective shows it as
  // a band whose height grows the further the water is below the view
  // centre - the same way every other slab's top face reads.
  appendGrid(
    {
      halfX,
      y0: surface,
      y1: surface,
      z0: backZ,
      z1: frontZ,
      rows: SURFACE_ROWS,
      up: 1,
      wave: () => 1,
      lit: () => 1,
      alpha: () => ALPHA_SURFACE,
    },
    g,
  );
  // The front face, waterline to bed. Its top row coincides with the top
  // face's front row - same position, same wave weight - so the waterline
  // cannot crack open between the two.
  appendGrid(
    {
      halfX,
      y0: surface,
      y1: bed,
      z0: frontZ,
      z1: frontZ,
      rows: FRONT_ROWS,
      up: 0,
      wave: frontWave,
      lit: frontLit,
      alpha: frontAlpha,
    },
    g,
  );
  let impact: THREE.Vector3 | null = null;
  const spillSide = spill ? spill.side : 0;
  if (spillSide <= 0) appendCap(halfX, 1, surface(halfX), halfY, frontZ, backZ, frontLit, frontAlpha, g);
  if (spillSide >= 0) appendCap(-halfX, -1, surface(-halfX), halfY, frontZ, backZ, frontLit, frontAlpha, g);
  if (spill) {
    const xEnd = spill.side * halfX;
    const arc = fallArc(xEnd, spill.side, spill.v0, halfY, spill.drop);
    appendFall(arc, xEnd, spill.side, spill.v0, surface(xEnd), halfY, frontZ, backZ, frontLit, frontAlpha, g);
    const tPool = Math.sqrt((2 * spill.drop) / FALL_GRAVITY);
    impact = new THREE.Vector3(arc.centre(tPool).x, halfY - spill.drop, (frontZ + backZ) / 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(g.nor, 3));
  geometry.setAttribute("aWave", new THREE.Float32BufferAttribute(g.wave, 1));
  geometry.setAttribute("aLit", new THREE.Float32BufferAttribute(g.lit, 1));
  geometry.setAttribute("aAlpha", new THREE.Float32BufferAttribute(g.alpha, 1));
  geometry.setAttribute("aUp", new THREE.Float32BufferAttribute(g.up, 1));
  geometry.setAttribute("aFrozen", new THREE.Float32BufferAttribute(g.frozen, 3));
  geometry.setAttribute("aArc", new THREE.Float32BufferAttribute(g.arc, 1));
  geometry.setAttribute("aFall", new THREE.Float32BufferAttribute(g.fall, 1));
  geometry.setAttribute("aFallOn", new THREE.Float32BufferAttribute(g.fallOn, 1));
  geometry.setIndex(g.index);
  return { geometry, impact };
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

// What shapes a water material, gathered from the body (physics: the flow) and
// its geometry object (appearance: everything else).
interface WaterLook {
  color: string | undefined;
  flow: number;
  // Half-length of the run along its local flow axis, for the pale band at
  // its two ends.
  halfX: number;
  // Dimensionless multiple over the stroke and ripple tiling, the same meaning
  // `tileScale` has on every other surface: 1 (and absent) is the tuned size,
  // 2 twice as large.
  tileScale: number;
  // Glow override: the geometry object's `emissive`/`emissiveIntensity`, when
  // authored, replace the default trace derived from the water's own colour.
  emissive: string | undefined;
  emissiveIntensity: number | undefined;
}

interface Palette {
  deep: THREE.Color;
  body: THREE.Color;
  light: THREE.Color;
  pale: THREE.Color;
}

// The ramp, all from the one authored colour: the same hue at four
// lightnesses (see the RAMP_ constants). The stops are taken and rebuilt in
// SRGB rather than the working space, because HSL is a statement about the
// colour as authored - the hex a level types - and the same lightness step
// taken in linear space lands somewhere else entirely.
function paletteOf(color: string | undefined): Palette {
  const tint = new THREE.Color(color ?? WATER_DEFAULT_COLOR);
  const hsl = { h: 0, s: 0, l: 0 };
  tint.getHSL(hsl, THREE.SRGBColorSpace);
  const stop = (s: number, l: number) =>
    new THREE.Color().setHSL(hsl.h, Math.min(hsl.s * s, 1), l, THREE.SRGBColorSpace);
  const lift = (t: number) => hsl.l + (1 - hsl.l) * t;
  return {
    deep: stop(RAMP_DEEP_S, hsl.l * RAMP_DEEP_L),
    body: tint.clone(),
    light: stop(RAMP_LIGHT_S, lift(RAMP_LIGHT_L)),
    pale: stop(RAMP_PALE_S, lift(RAMP_PALE_L)),
  };
}

// A MeshStandardMaterial rather than a raw ShaderMaterial, so the water is lit
// by the same lamps, environment and tone mapping as everything around it - the
// custom parts (tone, hairlines, waterline, the fall's ribbons and brow) are
// injected around the standard lighting rather than reimplementing it. The
// normal is left the surface's own: the sheen is a wash, not glints.
function waterMaterial(look: WaterLook): THREE.MeshStandardMaterial {
  const palette = paletteOf(look.color);
  const mat = new THREE.MeshStandardMaterial({
    color: palette.body,
    roughness: WATER_ROUGHNESS,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    // The channel's sheets are seen from either side in the editor's orbit;
    // the tube is closed and culls its own inside in the fragment shader.
    side: THREE.DoubleSide,
  });
  mat.envMapIntensity = WATER_ENV;

  const flip = ensureFlipbook();
  // Both loads start HERE, at material build, not inside onBeforeCompile:
  // that hook first runs at first render, which is after `assetsSettled` has
  // already been awaited - a load kicked off there is invisible to the settle
  // point and a headless grab photographs strokeless water.
  const foam = ensureFoam();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uFlip = { value: flip };
    shader.uniforms.uFlipReady = flipReady;
    shader.uniforms.uFlow = { value: look.flow };
    // Tiling as UNIFORMS rather than baked into the shader text: every water
    // material shares one program (see customProgramCacheKey), and a baked
    // constant would hand every body whichever tiling compiled first.
    shader.uniforms.uTileScale = { value: look.tileScale };
    shader.uniforms.uFoam = { value: foam };
    shader.uniforms.uFoamReady = foamReady;
    shader.uniforms.uHalfX = { value: look.halfX };
    shader.uniforms.uDeep = { value: palette.deep };
    shader.uniforms.uBody = { value: palette.body };
    shader.uniforms.uLight = { value: palette.light };
    shader.uniforms.uPale = { value: palette.pale };
    shader.uniforms.uWhite = { value: new THREE.Color(FALL_WHITE) };
    shader.uniforms.uGlowColor = {
      value: (look.emissive ? new THREE.Color(look.emissive) : palette.body.clone()).multiplyScalar(
        look.emissiveIntensity ?? GLOW_INTENSITY,
      ),
    };

    shader.vertexShader = `
      attribute float aWave;
      attribute float aLit;
      attribute float aAlpha;
      attribute float aUp;
      attribute vec3 aFrozen;
      attribute float aArc;
      attribute float aFall;
      attribute float aFallOn;
      uniform float uTime;
      uniform float uFlow;
      uniform float uHalfX;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vCrest;
      varying float vLocalX;
      varying float vFall;
      varying float vFallOn;
      varying vec2 vAlongAcross;
    ${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vLit = aLit;
      vAlpha = aAlpha;
      vUp = aUp;
      vLocalX = position.x;
      vFall = aFall;
      vFallOn = aFallOn;
      // Phase measured along the body's OWN flow axis in world space, so two
      // stretches of one channel share a continuous surface. Taken from the
      // FROZEN point - the vertex itself on the channel, the lip point a tube
      // vertex descends from - plus the metres travelled past the lip.
      vec4 wWp = modelMatrix * vec4(aFrozen, 1.0);
      vec2 wFlowAxis = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xy);
      float wAlong = dot(wWp.xy, wFlowAxis) + aArc;
      // The waves ride the current: their phase translates at the authored flow
      // speed, and each harmonic churns at its own rate on top. They die out
      // toward the run's ends, where a brink goes glassy - and where the fall's
      // flat first ring has to meet the surface exactly.
      float wPhase = wAlong - uFlow * uTime;
      float wWave = ${waveSumGlsl("wPhase", "wWp.z")};
      wWave = sign(wWave) * pow(abs(wWave), 0.75);
      float wTaper = smoothstep(0.0, ${fmt(WAVE_END_TAPER)}, uHalfX - abs(position.x));
      float wW = aWave * wTaper;
      vCrest = wWave * wW;
      float wDisp = wW * ${fmt(WAVE_HEIGHT)} * wWave;
      transformed.y += wDisp;
      wWp.y += wDisp;
      // Texture coordinates anchored to the WATER (they carry the displacement)
      // in world metres: plan frame on the surface, elevation frame on the
      // front sheet.
      float wAcross = mix(dot(wWp.xy, vec2(-wFlowAxis.y, wFlowAxis.x)), wWp.z, aUp);
      vAlongAcross = vec2(wAlong, wAcross);`,
    );

    shader.fragmentShader = `
      precision highp sampler2DArray;
      uniform sampler2DArray uFlip;
      uniform float uFlipReady;
      uniform float uTime;
      uniform float uFlow;
      uniform float uTileScale;
      uniform vec3 uGlowColor;
      uniform sampler2D uFoam;
      uniform float uFoamReady;
      uniform vec3 uDeep;
      uniform vec3 uBody;
      uniform vec3 uLight;
      uniform vec3 uPale;
      uniform vec3 uWhite;
      uniform float uHalfX;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vCrest;
      varying float vLocalX;
      varying float vFall;
      varying float vFallOn;
      varying vec2 vAlongAcross;
      // One crossfaded flipbook fetch: the two layers either side of the play
      // head, mixed, unpacked to a tangent-space normal.
      vec3 waterFlipNormal(vec2 uv) {
        float f = mod(uTime * ${fmt(FLIP_FPS * PAINT_RATE)}, ${fmt(FLIP_FRAMES)});
        float f0 = floor(f);
        float f1 = mod(f0 + 1.0, ${fmt(FLIP_FRAMES)});
        vec3 a = texture(uFlip, vec3(uv, f0)).xyz;
        vec3 b = texture(uFlip, vec3(uv, f1)).xyz;
        return mix(a, b, f - f0) * 2.0 - 1.0;
      }
      // The continuous ramp: deep below the middle of the tone field, light
      // above it, the body colour at the centre.
      vec3 toneRamp(float t) {
        t = clamp(t, 0.0, 1.0);
        return t < 0.5 ? mix(uDeep, uBody, t * 2.0) : mix(uBody, uLight, (t - 0.5) * 2.0);
      }
    ${shader.fragmentShader}`
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
      // The tube is closed: its inside is never water anyone should see.
      if (vFallOn > 0.5 && !gl_FrontFacing) discard;
      // How far into the fall's own look this pixel is: 0 at the lip and on
      // the channel, so the channel's tone carries straight over the brink.
      float wFb = smoothstep(0.0, ${fmt(FALL_BLEND_IN)}, vFall) * vFallOn;

      // ---- the moving fields ------------------------------------------
      // Two scales of the same animated water, drifting with the current at
      // different rates.
      vec2 wUvA = vec2(
        (vAlongAcross.x - uFlow * uTime * ${fmt(DRIFT_COARSE)}),
        vAlongAcross.y) / (${fmt(TILE_COARSE)} * uTileScale);
      vec2 wUvB = vec2(
        (vAlongAcross.x - uFlow * uTime * ${fmt(DRIFT_FINE)}),
        vAlongAcross.y) / (${fmt(TILE_FINE)} * uTileScale) + vec2(0.0, 0.37);
      vec3 wNa = waterFlipNormal(wUvA) * uFlipReady;
      vec3 wNb = waterFlipNormal(wUvB) * uFlipReady;
      // The strokes: the cellular web stretched along the flow, carried by
      // the current, churned by the ripples - and the finer sample that
      // breaks the hairlines along their length.
      vec2 wCarried = vec2(vAlongAcross.x - uFlow * uTime, vAlongAcross.y);
      float wStroke = texture(uFoam,
        wCarried / (vec2(${fmt(STROKE_STRETCH)}, 1.0) * ${fmt(STROKE_TILE)} * uTileScale)
          + wNa.xy * ${fmt(STROKE_DISTORT)}).r * uFoamReady;
      float wBreak = texture(uFoam,
        wCarried / (${fmt(STROKE_BREAK_TILE)} * uTileScale) + vec2(0.5, 0.41)
          + wNb.xy * 0.02).r * uFoamReady;

      // ---- the tone ----------------------------------------------------
      float wChurn = wNa.x * 0.7 + wNb.x * 0.5;
      float wTone = 0.5
        + ${fmt(TONE_CREST_W)} * vCrest
        + mix(${fmt(TONE_CHURN_W)}, ${fmt(FALL_CHURN_W)}, wFb) * wChurn
        + mix(${fmt(TONE_STROKE_W)}, ${fmt(FALL_RIBBON_W)}, wFb) * (wStroke - 0.4);
      vec3 wCol = toneRamp(wTone);
      // Hairline highlights: the strongest stroke edges, wisped; the fall's
      // ribbons are the same lines.
      float wLine = smoothstep(${fmt(LINE_LO)}, ${fmt(LINE_HI)}, wStroke * (0.55 + 0.7 * wBreak));
      wCol = mix(wCol, uPale, wLine * mix(${fmt(LINE_STRENGTH)}, ${fmt(FALL_LINE_STRENGTH)}, wFb));
      // Paler toward the run's ends, softly - and the fall is past an end.
      float wEndDist = mix(uHalfX - abs(vLocalX), 0.0, vFallOn);
      float wBank = 1.0 - smoothstep(0.0, ${fmt(BANK_REACH)}, wEndDist);
      wCol = mix(wCol, uLight, ${fmt(BANK_W)} * wBank);
      // The brow: a bump of light over the lip, zero at the lip itself.
      float wBrow = sin(3.14159 * clamp(vFall / ${fmt(FALL_BROW)}, 0.0, 1.0)) * vFallOn;
      wCol = mix(wCol, uLight, ${fmt(FALL_BROW_W)} * wBrow);
      // The front sheet: a soft pale waterline, then down into the deep. On
      // the tube both carry over the lip and ease out with the fall's blend.
      float wBelow = (1.0 - vLit) * ${fmt(LIGHT_FALLOFF)};
      float wFront = (1.0 - vUp) * (1.0 - wFb);
      wCol = mix(wCol, uDeep, wFront * ${fmt(FRONT_DEEP_W)} * smoothstep(0.0, ${fmt(LIGHT_FALLOFF)}, wBelow));
      wCol = mix(wCol, uPale, wFront * ${fmt(WATERLINE_W)} * (1.0 - smoothstep(0.0, ${fmt(WATERLINE_WIDTH)}, wBelow)));
      // The base dissolves into white, into the cloud below it.
      float wWhite = smoothstep(${fmt(FALL_WHITE_FROM)}, 1.0, vFall) * vFallOn;
      wCol = mix(wCol, uWhite, wWhite);
      diffuseColor.rgb = wCol;
      diffuseColor.a = mix(vAlpha, ${fmt(FALL_ALPHA_WHITE)}, wWhite);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
      // A trace of glow so an unlit stretch is not a black hole; white water
      // is bright in any light.
      totalEmissiveRadiance += uGlowColor * vLit;
      totalEmissiveRadiance += uWhite * wWhite * 0.04;`,
      );
  };
  // Different flows compile different uniforms but share the program cache key
  // unless told apart.
  mat.customProgramCacheKey = () => "water";
  return mat;
}

// ---------------------------------------------------------------------------
// Spray
// ---------------------------------------------------------------------------

// The fall's spray - mist, splash and sparkle - as one point cloud whose every
// particle is a pure function of the clock and its own seed: no CPU update,
// nothing to reset, and a pinned clock draws the same spray twice. In the
// channel's frame: +y is up.
interface SprayShape {
  // The arc, so sparkles can ride the sheet.
  xEnd: number;
  side: number;
  v0: number;
  tEnd: number;
  // The lip's vertical slice: its centre y and half-height (the drawn-down
  // surface to the bed), which every slice down the arc carries unturned.
  sliceY0: number;
  sliceHalf: number;
  halfW: number;
  zMid: number;
  // Where the arc meets the pool.
  impact: THREE.Vector3;
}

function sprayPoints(
  shape: SprayShape,
  color: THREE.Color,
): { points: THREE.Points; geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } {
  const pos: number[] = [];
  const seed: number[] = [];
  const kind: number[] = [];
  // A fixed pseudo-random sequence, so the cloud is the same every build.
  let s = 1234567;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < SPRAY_COUNT; i++) {
    const k = i % SPRAY_SPARKLE_EVERY === 0 ? 2 : i % SPRAY_SPLASH_EVERY === 0 ? 1 : 0;
    // Mist and splash are born around the impact; a sparkle's position is
    // computed on the arc from its seed, so its stored position is unused.
    pos.push(
      shape.impact.x + (rnd() - 0.5) * MIST_SPREAD_ACROSS * (k === 0 ? 2 : 0.5),
      shape.impact.y + rnd() * MIST_SPREAD_UP,
      shape.impact.z + (rnd() - 0.5) * shape.halfW * 2,
    );
    seed.push(rnd(), rnd(), rnd(), rnd());
    kind.push(k);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 4));
  geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
  geometry.boundingSphere = new THREE.Sphere(shape.impact.clone(), 6);

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: waterTime,
        uViewHalfHeight: waterViewHalfHeight,
        uColor: { value: color },
        uXEnd: { value: shape.xEnd },
        uSide: { value: shape.side },
        uV0: { value: shape.v0 },
        uTEnd: { value: shape.tEnd },
        uSliceY0: { value: shape.sliceY0 },
        uSliceHalf: { value: shape.sliceHalf },
        uHalfW: { value: shape.halfW },
        uZMid: { value: shape.zMid },
      },
    ]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform float uViewHalfHeight;
      uniform float uXEnd;
      uniform float uSide;
      uniform float uV0;
      uniform float uTEnd;
      uniform float uSliceY0;
      uniform float uSliceHalf;
      uniform float uHalfW;
      uniform float uZMid;
      attribute vec4 aSeed;
      attribute float aKind;
      varying float vFade;
      varying float vKind;
      void main() {
        float isSplash = step(0.5, aKind) * (1.0 - step(1.5, aKind));
        float isSparkle = step(1.5, aKind);
        float isMist = 1.0 - isSplash - isSparkle;
        float life = isMist * mix(${fmt(MIST_LIFE[0]!)}, ${fmt(MIST_LIFE[1]!)}, aSeed.w)
          + isSplash * mix(${fmt(SPLASH_LIFE[0]!)}, ${fmt(SPLASH_LIFE[1]!)}, aSeed.w)
          + isSparkle * uTEnd;
        float ph = fract(uTime / life + aSeed.x);
        float tau = ph * life;
        // Mist drifts up and out; splash is thrown up and falls back; a
        // sparkle rides the arc on the sheet's front face.
        vec3 p = position;
        vec3 vel = isMist * vec3((aSeed.y - 0.5) * ${fmt(MIST_DRIFT)}, ${fmt(MIST_RISE)}, (aSeed.z - 0.5) * ${fmt(MIST_DRIFT)})
          + isSplash * vec3((aSeed.z - 0.5) * ${fmt(SPLASH_OUT * 2)},
              mix(${fmt(SPLASH_UP[0]!)}, ${fmt(SPLASH_UP[1]!)}, aSeed.y), (aSeed.x - 0.5) * ${fmt(SPLASH_OUT)});
        p += vel * tau;
        p.y -= 0.5 * ${fmt(FALL_GRAVITY)} * tau * tau * isSplash;
        if (isSparkle > 0.5) {
          float b = uHalfW * (1.0 - ${fmt(1 - FALL_WIDTH_CONTRACT)} * ph);
          // Up the lip's slice, carried along the arc unturned like every
          // slice of the sheet, and the front face's z there (the
          // superellipse solved for z), a hair proud of it.
          float n = (aSeed.y - 0.5) * 1.6;
          float zf = b * pow(max(1.0 - pow(abs(n), ${fmt(FALL_CORNER)}), 0.0), ${fmt(1 / FALL_CORNER)});
          vec2 c = vec2(uXEnd + uSide * uV0 * tau, -0.5 * ${fmt(FALL_GRAVITY)} * tau * tau);
          p = vec3(c.x, c.y + uSliceY0 + n * uSliceHalf, uZMid + zf + 0.01);
        }
        vFade = sin(ph * 3.14159) * (isMist + isSplash) + isSparkle * sin(fract(ph * 3.0 + aSeed.z) * 3.14159);
        vKind = aKind;
        float size = isMist * mix(${fmt(MIST_SIZE[0]!)}, ${fmt(MIST_SIZE[1]!)}, aSeed.z) * (0.5 + ph)
          + isSplash * mix(${fmt(SPLASH_SIZE[0]!)}, ${fmt(SPLASH_SIZE[1]!)}, aSeed.z)
          + isSparkle * mix(${fmt(SPARKLE_SIZE[0]!)}, ${fmt(SPARKLE_SIZE[1]!)}, aSeed.z);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = size * projectionMatrix[1][1] * uViewHalfHeight / -mvPosition.z;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uColor;
      varying float vFade;
      varying float vKind;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float isMist = 1.0 - step(0.5, vKind);
        // Mist is a soft airbrushed puff; droplets and sparkles are small
        // soft-edged dots.
        float soft = mix(smoothstep(0.5, 0.25, d), smoothstep(0.5, 0.18, d), isMist);
        float alpha = isMist * ${fmt(MIST_ALPHA)}
          + step(0.5, vKind) * (1.0 - step(1.5, vKind)) * ${fmt(SPLASH_ALPHA)}
          + step(1.5, vKind) * ${fmt(SPARKLE_ALPHA)};
        float a = soft * vFade * alpha;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 11;
  return { points, geometry, material };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WaterBuild {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

// Build a water body's look under `root` (the BodyVisual's group, which carries
// the body's pose). Rects only - every authored water body is one, and the 2D
// overlay's streak glyphs remain the fallback for anything else.
//
// Water is a visual effect, so its RENDER controls live on the body's geometry
// object like every other look in the format - `z`/`depth` place the slab
// through z, `color` overrides the tint, `tileScale` scales the strokes,
// `emissive`/`emissiveIntensity` override the glow - while the physics (flow,
// drag) stays on the body, and so does the SPILL (`data.spill`, the drop off
// the downstream end, and `spillSpeed`, the lip speed): where the current goes
// is a fact about the current. The fields a geometry object aims at
// extrusions (`kind`, `mesh`, `texture`, `bevel`) mean nothing here and are
// ignored: water is the one body whose look is not a surface worn over an
// outline.
export function buildWater(
  root: THREE.Group,
  body: WaterArea,
  data: LevelBodyData,
  visual: GeometryObjectData | undefined,
): WaterBuild {
  const shape = body.primaryShape();
  const s = shape.shape;
  if (s.kind !== "circle" && s.kind !== "rect") return { geometries: [], materials: [] };
  const halfX = s.kind === "rect" ? s.size.x / 2 : s.radius;
  const halfY = s.kind === "rect" ? s.size.y / 2 : s.radius;
  // The slab through z, in the extruder's convention: depth centred on the
  // plane, shifted by `z`.
  const depth = visual?.depth ?? DEFAULT_WATER_DEPTH;
  const frontZ = (visual?.z ?? 0) + depth / 2;
  const backZ = frontZ - depth;
  // The spill: off the end the flow points at, at the flow's own speed unless
  // told otherwise. A run with no current spills off its +x end.
  const drop = data.spill ?? 0;
  const spill =
    drop > 0
      ? {
          side: body.flow < 0 ? -1 : 1,
          v0: Math.max(data.spillSpeed ?? Math.abs(body.flow), 0.3),
          drop,
        }
      : null;
  const look: WaterLook = {
    color: visual?.color ?? body.fillColor ?? undefined,
    flow: body.flow,
    halfX,
    tileScale: visual?.tileScale ?? 1,
    emissive: visual?.emissive,
    emissiveIntensity: visual?.emissiveIntensity,
  };
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const built = waterGeometry(halfX, halfY, frontZ, backZ, spill);
  const mat = waterMaterial(look);
  const mesh = new THREE.Mesh(built.geometry, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Transparent, so drawn after the opaque scene; the high renderOrder keeps
  // it after other transparent scenery it might share pixels with.
  mesh.renderOrder = 10;
  root.add(mesh);
  geometries.push(built.geometry);
  materials.push(mat);

  if (spill && built.impact) {
    const xEnd = spill.side * halfX;
    const arc = fallArc(xEnd, spill.side, spill.v0, halfY, spill.drop);
    const spray = sprayPoints(
      {
        xEnd,
        side: spill.side,
        v0: spill.v0,
        tEnd: arc.tEnd,
        // The lip's slice runs from the drawn-down surface to the bed.
        sliceY0: (halfY * (1 - DRAWDOWN) - halfY) / 2,
        sliceHalf: (halfY * (1 - DRAWDOWN) + halfY) / 2,
        halfW: (frontZ - backZ) / 2,
        zMid: (frontZ + backZ) / 2,
        impact: built.impact,
      },
      new THREE.Color(FALL_WHITE),
    );
    root.add(spray.points);
    geometries.push(spray.geometry);
    materials.push(spray.material);
  }
  return { geometries, materials };
}
