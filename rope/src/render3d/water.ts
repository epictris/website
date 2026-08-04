// Flowing sewer water, drawn from a captured animated normal-map sequence.
//
// The look is built around one asset: a 60-layer flipbook of tangent-space
// normal maps (a looping capture of real choppy water), played by crossfading
// consecutive layers and scrolled along the flow. Two samples at different
// scales and rates are blended per pixel, so the surface has structure at two
// sizes that never settles into a repeating pattern. Everything else - foam,
// murk, glow - is derived from those same samples, which keeps the whole
// surface moving as one body of water rather than as stacked effects.
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
// The flipbook is deliberately NOT in the release asset store yet: it lives at
// `public/water/` (outside the store's sweep) until its provenance is settled
// and it is published like every other asset.

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import type { GeometryObjectData } from "../level/levelFormat";
import { trackPending } from "./assets";

// ---------------------------------------------------------------------------
// The flipbook
// ---------------------------------------------------------------------------

const FLIP_URL = "/water/water-normal-flip.webp";
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
    void trackPending(loadFlipbook(tex)).catch(() => {
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
  const image = await new THREE.ImageLoader().loadAsync(FLIP_URL);
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
const FOAM_URL = "/water/water-foam.webp";
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
    new THREE.ImageLoader().loadAsync(FOAM_URL).then((image) => {
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

export function updateWater(seconds: number): void {
  waterTime.value = seconds;
}

// ---------------------------------------------------------------------------
// The look
// ---------------------------------------------------------------------------

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
// How far below the waterline the front sheet keeps waving before it hangs
// still, and how far down the murk swallows the light.
const WAVE_FALLOFF = 0.22;
const LIGHT_FALLOFF = 0.5;
const DEPTH_FADE = 0.3;
// The two normal-map layers: metres per repeat, and how fast each pattern
// drifts as a fraction of the authored current. Under 1 on purpose - surface
// texture visibly lags the water carrying it, and at the current's full speed a
// scrolling pattern starts strobing.
const TILE_COARSE = 2.4;
const TILE_FINE = 0.95;
const DRIFT_COARSE = 0.55;
const DRIFT_FINE = 0.8;
// Foam: where the two layers' combined steepness crosses the cut, the surface
// is torn white. The product of two independent fields is what makes the foam
// sparse ribbons rather than an even mottle.
// Surface foam. The baked mask is sampled twice - different tiles, different
// drift rates - and each sample's UVs are distorted by the flipbook normals,
// so the foam churns with the water carrying it instead of sliding past as a
// printed sheet. Where it appears is the PLACEMENT mask: a base coverage dial,
// denser on wave crests, and collecting against the channel's ends.
const FOAM_TILE_A = 2.6;
const FOAM_TILE_B = 1.35;
const FOAM_DRIFT_A = 0.9;
const FOAM_DRIFT_B = 1.15;
const FOAM_DISTORT_A = 0.05;
const FOAM_DISTORT_B = 0.07;
// Coverage weights feeding the threshold. PLACEMENT COMES FROM THE VISIBLE
// SURFACE: the wave crests the silhouette shows and the steep patches of the
// very flipbook samples the lighting shades by - so foam sits on the agitation
// the player can see, and the baked mask only textures its interior. A large
// independent base coverage is what reads as random white patches.
// The web is PERSISTENT: base coverage keeps it visible everywhere it drifts,
// and the surface's agitation (crests, ripple steepness) only thickens and
// brightens the lacing. Gating placement on the fast-changing flipbook is what
// made foam flash in and out of existence.
const FOAM_BASE = 0.45;
const FOAM_CREST_W = 0.3;
const FOAM_STEEP_W = 0.35;
const FOAM_BANK_W = 0.5;
// How far from a channel end the bank foam reaches, in metres.
const FOAM_BANK_REACH = 0.75;
const FOAM_CUT = 0.45;
const FOAM_SOFT = 0.3;
const FOAM_COLOR = "#dce2d8";

// The murk itself, and the faint self-glow that keeps unlit stretches of
// channel readable (a trace, not the look - lamps light the water).
const WATER_DEEP = "#0d120c";
const GLOW_INTENSITY = 0.14;

// Alpha: the surface is nearly solid, the front sheet is murky glass so the
// submerged ball stays a visible silhouette (an opaque front is better water
// and worse gameplay).
const ALPHA_SURFACE = 0.97;
const ALPHA_FRONT_TOP = 0.94;
const ALPHA_FRONT_BED = 0.8;

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

// Both grids in one BufferGeometry, in the body's local frame (three's y-up):
// the raked surface strip, and the front sheet hanging from its front edge down
// to the bed. They share the front-edge vertices' displacement (same aWave, same
// x sampling), so the waterline cannot crack open between them.
//
// Attributes beyond position/normal:
//   aWave  - how much of the wave displacement this vertex takes (1 at the
//            waterline, fading down the front sheet)
//   aLit   - how far the light gets: 1 at the surface, ~0 at the bed
//   aAlpha - opacity
//   aUp    - 1 on the surface (plan-view texture frame), 0 on the front sheet
//            (elevation frame). The two faces need different "across"
//            coordinates or every feature smears into bars (see the removed
//            renderer's notes).
interface GridSpec {
  halfX: number;
  y0: number; // top edge y
  y1: number; // bottom edge y
  z0: number; // top edge z
  z1: number; // bottom edge z
  rows: number;
  up: number;
  wave: (t: number) => number; // t: 0 at top edge, 1 at bottom
  lit: (t: number) => number;
  alpha: (t: number) => number;
}

function appendGrid(
  spec: GridSpec,
  pos: number[],
  nor: number[],
  wave: number[],
  lit: number[],
  alpha: number[],
  up: number[],
  index: number[],
): void {
  const cols = Math.max(2, Math.ceil((spec.halfX * 2) / WAVE_SEG));
  const base = pos.length / 3;
  // One normal for the whole grid: the plane's own, perpendicular to the row
  // direction (0, y1-y0, z1-z0) and the flow axis (1, 0, 0). The flipbook
  // perturbs it per pixel, which is where all the real shape lives.
  const n = new THREE.Vector3(0, spec.z1 - spec.z0, spec.y0 - spec.y1).normalize();
  for (let r = 0; r <= spec.rows; r++) {
    const t = r / spec.rows;
    const y = spec.y0 + (spec.y1 - spec.y0) * t;
    const z = spec.z0 + (spec.z1 - spec.z0) * t;
    for (let c = 0; c <= cols; c++) {
      const x = -spec.halfX + (c / cols) * spec.halfX * 2;
      pos.push(x, y, z);
      nor.push(n.x, n.y, n.z);
      wave.push(spec.wave(t));
      lit.push(spec.lit(t));
      alpha.push(spec.alpha(t));
      up.push(spec.up);
    }
  }
  const stride = cols + 1;
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = base + r * stride + c;
      const b = a + 1;
      const d = a + stride;
      const e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
}

function waterGeometry(
  halfX: number,
  halfY: number,
  horizontal: boolean,
  frontZ: number,
  backZ: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const wave: number[] = [];
  const lit: number[] = [];
  const alpha: number[] = [];
  const up: number[] = [];
  const index: number[] = [];

  if (horizontal) {
    // The top face: horizontal, AT the waterline, back of the scene to the
    // front of the slab. The camera sits above it, so perspective shows it as
    // a band whose height grows the further the water is below the view
    // centre - the same way every other slab's top face reads.
    appendGrid(
      {
        halfX,
        y0: halfY,
        y1: halfY,
        z0: backZ,
        z1: frontZ,
        rows: SURFACE_ROWS,
        up: 1,
        wave: () => 1,
        lit: () => 1,
        alpha: () => ALPHA_SURFACE,
      },
      pos, nor, wave, lit, alpha, up, index,
    );
    // The front face, waterline to bed. Its top row coincides with the top
    // face's front row - same position, same wave weight - so the waterline
    // cannot crack open between the two.
    const depth = halfY * 2;
    appendGrid(
      {
        halfX,
        y0: halfY,
        y1: -halfY,
        z0: frontZ,
        z1: frontZ,
        rows: FRONT_ROWS,
        up: 0,
        wave: (t) => Math.max(0, 1 - (t * depth) / WAVE_FALLOFF) ** 2,
        lit: (t) => Math.max(0, 1 - (t * depth) / LIGHT_FALLOFF),
        alpha: (t) => ALPHA_FRONT_TOP + (ALPHA_FRONT_BED - ALPHA_FRONT_TOP) * t,
      },
      pos, nor, wave, lit, alpha, up, index,
    );
  } else {
    // A vertical run (the outfall): one sheet, no waterline to rake. The
    // flipbook streaming along local +X is the whole look.
    appendGrid(
      {
        halfX,
        y0: halfY,
        y1: -halfY,
        z0: frontZ,
        z1: frontZ,
        rows: FRONT_ROWS,
        up: 0,
        wave: () => 0,
        lit: () => 1,
        alpha: () => ALPHA_FRONT_TOP,
      },
      pos, nor, wave, lit, alpha, up, index,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("aWave", new THREE.Float32BufferAttribute(wave, 1));
  geo.setAttribute("aLit", new THREE.Float32BufferAttribute(lit, 1));
  geo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alpha, 1));
  geo.setAttribute("aUp", new THREE.Float32BufferAttribute(up, 1));
  geo.setIndex(index);
  return geo;
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

// What shapes a water material, gathered from the body (physics: the flow) and
// its geometry object (appearance: everything else).
interface WaterLook {
  color: string | undefined;
  flow: number;
  // Half-length of the run along its local flow axis, for the bank-foam band
  // at its two ends.
  halfX: number;
  // Dimensionless multiple over the ripple tiling, the same meaning `tileScale`
  // has on every other surface: 1 (and absent) is the tuned size, 2 twice as
  // large.
  tileScale: number;
  // Glow override: the geometry object's `emissive`/`emissiveIntensity`, when
  // authored, replace the default trace derived from the water's own colour.
  emissive: string | undefined;
  emissiveIntensity: number | undefined;
}

// A MeshStandardMaterial rather than a raw ShaderMaterial, so the water is lit
// by the same lamps, environment and tone mapping as everything around it - the
// custom parts (flipbook normals, waves, foam, murk) are injected around the
// standard lighting rather than reimplementing it.
function waterMaterial(look: WaterLook): THREE.MeshStandardMaterial {
  const tint = new THREE.Color(look.color ?? "#3d6b52");
  // The authored colour is a flat-renderer fill; the water's body is that hue
  // pulled far down toward murk, because foam only reads bright on dark water.
  const deep = new THREE.Color(WATER_DEEP);
  tint.lerp(deep, 0.82);

  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.16,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  mat.envMapIntensity = 0.55;

  const flip = ensureFlipbook();
  // Both loads start HERE, at material build, not inside onBeforeCompile:
  // that hook first runs at first render, which is after `assetsSettled` has
  // already been awaited - a load kicked off there is invisible to the settle
  // point and a headless grab photographs foamless water.
  const foam = ensureFoam();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uFlip = { value: flip };
    shader.uniforms.uFlipReady = flipReady;
    shader.uniforms.uFlow = { value: look.flow };
    // Tiling as UNIFORMS rather than baked into the shader text: every water
    // material shares one program (see customProgramCacheKey), and a baked
    // constant would hand every body whichever tiling compiled first.
    shader.uniforms.uTileCoarse = { value: TILE_COARSE * look.tileScale };
    shader.uniforms.uTileFine = { value: TILE_FINE * look.tileScale };
    shader.uniforms.uFoam = { value: foam };
    shader.uniforms.uFoamReady = foamReady;
    shader.uniforms.uFoamColor = { value: new THREE.Color(FOAM_COLOR) };
    shader.uniforms.uHalfX = { value: look.halfX };
    shader.uniforms.uGlowColor = {
      value: new THREE.Color(look.emissive ?? look.color ?? "#3d6b52").multiplyScalar(
        look.emissiveIntensity ?? GLOW_INTENSITY,
      ),
    };

    shader.vertexShader = `
      attribute float aWave;
      attribute float aLit;
      attribute float aAlpha;
      attribute float aUp;
      uniform float uTime;
      uniform float uFlow;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vCrest;
      varying float vWaveW;
      varying float vLocalX;
      varying vec2 vAlongAcross;
      varying vec3 vTanV;
      varying vec3 vBitanV;
    ${shader.vertexShader}`
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
      // Tangent frame for the flipbook: u runs along the body's local +X (the
      // flow axis), v along the grid's own "across" direction. Constant per
      // face, which is exact for these planes.
      vTanV = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
      vBitanV = normalize(cross(vTanV, normalize(normalMatrix * objectNormal)));`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
      vLit = aLit;
      vAlpha = aAlpha;
      vUp = aUp;
      vWaveW = aWave;
      vLocalX = position.x;
      // Phase measured along the body's OWN flow axis in world space, so two
      // stretches of one channel share a continuous surface and a rotated run
      // (the outfall) streams down itself rather than across.
      vec4 wWp = modelMatrix * vec4(transformed, 1.0);
      vec2 wFlowAxis = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xy);
      float wAlong = dot(wWp.xy, wFlowAxis);
      // The waves ride the current: their phase translates at the authored flow
      // speed, and each harmonic churns at its own rate on top.
      float wPhase = wAlong - uFlow * uTime;
      // The across coordinate is the UNDISPLACED z, shared by both faces: the
      // front sheet sits at the same z as the top face's front row, so the
      // waterline seam stays watertight by construction.
      float wWave = ${waveSumGlsl("wPhase", "wWp.z")};
      wWave = sign(wWave) * pow(abs(wWave), 0.75);
      vCrest = wWave * aWave;
      float wDisp = aWave * ${fmt(WAVE_HEIGHT)} * wWave;
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
      uniform float uTileCoarse;
      uniform float uTileFine;
      uniform vec3 uGlowColor;
      uniform sampler2D uFoam;
      uniform float uFoamReady;
      uniform vec3 uFoamColor;
      uniform float uHalfX;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vCrest;
      varying float vWaveW;
      varying float vLocalX;
      varying vec2 vAlongAcross;
      varying vec3 vTanV;
      varying vec3 vBitanV;

      // One crossfaded flipbook fetch: the two layers either side of the play
      // head, mixed, unpacked to a tangent-space normal.
      vec3 waterFlipNormal(vec2 uv) {
        float f = mod(uTime * ${fmt(FLIP_FPS)}, ${fmt(FLIP_FRAMES)});
        float f0 = floor(f);
        float f1 = mod(f0 + 1.0, ${fmt(FLIP_FRAMES)});
        vec3 a = texture(uFlip, vec3(uv, f0)).xyz;
        vec3 b = texture(uFlip, vec3(uv, f1)).xyz;
        return mix(a, b, f - f0) * 2.0 - 1.0;
      }
    ${shader.fragmentShader}`
      .replace(
        "#include <normal_fragment_maps>",
        `
      // Perturb by the flipbook layers sampled in <color_fragment> above (that
      // include runs earlier in the assembled shader, so the samples are
      // declared there and every later stage shares them).
      vec3 wMapN = normalize(vec3(wNa.xy + wNb.xy * 0.75, wNa.z * wNb.z));
      wMapN = mix(vec3(0.0, 0.0, 1.0), wMapN, uFlipReady);
      // THE FOAM BLANKET FLATTENS THE RIPPLES UNDER IT. Without this the
      // water's specular glints continue straight through the foam and it
      // reads as extra shine on the same surface; matte, ripple-free patches
      // against glinting water is what reads as a different substance ON it.
      wMapN.xy *= 1.0 - 0.85 * wFoam;
      wMapN = normalize(wMapN);
      normal = normalize(
        vTanV * wMapN.x + vBitanV * wMapN.y + normal * wMapN.z);`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
      // Two scales of the same animated water, drifting with the current at
      // different rates. Sampled here - the earliest of the stages that need
      // them - and used again for the normal perturbation and the emissive
      // shimmer below.
      vec2 wUvA = vec2(
        (vAlongAcross.x - uFlow * uTime * ${fmt(DRIFT_COARSE)}) / uTileCoarse,
        vAlongAcross.y / uTileCoarse);
      vec2 wUvB = vec2(
        (vAlongAcross.x - uFlow * uTime * ${fmt(DRIFT_FINE)}) / uTileFine,
        vAlongAcross.y / uTileFine + 0.37);
      vec3 wNa = waterFlipNormal(wUvA);
      vec3 wNb = waterFlipNormal(wUvB);
      // The murk: darker with depth down the front sheet, so the one face the
      // player mostly sees is a gradient into the water rather than a flat bar.
      diffuseColor.rgb *= mix(${fmt(DEPTH_FADE)}, 1.0, vLit);
      // SURFACE FOAM, from the baked mask - and on the surface only (vUp):
      // foam floats, and painted down the cross-section it reads as noise on a
      // wall. Two samples at different tiles and drift rates, each with its
      // UVs distorted by the flipbook normals so the foam churns with the
      // water carrying it rather than sliding past as a printed sheet.
      vec2 wFoamBaseA = vec2(
        vAlongAcross.x - uFlow * uTime * ${fmt(FOAM_DRIFT_A)}, vAlongAcross.y);
      vec2 wFoamBaseB = vec2(
        vAlongAcross.x - uFlow * uTime * ${fmt(FOAM_DRIFT_B)}, vAlongAcross.y);
      float wFa = texture(uFoam,
        wFoamBaseA / ${fmt(FOAM_TILE_A)} + wNa.xy * ${fmt(FOAM_DISTORT_A)}).r;
      float wFb = texture(uFoam,
        wFoamBaseB / ${fmt(FOAM_TILE_B)} + vec2(0.5, 0.41) + wNb.xy * ${fmt(FOAM_DISTORT_B)}).r;
      float wFoamTex = max(wFa, wFb * 0.85);
      // WHERE foam sits - on the water the player can SEE being agitated:
      // the travelling wave crests (the silhouette's own displacement) and the
      // steep patches of the exact samples the lighting shades the ripples by,
      // plus a band collecting against the run's two ends. The baked mask then
      // only breaks up the interior of those regions; it never places foam on
      // calm water by itself.
      float wSteep = length(wNa.xy) * 1.4 + length(wNb.xy) * 0.5;
      float wAgit = smoothstep(0.3, 0.75, wSteep);
      float wBank = 1.0 - smoothstep(0.0, ${fmt(FOAM_BANK_REACH)}, uHalfX - abs(vLocalX));
      float wCover = ${fmt(FOAM_BASE)}
        + ${fmt(FOAM_CREST_W)} * clamp(vCrest, 0.0, 1.0)
        + ${fmt(FOAM_STEEP_W)} * wAgit
        + ${fmt(FOAM_BANK_W)} * wBank;
      // NEAR-BINARY edge: foam is a material boundary, not a gradient - a soft
      // shoulder reads as a specular highlight on the same surface. The ragged
      // silhouette comes from the mask's own detail crossing the hard cut.
      float wFoamV = wCover * (0.3 + 0.9 * wFoamTex);
      float wFoam = smoothstep(${fmt(FOAM_CUT)}, ${fmt(FOAM_CUT + 0.09)}, wFoamV)
        * vUp * uFoamReady;
      // Matte white with bubbly internal variation from the mask, never flat.
      vec3 wFoamCol = uFoamColor * (0.72 + 0.28 * wFa);
      diffuseColor.rgb = mix(diffuseColor.rgb, wFoamCol, wFoam);
      // A thin darker contact rim just OUTSIDE the foam edge - the blanket
      // shading the water it sits on - which is what visually lifts it ON TOP
      // of the surface instead of into it.
      float wRim = smoothstep(${fmt(FOAM_CUT - 0.12)}, ${fmt(FOAM_CUT)}, wFoamV)
        - smoothstep(${fmt(FOAM_CUT)}, ${fmt(FOAM_CUT + 0.09)}, wFoamV);
      diffuseColor.rgb *= 1.0 - 0.3 * wRim * vUp * uFoamReady;
      // Foam is churned air: not glassy and not transparent.
      diffuseColor.a = vAlpha + (1.0 - vAlpha) * wFoam;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.95, wFoam);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
      // A trace of glow so an unlit stretch is not a black hole, modulated by
      // the animation's own churn so it shimmers as the water moves; the foam
      // carries a whisper of its own so it stays legible in the dark.
      float wChurn = length(wNa.xy) * length(wNb.xy) * 4.0;
      totalEmissiveRadiance += uGlowColor * (0.4 + 0.6 * wChurn) * vLit;
      // A whisper only: emission is glow, and glow is the "extra shiny"
      // misread - the matte albedo under the lamps is what carries the foam.
      totalEmissiveRadiance += uFoamColor * wFoam * 0.07;`,
      );
  };
  // Different flows compile different uniforms but share the program cache key
  // unless told apart.
  mat.customProgramCacheKey = () => "water-flipbook";
  return mat;
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
// through z, `color` overrides the tint, `tileScale` scales the ripples,
// `emissive`/`emissiveIntensity` override the glow - while the physics (flow,
// drag) stays on the body. The fields a geometry object aims at extrusions
// (`kind`, `mesh`, `texture`, `bevel`) mean nothing here and are ignored:
// water is the one body whose look is not a surface worn over an outline.
export function buildWater(
  root: THREE.Group,
  body: WaterArea,
  visual: GeometryObjectData | undefined,
): WaterBuild {
  const shape = body.primaryShape();
  const s = shape.shape;
  if (s.kind !== "circle" && s.kind !== "rect") return { geometries: [], materials: [] };
  const halfX = s.kind === "rect" ? s.size.x / 2 : s.radius;
  const halfY = s.kind === "rect" ? s.size.y / 2 : s.radius;
  // A run is "horizontal" when its flow axis lies along the world x axis; only
  // then does the waterline slab-with-top-face form mean anything.
  const horizontal = Math.abs(Math.sin(body.globalRotation)) < 0.05;
  // The slab through z, in the extruder's convention: depth centred on the
  // plane, shifted by `z`.
  const depth = visual?.depth ?? DEFAULT_WATER_DEPTH;
  const frontZ = (visual?.z ?? 0) + depth / 2;
  const backZ = frontZ - depth;
  const geo = waterGeometry(halfX, halfY, horizontal, frontZ, backZ);
  const mat = waterMaterial({
    color: visual?.color ?? body.fillColor ?? undefined,
    flow: body.flow,
    halfX,
    tileScale: visual?.tileScale ?? 1,
    emissive: visual?.emissive,
    emissiveIntensity: visual?.emissiveIntensity,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Transparent, so drawn after the opaque scene; the high renderOrder keeps it
  // after other transparent scenery it might share pixels with.
  mesh.renderOrder = 10;
  root.add(mesh);
  return { geometries: [geo], materials: [mat] };
}
