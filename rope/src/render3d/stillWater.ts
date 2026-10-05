// Still water as a painting: a pool with no current (see docs/water.md,
// "Still water"), the splash the ball throws up when it falls in, and the
// wake it leaves moving through.
//
// THE SURFACE (`stillWaterMaterial`) is after the calm-lake painting Tris gave
// on 2026-10-05: a colour ramp over the view's grazing angle - teal looking
// down into the water, a darker blue in the middle distance, sky blue at
// grazing - under horizontal wavelets, flat lighter and darker dashes with a
// lit camera-side rim. (A caustic net after his Blender reference files came
// first and was replaced; its star glints were rejected outright.) The
// channel's soft digital painting (water.ts) is a current's look; this is a
// pool's.
//
// THE SPLASH (`WaterSplashes`) is the reference's splash, staged once rather
// than looped under a waterfall: a cel-shaded crown that rises, flares and
// tears into holes; a lace ring of foam spreading over the surface and
// breaking into flecks at its rim; and droplets thrown up and out, some solid,
// some hollow rings. It never touches the sim - it reads where the ball is
// drawn and how fast it is moving, as the lights do, and every particle is a
// pure function of the clock and the splash's own start, so a pinned clock
// draws the same splash twice.

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { LIGHT_FALLOFF, paletteOf, waterTime } from "./water";
import { POINT_VIEW_HALF_HEIGHT, threeY } from "./space";

const fmt = (n: number): string => n.toFixed(4);

// ---------------------------------------------------------------------------
// Shared GLSL: hashing, value noise, the caustic Voronoi
// ---------------------------------------------------------------------------

const NOISE_GLSL = `
  // PCG-style integer hash: well distributed, no sin(), the same on every GPU.
  uvec3 swPcg3(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 swHash3(vec3 p) {
    return vec3(swPcg3(uvec3(ivec3(floor(p)) + 32768))) / 4294967295.0;
  }
  float swHash1(vec3 p) { return swHash3(p).x; }
  // Smooth value noise in [0, 1].
  float swNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = swHash1(i);
    float n100 = swHash1(i + vec3(1.0, 0.0, 0.0));
    float n010 = swHash1(i + vec3(0.0, 1.0, 0.0));
    float n110 = swHash1(i + vec3(1.0, 1.0, 0.0));
    float n001 = swHash1(i + vec3(0.0, 0.0, 1.0));
    float n101 = swHash1(i + vec3(1.0, 0.0, 1.0));
    float n011 = swHash1(i + vec3(0.0, 1.0, 1.0));
    float n111 = swHash1(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }
`;

// The ripple facets: a 3D Voronoi walk (the third axis is time, so the cells
// morph rather than slide) answering F1, F2, the nearest cell's own random
// number, and which side of its feature point the pixel is on along the
// plane's second axis - the side facing the camera on the surface, where the
// light catches a wavelet's rim.
const FACET_GLSL = `
  vec4 swFacet(vec3 p) {
    vec3 cell = floor(p);
    vec3 local = p - cell;
    float f1 = 8.0;
    float f2 = 8.0;
    float id = 0.0;
    float side = 0.0;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 o = vec3(float(x), float(y), float(z));
      vec3 h = swHash3(cell + o);
      vec3 pt = o + h;
      float d = distance(pt, local);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h.z;
        side = local.y - pt.y;
      } else if (d < f2) {
        f2 = d;
      }
    }
    return vec4(f1, f2, id, side);
  }
`;

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

// THE LOOK, after the painting Tris gave on 2026-10-05 in place of the caustic
// net (a calm blue lake between low-poly rocks). Measured from it by k-means
// over three bands of its water:
// - looking DOWN into it, near the viewer: teal, #257e8b to #2da5b8 on the
//   lit facets (hue 188, s 0.57-0.60, l 0.35-0.45) - which is the BALL
//   pool's own authored #1e7382 almost exactly, so the near colour IS the
//   authored colour;
// - the middle distance: a darker blue, #204d69 to #357ca5 (hue 201, l 0.27-
//   0.43) - the water reflecting the dark rocks and the cave;
// - far off, at a grazing angle: a lighter sky blue, #2a6488 to #4898c5
//   (hue 202, l 0.35-0.53).
// So the colour is a ramp over the view's grazing angle (a Fresnel term)
// that turns the hue 13 degrees toward blue as it goes from looking into the
// water to looking at its reflection; and over it, the ripples: wavelets
// stretched along x, each a FLAT facet of one of three shades, with a light
// rim on the side facing the camera - the low-poly water of the painting.
// The caustic net before this (the Blender reference files') and its star
// glints were both dropped (glints: "they look bad").

// The wavelets: metres across the plane's second axis, stretched STRETCH
// times along x; how fast they morph (cells per second, through the 3D
// field's time axis) and drift (metres per second).
const FACET_CELL = 0.2;
const FACET_STRETCH = 5;
const FACET_MORPH = 0.3;
const FACET_DRIFT = 0.025;
// The dashes: the share of cells carrying a lit one and a dark one, their
// radius range and edge softness in the field's units (a cell is ~1), how far
// each shade goes, and the lit dashes' camera-side rim. Big enough that the
// wavelets cover most of the water, as the painting's do - smaller read as
// scratches on a flat sheet.
const FACET_LIT = 0.4;
const FACET_DARK = 0.3;
const DASH_R = [0.42, 0.62] as const;
const DASH_SOFT = 0.05;
const FACET_W = 0.6;
const RIM_W = 0.25;
// The view ramp: the grazing term (1 - cos of the view against the normal)
// at which the near teal has turned to the middle blue, and the middle blue
// to the far sky; and how far the facets fade at grazing, where perspective
// crushes them into a shimmer.
const GRAZE_MID = [0.45, 0.8] as const;
const GRAZE_FAR = [0.88, 0.99] as const;
const GRAZE_FACET_FADE = 0.5;
// The ramp's stops, from the authored colour: hue turned toward blue,
// lightness and saturation as multiples of the authored colour's (measured
// ratios: mid 0.27/0.35, far 0.44/0.35; saturation 0.52/0.58).
const BLUE_TURN = 13 / 360;
const MID_L = 0.8;
const FAR_L = 1.25;
const BLUE_S = 0.9;
// The facet shades about whatever the ramp gives: lit +0.10 lightness, dark
// -0.06 (the painting's near clusters); the rim lifted toward white.
const LIT_DL = 0.1;
const DARK_DL = -0.06;
const RIM_LIFT = 0.45;
// How much of the colour is the water's own light rather than the scene's:
// the painting's water is luminous, a pool in a lit cave mostly lit.
const SELF_LIGHT = 0.35;
// The front sheet, looking into the water: the near teal deepening toward the
// bed under a pale line at the waterline.
const FRONT_DEEP_W = 0.65;
const RIM_WIDTH = 0.008;
const RIM_SOFT = 0.016;
const WATERLINE_W = 0.5;

// One colour moved in HSL, in sRGB, as paletteOf does (water.ts).
function shifted(c: THREE.Color, dh: number, sMul: number, lMul: number, dl = 0): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(
    (hsl.h + dh + 1) % 1,
    Math.min(1, hsl.s * sMul),
    Math.min(1, Math.max(0, hsl.l * lMul + dl)),
    THREE.SRGBColorSpace,
  );
}

export function stillWaterMaterial(color: string | undefined): THREE.MeshStandardMaterial {
  const palette = paletteOf(color);
  const near = palette.body;
  const mid = shifted(near, BLUE_TURN, BLUE_S, MID_L);
  const far = shifted(near, BLUE_TURN, BLUE_S, FAR_L);
  const mat = new THREE.MeshStandardMaterial({
    color: palette.body,
    roughness: 0.55,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.envMapIntensity = 0.15;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uDeep = { value: palette.deep };
    shader.uniforms.uNear = { value: near };
    shader.uniforms.uMid = { value: mid };
    shader.uniforms.uFar = { value: far };
    shader.uniforms.uNearLit = { value: shifted(near, 0, 1, 1, LIT_DL) };
    shader.uniforms.uMidLit = { value: shifted(mid, 0, 1, 1, LIT_DL) };
    shader.uniforms.uFarLit = { value: shifted(far, 0, 1, 1, LIT_DL) };

    shader.vertexShader = `
      attribute float aLit;
      attribute float aAlpha;
      attribute float aUp;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying vec3 vWorld;
    ${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vLit = aLit;
      vAlpha = aAlpha;
      vUp = aUp;
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`,
    );

    shader.fragmentShader = `
      uniform float uTime;
      uniform vec3 uDeep;
      uniform vec3 uNear;
      uniform vec3 uMid;
      uniform vec3 uFar;
      uniform vec3 uNearLit;
      uniform vec3 uMidLit;
      uniform vec3 uFarLit;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      ${FACET_GLSL}
      // The view ramp: into the water near, its dark reflection in the middle,
      // the sky's at grazing.
      vec3 swRamp(float g, vec3 n, vec3 m, vec3 f) {
        vec3 c = mix(n, m, smoothstep(${fmt(GRAZE_MID[0])}, ${fmt(GRAZE_MID[1])}, g));
        return mix(c, f, smoothstep(${fmt(GRAZE_FAR[0])}, ${fmt(GRAZE_FAR[1])}, g));
      }
    ${shader.fragmentShader}`
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
      // The plan frame on the surface (x, z), the elevation frame on the front
      // sheet (x, y) - one shared coordinate is constant on whichever face it
      // is not built from (docs/water.md).
      vec2 swPlane = mix(vWorld.xy, vWorld.xz, vUp);
      // How far below the waterline a front-sheet pixel is, in metres: the
      // geometry's light falloff (aLit, 1 at the waterline to 0 LIGHT_FALLOFF
      // below) read back as a distance.
      float swBelow = (1.0 - vUp) * (1.0 - vLit) * ${fmt(LIGHT_FALLOFF)};

      // The view: how grazing it is against this face's normal (up on the
      // surface, toward the camera on the front sheet).
      vec3 swView = normalize(cameraPosition - vWorld);
      float swGraze = 1.0 - clamp(mix(swView.z, swView.y, vUp), 0.0, 1.0);

      // The wavelets.
      vec3 swQ = vec3(
        (swPlane.x + uTime * ${fmt(FACET_DRIFT)}) / ${fmt(FACET_CELL * FACET_STRETCH)},
        swPlane.y / ${fmt(FACET_CELL)},
        uTime * ${fmt(FACET_MORPH)});
      vec4 swF = swFacet(swQ);
      // A dash in some cells - an ellipse about the feature point, long
      // along x because the field is - lighter or darker than the water, and
      // nothing in the rest: separate strokes on smooth water, never a mesh
      // of outlined cells (which is what rimming every cell drew: cracked
      // ice). The dash's size wanders a little so they are not all one stamp.
      float swSize = mix(${fmt(DASH_R[0])}, ${fmt(DASH_R[1])}, fract(swF.z * 17.31));
      float swDash = 1.0 - smoothstep(swSize - ${fmt(DASH_SOFT)}, swSize, swF.x);
      float swShade = swDash * (step(1.0 - ${fmt(FACET_LIT)}, swF.z) - step(swF.z, ${fmt(FACET_DARK)}));
      // The lit rim: the camera-facing side of a lit dash catches the light
      // (+z on the surface; on the front sheet, the top of each band).
      float swRimLit = max(swShade, 0.0) * smoothstep(swSize * 0.35, swSize * 0.75, swF.x)
        * step(0.0, swF.w * mix(-1.0, 1.0, vUp));
      // Facets fade at grazing, where perspective crushes them, and the front
      // sheet has none: it is a cross-section, and wavelets drawn on it read
      // as lily pads stuck to a wall.
      float swFacetW = vUp * (1.0 - ${fmt(GRAZE_FACET_FADE)} * smoothstep(0.7, 0.98, swGraze));

      vec3 swBase = swRamp(swGraze, uNear, uMid, uFar);
      vec3 swLit = swRamp(swGraze, uNearLit, uMidLit, uFarLit);
      vec3 swCol = swBase;
      swCol = mix(swCol, swLit, ${fmt(FACET_W)} * swFacetW * max(swShade, 0.0));
      swCol = mix(swCol, swBase * ${fmt(1 + DARK_DL / 0.35)}, ${fmt(FACET_W)} * swFacetW * max(-swShade, 0.0));
      swCol = mix(swCol, mix(swLit, vec3(1.0), ${fmt(RIM_LIFT)}), ${fmt(RIM_W)} * swFacetW * swRimLit);

      // The front sheet: the near teal deepening toward the bed, under a
      // pale line at the waterline.
      swCol = mix(swCol, uDeep, (1.0 - vUp) * ${fmt(FRONT_DEEP_W)} * smoothstep(0.0, 0.5, swBelow));
      float swLine = (1.0 - vUp) * (1.0 - smoothstep(${fmt(RIM_WIDTH)}, ${fmt(RIM_WIDTH + RIM_SOFT)}, swBelow));
      swCol = mix(swCol, mix(uNearLit, vec3(1.0), 0.5), ${fmt(WATERLINE_W)} * swLine);
      diffuseColor.rgb = swCol * (1.0 - ${fmt(SELF_LIGHT)});
      diffuseColor.a = vAlpha;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
      totalEmissiveRadiance += swCol * ${fmt(SELF_LIGHT)};`,
      );
  };
  mat.customProgramCacheKey = () => "still-water";
  return mat;
}

// ---------------------------------------------------------------------------
// The splash
// ---------------------------------------------------------------------------

// A pool the splash can happen on, in the frames the detector needs: the body
// (its pose, in the sim's metres, y down), the rect's half extents, and the
// slab's z range in the body's frame (three's, +z toward the camera).
export interface StillSurface {
  body: WaterArea;
  halfX: number;
  halfY: number;
  backZ: number;
  frontZ: number;
}

// The ball as the detector reads it: where it is DRAWN this frame and how fast
// the sim says it is moving. Read, never written.
export interface SplashBall {
  position: Vec2;
  velocity: Vec2;
  radius: number;
}

// How many splashes can be in the air at once; the oldest is reused.
const SLOTS = 6;
// Entry speeds (m/s, downward through the surface): under SPLASH_MIN nothing,
// SPLASH_FULL and over the whole splash. A ball leaving the water upward
// faster than EXIT_MIN throws a smaller one (EXIT_POWER of its speed's).
const SPLASH_MIN = 0.6;
const SPLASH_FULL = 7;
const SPLASH_FLOOR = 0.15;
const EXIT_MIN = 1.5;
const EXIT_POWER = 0.5;
// A ball that moved further than this between two drawn frames was placed,
// not thrown (a restart, a seek): no splash.
const TELEPORT = 1.5;

// THE WAKE: while the ball moves through the water with its bottom no deeper
// than WAKE_DEPTH under the top (and faster than WAKE_MIN_SPEED along it), it
// sheds a ring every WAKE_SPACING metres. Each ring spreads and fades on its
// own, so a slow ball draws loose concentric rings and a fast one a V.
const RIPPLES = 32;
const WAKE_DEPTH = 0.35;
const WAKE_MIN_SPEED = 0.15;
const WAKE_FULL_SPEED = 3;
const WAKE_SPACING = 0.14;
const RIPPLE_LIFE = 1.5;
// How fast a ring spreads (m/s, easing out) and how wide its line is (m).
const RIPPLE_SPEED = 0.55;
const RIPPLE_LINE = 0.012;
const RIPPLE_COLOR = "#d4f5fb";

// THE CROWN: an open ring wall that rises out of the surface, flares outward
// and tears into holes as it falls - the reference's cloud-displaced
// cylinders, cel-shaded pale cyan with white blotches and a white fringe.
const CROWN_SEG = 48;
const CROWN_ROWS = 8;
const CROWN_LIFE = [0.45, 0.8] as const;
const CROWN_HEIGHT = [0.12, 0.42] as const;
// Starting radius as a multiple of the ball's, and how far it spreads (m).
const CROWN_R0 = 1.05;
const CROWN_SPREAD = [0.06, 0.2] as const;
const CROWN_FLARE = 0.55;
const CROWN_FRONT = "#a6e8f6";
const CROWN_BACK = "#5cc0d8";

// THE LACE: foam spreading over the surface from where the ball went in -
// radial lace near the middle, breaking into torn flecks at its rim, with two
// broken ripple rings running ahead of it.
const LACE_LIFE = [1.1, 2.0] as const;
const LACE_RADIUS = [0.35, 1.1] as const;
const LACE_COLOR = "#c6f1fa";
const LACE_SPOKES = 22;

// THE DROPLETS: thrown up and out, ballistic; most solid dots, some hollow
// rings, like the reference's.
const DROPS = 40;
const DROP_UP = [1.4, 3.6] as const;
const DROP_OUT = [0.3, 1.5] as const;
const DROP_SIZE = [0.012, 0.034] as const;
const DROP_RING_ODDS = 0.3;
const DROP_GRAVITY = 9.81;
const DROP_COLOR = "#effbfd";

// The shared shader prelude: the slot table and the collapse for an idle slot.
const SLOT_GLSL = `
  uniform float uTime;
  uniform vec4 uAt[${SLOTS}];     // x, y, z (three's frame), start time
  uniform vec4 uHow[${SLOTS}];    // power 0..1 (0 = idle), seed, ball radius, -
  uniform vec4 uClip[${SLOTS}];   // the pool's xmin, xmax, zmin, zmax
  attribute float aSlot;
  // Outside the clip volume: an idle slot's triangles all land here and vanish.
  const vec4 SW_GONE = vec4(0.0, 0.0, 2.0, 1.0);
`;

const lerpGlsl = (r: readonly [number, number], t: string): string => `mix(${fmt(r[0])}, ${fmt(r[1])}, ${t})`;

interface SplashSlot {
  at: THREE.Vector4;
  how: THREE.Vector4;
  clip: THREE.Vector4;
}

export class WaterSplashes {
  readonly root = new THREE.Group();
  private readonly slots: SplashSlot[] = [];
  private next = 0;
  private prev: Vec2 | null = null;
  private prevClock = 0;
  // Where the last wake ring was shed, while the ball is still making one.
  private wakeFrom: Vec2 | null = null;
  private readonly ripples: SplashSlot[] = [];
  private nextRipple = 0;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor() {
    for (let i = 0; i < SLOTS; i++) {
      this.slots.push({ at: new THREE.Vector4(), how: new THREE.Vector4(), clip: new THREE.Vector4() });
    }
    const uniforms = {
      uTime: waterTime,
      uAt: { value: this.slots.map((s) => s.at) },
      uHow: { value: this.slots.map((s) => s.how) },
      uClip: { value: this.slots.map((s) => s.clip) },
    };
    this.add(new THREE.Mesh(...this.crown(uniforms)), 12);
    this.add(new THREE.Mesh(...this.lace(uniforms)), 11);
    this.add(new THREE.Points(...this.drops(uniforms)), 13);
    for (let i = 0; i < RIPPLES; i++) {
      this.ripples.push({ at: new THREE.Vector4(), how: new THREE.Vector4(), clip: new THREE.Vector4() });
    }
    this.add(new THREE.Mesh(...this.rippleRings()), 10.5);
  }

  private add(obj: THREE.Mesh | THREE.Points, order: number): void {
    // Always in the scene and always "visible", so the prewarm compiles all
    // three programs; an idle slot collapses in the vertex shader instead.
    obj.frustumCulled = false;
    obj.renderOrder = order;
    this.geometries.push(obj.geometry);
    this.materials.push(obj.material as THREE.Material);
    this.root.add(obj);
  }

  // Forget every splash and the ball's last position: a new level, a restart.
  reset(): void {
    for (const s of this.slots) s.how.x = 0;
    for (const r of this.ripples) r.how.x = 0;
    this.wakeFrom = null;
    this.prev = null;
  }

  // Once per drawn frame, after the clock is set: did the ball cross a pool's
  // surface since the last frame, and which way? And is it moving through the
  // water near enough the top to leave a wake?
  update(clock: number, surfaces: Iterable<StillSurface>, ball: SplashBall | null): void {
    if (!ball) {
      this.prev = null;
      this.wakeFrom = null;
      return;
    }
    const p = ball.position;
    const q = this.prev;
    const dt = clock - this.prevClock;
    this.prev = p;
    this.prevClock = clock;
    if (!q || p.distanceTo(q) > TELEPORT || dt <= 0) {
      this.wakeFrom = null;
      return;
    }
    // The ball's velocity as DRAWN between the two frames, beside the sim's
    // own. A pool over a shallow bed stops the ball within the frame it goes
    // in (the BALL pool's floor is 5 cm under its surface), so the sim's
    // velocity on the frame the crossing is seen is already zero.
    const drawn = p.sub(q).div(dt);
    let waking = false;
    for (const s of surfaces) {
      const c = s.body.globalPosition;
      const rot = s.body.globalRotation;
      const lp = p.sub(c).rotated(-rot);
      const lq = q.sub(c).rotated(-rot);
      const top = -s.halfY;
      // The ball sits on the gameplay plane, which the slab may not contain
      // when it is shifted through z.
      const z = Math.min(Math.max(0, s.backZ), s.frontZ);
      // The pool's footprint for the lace and the ripples (an axis-aligned
      // box: still water is never authored turned).
      const ex = Math.abs(Math.cos(rot)) * s.halfX + Math.abs(Math.sin(rot)) * s.halfY;
      const clip: [number, number, number, number] = [c.x - ex, c.x + ex, s.backZ, s.frontZ];
      const surfacePoint = (x: number): Vec2 => c.add(new Vec2(x, top).rotated(rot));

      // The wake: inside the pool's span, in the water but not deeper than
      // WAKE_DEPTH below the top, moving along it. A ring is shed every
      // WAKE_SPACING metres travelled, so the rings sit evenly whatever the
      // frame rate and the ripples of a fast ball fan into a V.
      const depth = lp.y - top + ball.radius;
      if (Math.abs(lp.x) <= s.halfX && depth > 0 && depth < WAKE_DEPTH + ball.radius) {
        const speed = Math.max(Math.abs(ball.velocity.rotated(-rot).x), Math.abs(drawn.rotated(-rot).x));
        if (speed > WAKE_MIN_SPEED) {
          waking = true;
          const at = surfacePoint(lp.x);
          if (!this.wakeFrom || this.wakeFrom.distanceTo(at) >= WAKE_SPACING) {
            this.wakeFrom = at;
            // Strongest with the ball breaking the surface, gone by WAKE_DEPTH;
            // and with speed.
            const shallow = 1 - Math.max(0, depth - ball.radius * 2) / WAKE_DEPTH;
            const fast = Math.min(1, speed / WAKE_FULL_SPEED);
            const strength = Math.max(0, shallow) * (0.35 + 0.65 * fast);
            if (strength > 0.05) this.ripple(at.x, threeY(at.y), z, clock, strength, ball.radius, clip);
          }
        }
      }

      // The splash is when the ball's BOTTOM meets the water, going in, and
      // when it leaves it, coming out.
      const r = ball.radius;
      const entering = lq.y + r < top && lp.y + r >= top;
      const leaving = lq.y + r >= top && lp.y + r < top;
      if (!entering && !leaving) continue;
      const t = (top - lq.y - r) / (lp.y - lq.y);
      const x = lq.x + (lp.x - lq.x) * t;
      if (Math.abs(x) > s.halfX) continue;
      const simDown = ball.velocity.rotated(-rot).y;
      const drawnDown = drawn.rotated(-rot).y;
      const down = entering ? Math.max(simDown, drawnDown) : Math.min(simDown, drawnDown);
      const speed = entering ? down : -down * EXIT_POWER;
      if (speed < (entering ? SPLASH_MIN : EXIT_MIN * EXIT_POWER)) continue;
      const power = Math.min(1, Math.max(SPLASH_FLOOR, (speed - SPLASH_MIN) / (SPLASH_FULL - SPLASH_MIN)));
      const w = surfacePoint(x);
      this.spawn(w.x, threeY(w.y), z, clock, power, ball.radius, clip);
    }
    if (!waking) this.wakeFrom = null;
  }

  private ripple(
    x: number,
    y: number,
    z: number,
    clock: number,
    strength: number,
    radius: number,
    clip: [number, number, number, number],
  ): void {
    const r = this.ripples[this.nextRipple]!;
    this.nextRipple = (this.nextRipple + 1) % RIPPLES;
    r.at.set(x, y, z, clock);
    r.how.set(strength, (clock * 13.7) % 89, radius, 0);
    r.clip.set(...clip);
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    clock: number,
    power: number,
    radius: number,
    clip: [number, number, number, number],
  ): void {
    const slot = this.slots[this.next]!;
    this.next = (this.next + 1) % SLOTS;
    slot.at.set(x, y, z, clock);
    // The seed varies the crown's jag and the lace's cells from splash to
    // splash; taken from the clock so a pinned clock draws the same one.
    slot.how.set(power, (clock * 7.31) % 97, radius, 0);
    slot.clip.set(...clip);
  }

  private crown(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const ring: number[] = [];
    const index: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const base = slot.length;
      for (let r = 0; r <= CROWN_ROWS; r++) {
        for (let k = 0; k <= CROWN_SEG; k++) {
          slot.push(s);
          ring.push((k / CROWN_SEG) * Math.PI * 2, r / CROWN_ROWS);
        }
      }
      const cols = CROWN_SEG + 1;
      for (let r = 0; r < CROWN_ROWS; r++) {
        for (let k = 0; k < CROWN_SEG; k++) {
          const a = base + r * cols + k;
          index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aRing", new THREE.Float32BufferAttribute(ring, 2));
    g.setIndex(index);
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uFront: { value: new THREE.Color(CROWN_FRONT) },
        uBack: { value: new THREE.Color(CROWN_BACK) },
      }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        attribute vec2 aRing;
        varying vec2 vRing;
        varying float vU;
        varying float vSeed;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          float life = ${lerpGlsl(CROWN_LIFE, "power")};
          float u = (uTime - at.w) / life;
          if (power <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = SW_GONE; return; }
          float a = aRing.x;
          float v = aRing.y;
          float sd = how.y;
          // The jagged rim: a periodic sum of sines round the ring, sharpened
          // so the crown has points rather than a wavy hem.
          float jag = 0.5 + 0.5 * (0.55 * sin(5.0 * a + sd) + 0.3 * sin(9.0 * a + sd * 1.7) + 0.25 * sin(14.0 * a + sd * 2.3));
          jag = pow(clamp(jag, 0.0, 1.0), 1.5);
          // Up fast, then down: risen by a third of its life, collapsing after.
          float rise = smoothstep(0.0, 0.32, u);
          float fall = 1.0 - smoothstep(0.4, 1.0, u);
          float h = ${lerpGlsl(CROWN_HEIGHT, "power")} * rise * (0.25 + 0.75 * fall) * (0.4 + 0.8 * jag);
          float r0 = how.z * ${fmt(CROWN_R0)} + ${lerpGlsl(CROWN_SPREAD, "power")} * sqrt(u);
          float r = r0 + v * v * h * ${fmt(CROWN_FLARE)} * (0.6 + 1.2 * u);
          r *= 1.0 + 0.14 * v * sin(3.0 * a + sd * 3.1);
          vec3 p = vec3(at.x + r * cos(a), at.y - 0.01 + v * h, at.z + r * sin(a));
          vRing = aRing;
          vU = u;
          vSeed = sd;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uFront;
        uniform vec3 uBack;
        varying vec2 vRing;
        varying float vU;
        varying float vSeed;
        ${NOISE_GLSL}
        float swCell(vec2 p) {
          vec2 c = floor(p);
          float d = 8.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            // Wrapped round the ring so the seam at angle 0 does not show.
            vec2 cell = vec2(mod(c.x + o.x, 12.0), c.y + o.y);
            d = min(d, distance(o + swHash3(vec3(cell, vSeed)).xy, p - c));
          }
          return d;
        }
        void main() {
          vec2 q = vec2(vRing.x / 6.2832 * 12.0, vRing.y * 2.5);
          // Holes that open as the crown falls: it tears into lace and goes.
          float hole = swCell(q * 1.6 + vec2(0.0, vU * 0.8));
          if (hole < smoothstep(0.3, 1.0, vU) * 0.75) discard;
          vec3 col = gl_FrontFacing ? uFront : uBack;
          // White blotches, and a white fringe along the points.
          float blot = step(0.62, swCell(q + 3.7));
          col = mix(col, vec3(1.0), max(blot * 0.8, step(0.82, vRing.y)));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      side: THREE.DoubleSide,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  private lace(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const corner: number[] = [];
    const index: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const b = slot.length;
      for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        slot.push(s);
        corner.push(cx, cz);
      }
      index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
    g.setIndex(index);
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(LACE_COLOR) } }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        attribute vec2 aCorner;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vPower;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          float u = (uTime - at.w) / ${lerpGlsl(LACE_LIFE, "power")};
          if (power <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = SW_GONE; return; }
          // Big enough for the rings running ahead of the lace.
          float reach = ${lerpGlsl(LACE_RADIUS, "power")} * 1.5;
          vQ = aCorner * reach;
          vec3 p = vec3(at.x + vQ.x, at.y + 0.004, at.z + vQ.y);
          vWorld = p;
          vU = u;
          vPower = power;
          vSeed = how.y;
          vR0 = how.z;
          vClip = uClip[s];
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vPower;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        ${NOISE_GLSL}
        // F1 and F2 of a 2D Voronoi whose x wraps every 'wrap' cells - the
        // angle - so a field laid out in polar coordinates has no seam.
        vec2 swVoronoi(vec2 p, float wrap, float seed) {
          vec2 c = floor(p);
          float f1 = 8.0;
          float f2 = 8.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            vec2 cell = vec2(mod(c.x + o.x, wrap), c.y + o.y);
            float d = distance(o + swHash3(vec3(cell, seed)).xy, p - c);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
          return vec2(f1, f2);
        }
        void main() {
          if (vWorld.x < vClip.x || vWorld.x > vClip.y || vWorld.z < vClip.z || vWorld.z > vClip.w) discard;
          float r = length(vQ);
          float th = atan(vQ.y, vQ.x) / 6.2832 + 0.5;
          float u = vU;
          float rMax = ${lerpGlsl(LACE_RADIUS, "vPower")};
          // The front runs out fast and slows; the middle hollows behind it.
          float front = vR0 + (rMax - vR0) * (1.0 - pow(1.0 - u, 2.2));
          float inner = front * mix(0.2, 0.75, u);
          // The lace: Voronoi edges in log-polar space, so its cells stretch
          // out along the spokes the way the reference's do; thick when young,
          // thinning as it spreads.
          vec2 lp = vec2(th * ${fmt(LACE_SPOKES)}, log(max(r, 0.01)) * 4.0);
          vec2 f = swVoronoi(lp, ${fmt(LACE_SPOKES)}, vSeed);
          float web = 1.0 - smoothstep(mix(0.42, 0.12, u) - 0.02, mix(0.42, 0.12, u), f.y - f.x);
          float band = smoothstep(inner * 0.9, inner, r) * (1.0 - smoothstep(front * 0.8, front, r));
          float lace = web * band;
          // Torn flecks at and past the rim: some cells kept whole, stretched
          // round the ring.
          vec2 fp = vec2(th * ${fmt(LACE_SPOKES * 2)}, r * 9.0);
          vec2 fc = floor(fp);
          float keep = step(swHash3(vec3(mod(fc.x, ${fmt(LACE_SPOKES * 2)}), fc.y, vSeed + 5.0)).x, 0.3);
          vec2 g = swVoronoi(fp, ${fmt(LACE_SPOKES * 2)}, vSeed + 5.0);
          float fleck = keep * step(g.x, mix(0.42, 0.18, u))
            * smoothstep(front * 0.75, front * 0.85, r) * (1.0 - smoothstep(front * 1.15, front * 1.3, r));
          // Two broken ripple rings ahead of the lace.
          float ring = 0.0;
          for (int k = 1; k <= 2; k++) {
            float rr = front * (1.0 + 0.18 * float(k));
            float on = step(0.45, swNoise(vec3(th * 18.0, float(k) * 3.1, vSeed)));
            ring = max(ring, on * (1.0 - smoothstep(0.004, 0.012, abs(r - rr))));
          }
          float fade = 1.0 - smoothstep(0.6, 1.0, u);
          float a = max(max(lace, fleck), ring * 0.45) * fade;
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor, a * 0.95);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  private drops(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const seed: number[] = [];
    let n = 987654321;
    const rnd = (): number => {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      return n / 0x7fffffff;
    };
    for (let s = 0; s < SLOTS; s++) {
      for (let i = 0; i < DROPS; i++) {
        slot.push(s);
        seed.push(rnd(), rnd(), rnd(), rnd());
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uViewHalfHeight: POINT_VIEW_HALF_HEIGHT,
        uColor: { value: new THREE.Color(DROP_COLOR) },
      }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        uniform float uViewHalfHeight;
        attribute vec4 aSeed;
        varying float vRing;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          // A drop leaves a little after the ball goes in, and only as many
          // drops as the splash has power for.
          float t = uTime - at.w - aSeed.w * 0.12;
          if (power <= 0.0 || t < 0.0 || aSeed.w > 0.25 + 0.75 * power) { gl_Position = SW_GONE; return; }
          float a = aSeed.x * 6.2832;
          vec2 dir = vec2(cos(a), sin(a));
          float up = ${lerpGlsl(DROP_UP, "aSeed.y")} * mix(0.45, 1.0, power);
          float out_ = ${lerpGlsl(DROP_OUT, "aSeed.z")} * mix(0.4, 1.0, power);
          vec3 p = vec3(at.x, at.y + 0.02, at.z) + vec3(dir.x, 0.0, dir.y) * how.z;
          p += vec3(dir.x * out_, up, dir.y * out_) * t;
          p.y -= 0.5 * ${fmt(DROP_GRAVITY)} * t * t;
          // Back in the water: gone.
          if (p.y < at.y) { gl_Position = SW_GONE; return; }
          vRing = step(fract(aSeed.y * 7.31), ${fmt(DROP_RING_ODDS)});
          float size = ${lerpGlsl(DROP_SIZE, "fract(aSeed.x * 13.7)")} * mix(0.6, 1.0, power) * (1.0 + 0.6 * vRing);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = max(2.0, size * projectionMatrix[1][1] * uViewHalfHeight / -mvPosition.z);
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying float vRing;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float dot_ = 1.0 - smoothstep(0.4, 0.5, d);
          float ring = dot_ * smoothstep(0.24, 0.32, d);
          float a = mix(dot_, ring, vRing);
          if (a < 0.05) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  // The wake's rings: one quad per ring on the surface, a thin pale line
  // spreading out from where it was shed, broken round its length the way a
  // painted ripple is, thinning and fading as it goes.
  private rippleRings(): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const corner: number[] = [];
    const index: number[] = [];
    for (let s = 0; s < RIPPLES; s++) {
      const b = slot.length;
      for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        slot.push(s);
        corner.push(cx, cz);
      }
      index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
    g.setIndex(index);
    const reach = RIPPLE_SPEED * RIPPLE_LIFE + 0.2;
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(RIPPLE_COLOR) } }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime;
        uniform vec4 uAt[${RIPPLES}];
        uniform vec4 uHow[${RIPPLES}];
        uniform vec4 uClip[${RIPPLES}];
        attribute float aSlot;
        attribute vec2 aCorner;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vStrength;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float u = (uTime - at.w) / ${fmt(RIPPLE_LIFE)};
          if (how.x <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          vQ = aCorner * ${fmt(reach)};
          // A hair above the lace, which a ring may cross.
          vec3 p = vec3(at.x + vQ.x, at.y + 0.005, at.z + vQ.y);
          vWorld = p;
          vU = u;
          vStrength = how.x;
          vSeed = how.y;
          vR0 = how.z;
          vClip = uClip[s];
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vStrength;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        ${NOISE_GLSL}
        void main() {
          if (vWorld.x < vClip.x || vWorld.x > vClip.y || vWorld.z < vClip.z || vWorld.z > vClip.w) discard;
          float r = length(vQ);
          float th = atan(vQ.y, vQ.x) / 6.2832 + 0.5;
          // Out fast, then slowing.
          float front = vR0 + ${fmt(RIPPLE_SPEED * RIPPLE_LIFE)} * (1.0 - pow(1.0 - vU, 1.8));
          float w = ${fmt(RIPPLE_LINE)} * mix(1.4, 0.6, vU);
          float line = 1.0 - smoothstep(w * 0.5, w, abs(r - front));
          // A fainter second ring just inside the first.
          float inner = 1.0 - smoothstep(w * 0.4, w * 0.8, abs(r - front * 0.8));
          // Broken round its length, more as it spreads; wrapped at the seam.
          float brk = mix(
            swNoise(vec3(th * 16.0, vSeed, 0.0)),
            swNoise(vec3((th - 1.0) * 16.0, vSeed, 0.0)),
            smoothstep(0.9, 1.0, th));
          float on = smoothstep(0.25 + 0.35 * vU, 0.35 + 0.35 * vU, brk);
          float fade = (1.0 - smoothstep(0.35, 1.0, vU)) * smoothstep(0.0, 0.06, vU);
          float a = max(line, inner * 0.5) * on * fade * vStrength;
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor, a * 0.85);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    Object.assign(m.uniforms, {
      uTime: waterTime,
      uAt: { value: this.ripples.map((s) => s.at) },
      uHow: { value: this.ripples.map((s) => s.how) },
      uClip: { value: this.ripples.map((s) => s.clip) },
    });
    return [g, m];
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
