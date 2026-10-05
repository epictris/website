// A spot light's shaft as LIT FOG: what a view ray collects crossing the
// spot's cone through the level's own haze, marched against the scene's depth
// and the spot's shadow map. Replaced the additive cone mesh on 2026-10-05.
//
// WHY A VOLUME AND NOT A MESH. The cone mesh was an additive surface faking a
// volume, and it got two things wrong that a played backdrop shaft showed at
// once:
//
//   - The fog ATE it. A shaft 30 m from the camera was attenuated by the fog
//     like a surface, to ~12% at the river's density, while the fog around it
//     stayed at full strength: the shaft vanished into the very air it is made
//     of. Here the shaft IS the fog, lit: it collects what the fog law says
//     that stretch of air contributes (below), so a shaft in thick air reads
//     as brighter air rather than as a faded sticker.
//   - It had no depth. A see-through mesh writes none, so the depth of field
//     either drew it sharp over a blurred backdrop (its bounds reached the
//     plane) or blurred it by the wall behind it. Here it is added to the
//     frame before the blur reads it (`DepthOfField.render`'s `afterScene`),
//     so it blurs exactly as much as the scenery it is seen against.
//
// THE FOG LAW, EXTENDED. Three mixes a surface at view depth d toward the fog
// colour by F(d) (`fog_fragment`). Read as scattering, F(d) is the integral of
// the air's in-scatter times its transmittance from the camera to d, so the
// stretch of a ray between depths a and b contributes F(b) - F(a) of whatever
// light the air there carries. The fog colour is the light everywhere; inside
// a spot's cone the air carries the spot's as well. That increment is the
// whole weight of a step, exact for its stretch, so the shaft has no density
// of its own to tune against the fog: thicker fog, brighter shaft, and a
// shaft far off is dimmed by the air in front of it the way the fog says.
// A level with no fog still has `SHAFT_AIR` of air, so a beam always shows.
//
// WHAT LIGHTS THE AIR: the spot's own cone and penumbra (three's own
// `smoothstep(coneCos, penumbraCos, cos)`), the beam's fade along its reach,
// its rays, its flicker, and its shadow map: a spot that casts shadows is cut
// into real shafts by whatever stands in its light (the mouth of a cave, a
// hanging vine). The rays (`BEAM_RAYS`) stay as a cookie for the air a shadow
// does not break up.
//
// THE COST. Marched at about `SHAFT_LINES` lines (the depth of field's own
// rule: a factor of 2 at 1080p, 4 at 4K) with `SHAFT_STEPS` steps over only
// the stretch of each ray inside each cone (solved, not searched for), then
// added to the full frame by a depth-aware upsample that keeps the shaft from
// bleeding over the edge of a rock in front of it. Pixels whose ray misses
// every cone cost one intersection test; with no shaft in view nothing here
// runs, and the frame does not even keep its depth.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import {
  BEAM_FADE_IN,
  BEAM_FADE_OUT_FROM,
  BEAM_RAY_DEPTH,
  BEAM_RAY_DRIFT,
  BEAM_RAYS,
  BEAM_RAYS_FINE,
  type Shaft,
} from "./beam";

// The light a fully visible beam (`beam = 1`) puts into its air, as a
// multiple of the spot's colour, relative to the fog colour the rest of the
// air carries at 1. Above 1 because a shaft is a lamp seen through haze,
// several times brighter than the ambient that colours the fog.
export const SHAFT_GAIN = 6;

// How much the fog's own colour tints the light it scatters, 0..1: the haze
// is what does the scattering, so a white lamp's shaft in blue air reads as
// bluish air lit up rather than as white paint over it. The tint is the fog
// colour's hue at full value (its largest channel scaled to 1), so a dark fog
// tints without dimming; at 1 the shaft is that hue outright. 1, because
// anything less reads as grey: the tint is applied in linear light, and the
// frame's darkest channel (red, in blue air) gains the most per unit of light
// once it is encoded for display - at 0.6 a white shaft in the river's fog
// added (+20, +16, +16) in sRGB, neutral to the eye.
export const SHAFT_FOG_TINT = 1;

// The in-scatter, per metre, of the air in a level that asks for no fog, so
// a beam authored there still shows. Small: three metres of it is ~0.1.
export const SHAFT_AIR = 0.035;

// How soft a shadow is IN THE AIR, as the angular radius in radians of the
// disc the shadow map is averaged over around each point (1.5 degrees). A spot
// is a point source, so the shadow its map holds is a perfectly sharp plane
// through the lamp, and inside a shaft that plane is seen edge on, as a hard
// line down the middle of it: what a rock just beside the river's backdrop
// lamp did to its shaft (2026-10-05, gone with the shadow camera's near pushed
// to 3 m). Light coming through an opening is an area source, so its shafts
// have soft edges that widen with distance, which is what a fixed angle seen
// from the lamp gives. Surfaces keep three's own sharp shadow.
export const SHAFT_SHADOW_SOFTNESS = 0.026;
// Taps over that disc per step; turned every step, so the march's 32 steps
// average 32 x this many.
const SHADOW_TAPS = 6;

// THE HALO: the shaft's light scattered a second time, so the lit fog lights
// the fog around it and a shaft in a cave brightens the air across the
// backdrop rather than standing in the dark as a lone stripe (Tris,
// 2026-10-05, against the skylit-cave reference). Its brightness beside the
// cone as a fraction of the cone's own light, and the distance in metres over
// which it falls to 1/e of that outside the cone.
export const SHAFT_HALO = 0.5;
export const SHAFT_HALO_RADIUS = 3;
const HALO_STEPS = 16;

// About how many lines the shaft is marched at (see the header).
const SHAFT_LINES = 540;
const MAX_FACTOR = 4;

// Steps along the part of a ray inside one cone, each sample jittered within
// its own step so the steps never band into contour lines.
const SHAFT_STEPS = 32;

// How far apart two depths may be, as a fraction of the nearer one, and
// still be the same surface to the upsample.
const DEPTH_TOLERANCE = 0.04;

// Each step's weight below which a shaft adds nothing, in linear light: the
// smallest step an 8-bit frame can show near black.
const VISIBLE = 1 / 1024;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const VIEW_Z_GLSL = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform bool orthographic;
  float viewZAt(ivec2 pixel) {
    float depth = texelFetch(tDepth, pixel, 0).x;
    return orthographic
      ? orthographicDepthToViewZ(depth, cameraNear, cameraFar)
      : perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  }`;

const MARCH_FRAGMENT = /* glsl */ `
  ${VIEW_Z_GLSL}
  #ifdef SHADOWED
    uniform sampler2DShadow tShadow;
    uniform mat4 viewToShadow;
    uniform float shadowSoftness;
  #endif
  uniform mat4 projectionInverse;
  // The viewport inside the frame, in full-size pixels, and the factor.
  uniform vec4 rect;
  uniform float factor;
  // The cone, in view space.
  uniform vec3 apex;
  uniform vec3 axis;
  uniform vec3 across;
  uniform vec3 across2;
  uniform float coneCos;
  uniform float penumbraCos;
  uniform float coneTan;
  uniform float reach;
  uniform vec3 light;
  uniform float phase;
  uniform float time;
  // 0 none (SHAFT_AIR), 1 linear, 2 exponential squared: three's two fogs.
  uniform int fogMode;
  uniform float fogDensity;
  uniform float fogNear;
  uniform float fogFar;

  float fogAt(float depth) {
    if (fogMode == 2) return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    if (fogMode == 1) return smoothstep(fogNear, fogFar, depth);
    return ${f(SHAFT_AIR)} * depth;
  }

  // The interval of t on o + t d inside the cone's forward nappe and within
  // its reach; empty when x >= y.
  vec2 coneInterval(vec3 o, vec3 d) {
    vec3 co = o - apex;
    float dv = dot(d, axis);
    float cv = dot(co, axis);
    float c2 = coneCos * coneCos;
    float A = dv * dv - c2;
    float B = 2.0 * (dv * cv - c2 * dot(d, co));
    float C = cv * cv - c2 * dot(co, co);
    float t0 = -1e9;
    float t1 = 1e9;
    if (abs(A) < 1e-7) {
      // Parallel to the cone's side: one root, B t + C >= 0.
      if (abs(B) < 1e-12) {
        if (C < 0.0) return vec2(1.0, 0.0);
      } else if (B > 0.0) {
        t0 = -C / B;
      } else {
        t1 = -C / B;
      }
    } else {
      float disc = B * B - 4.0 * A * C;
      if (disc < 0.0) {
        // Never inside (A < 0), or inside the double cone everywhere.
        if (A < 0.0) return vec2(1.0, 0.0);
      } else {
        float s = sqrt(disc);
        float r0 = (-B - s) / (2.0 * A);
        float r1 = (-B + s) / (2.0 * A);
        if (r0 > r1) { float r = r0; r0 = r1; r1 = r; }
        if (A > 0.0) {
          // Through both nappes: the forward one is the end the ray heads
          // along the axis toward.
          if (dv > 0.0) t0 = r1; else t1 = r0;
        } else {
          t0 = r0;
          t1 = r1;
        }
      }
    }
    // In front of the lamp and inside the reach.
    if (abs(dv) > 1e-7) {
      float ta = -cv / dv;
      float tb = (reach - cv) / dv;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    } else if (cv < 0.0 || cv > reach) {
      return vec2(1.0, 0.0);
    }
    return vec2(t0, t1);
  }

  float alongFade(float along) {
    return smoothstep(0.0, ${f(BEAM_FADE_IN)}, along) * (1.0 - smoothstep(${f(BEAM_FADE_OUT_FROM)}, 1.0, along));
  }

  // How much of the spot's light the air at p carries, before its shadow.
  float lit(vec3 p) {
    vec3 v = p - apex;
    float along = dot(v, axis);
    float dist = length(v);
    float spot = smoothstep(coneCos, penumbraCos, along / max(dist, 1e-6));
    float turn = atan(dot(v, across2), dot(v, across));
    float waves = 0.6 * sin(turn * ${f(BEAM_RAYS)} + time * ${f(BEAM_RAY_DRIFT)} + phase)
      + 0.4 * sin(turn * ${f(BEAM_RAYS_FINE)} - time * ${f(BEAM_RAY_DRIFT * 1.7)} + phase * 2.3);
    float rays = 1.0 - ${f(BEAM_RAY_DEPTH)} * (0.5 + 0.5 * waves);
    return spot * alongFade(clamp(along / reach, 0.0, 1.0)) * rays;
  }

  // The interval of t on o + t d within \`radius\` of the axis and within the
  // reach: the cylinder the halo lives in. Empty when x >= y.
  vec2 cylinderInterval(vec3 o, vec3 d, float radius) {
    vec3 co = o - apex;
    float dv = dot(d, axis);
    float cv = dot(co, axis);
    vec3 w = co - axis * cv;
    vec3 e = d - axis * dv;
    float A = dot(e, e);
    float B = 2.0 * dot(w, e);
    float C = dot(w, w) - radius * radius;
    float t0 = -1e9;
    float t1 = 1e9;
    if (A < 1e-9) {
      if (C > 0.0) return vec2(1.0, 0.0);
    } else {
      float disc = B * B - 4.0 * A * C;
      if (disc < 0.0) return vec2(1.0, 0.0);
      float s = sqrt(disc);
      t0 = (-B - s) / (2.0 * A);
      t1 = (-B + s) / (2.0 * A);
    }
    if (abs(dv) > 1e-7) {
      float ta = -cv / dv;
      float tb = (reach - cv) / dv;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    } else if (cv < 0.0 || cv > reach) {
      return vec2(1.0, 0.0);
    }
    return vec2(t0, t1);
  }

  // The shaft's light scattered again by the air around it: lit fog lighting
  // the fog beside it. Falls off with distance outside the cone, unshadowed
  // (light that has already scattered once comes from everywhere).
  float halo(vec3 p) {
    vec3 v = p - apex;
    float along = dot(v, axis);
    float radial = length(v - axis * along);
    float outside = max(radial - along * coneTan, 0.0);
    return ${f(SHAFT_HALO)} * exp(-outside / ${f(SHAFT_HALO_RADIUS)}) * alongFade(clamp(along / reach, 0.0, 1.0));
  }

  // Averaged over a disc of SHAFT_SHADOW_SOFTNESS seen from the lamp (a fixed
  // radius in the map, which is a perspective view from the lamp), turned by
  // \`spin\` so each step of the march samples it differently.
  float shadowAt(vec3 p, float spin) {
    #ifdef SHADOWED
      vec4 s = viewToShadow * vec4(p, 1.0);
      s.xyz /= s.w;
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
      float sum = 0.0;
      for (int k = 0; k < ${SHADOW_TAPS}; k++) {
        // Vogel's disc: even cover for any number of taps.
        float r = sqrt((float(k) + 0.5) / float(${SHADOW_TAPS})) * shadowSoftness;
        float a = float(k) * 2.39996323 + spin * 6.28318530718;
        sum += texture(tShadow, vec3(s.xy + vec2(cos(a), sin(a)) * r, s.z));
      }
      return sum / float(${SHADOW_TAPS});
    #else
      return 1.0;
    #endif
  }

  void main() {
    // The centre of the block of full-size pixels this small one covers.
    vec2 local = min((floor(gl_FragCoord.xy) + 0.5) * factor, rect.zw - 0.5);
    ivec2 pixel = ivec2(rect.xy + local);
    float sceneZ = viewZAt(pixel);
    vec2 ndc = local / rect.zw * 2.0 - 1.0;
    vec4 nearP = projectionInverse * vec4(ndc, -1.0, 1.0);
    vec4 farP = projectionInverse * vec4(ndc, 1.0, 1.0);
    vec3 o = nearP.xyz / nearP.w;
    vec3 d = normalize(farP.xyz / farP.w - o);
    // Up to the surface this pixel shows, or the far plane past the sky.
    float tScene = (sceneZ - o.z) / d.z;
    vec2 span = coneInterval(o, d);
    float t0 = max(span.x, 0.0);
    float t1 = min(span.y, tScene);
    vec3 sum = vec3(0.0);
    if (t1 > t0) {
      float dt = (t1 - t0) / float(${SHAFT_STEPS});
      // Interleaved gradient noise (Jimenez): which point of its step each
      // step is sampled at, different for neighbouring pixels.
      float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float before = fogAt(-(o.z + t0 * d.z));
      float collected = 0.0;
      for (int i = 0; i < ${SHAFT_STEPS}; i++) {
        float ta = t0 + float(i) * dt;
        float after = fogAt(-(o.z + (ta + dt) * d.z));
        vec3 p = o + (ta + jitter * dt) * d;
        float l = lit(p);
        if (l > 0.0) collected += l * shadowAt(p, jitter + float(i) * 0.618034) * (after - before);
        before = after;
      }
      sum = light * collected;
    }
    // The halo, over the wider cylinder around the cone. Smooth, so it takes
    // fewer steps.
    vec2 around = cylinderInterval(o, d, reach * coneTan + ${f(SHAFT_HALO_RADIUS * 4)});
    float h0 = max(around.x, 0.0);
    float h1 = min(around.y, tScene);
    if (h1 > h0) {
      float dt = (h1 - h0) / float(${HALO_STEPS});
      float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.00583715, 0.06711056))));
      float before = fogAt(-(o.z + h0 * d.z));
      float collected = 0.0;
      for (int i = 0; i < ${HALO_STEPS}; i++) {
        float ta = h0 + float(i) * dt;
        float after = fogAt(-(o.z + (ta + dt) * d.z));
        collected += halo(o + (ta + jitter * dt) * d) * (after - before);
        before = after;
      }
      sum += light * collected;
    }
    gl_FragColor = vec4(sum, -sceneZ);
  }`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  ${VIEW_Z_GLSL}
  uniform sampler2D tColor;
  uniform sampler2D tShafts;
  uniform vec2 smallSize;
  uniform vec4 rect;
  uniform float factor;
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    float depth = -viewZAt(pixel);
    // Bilinear over the four nearest small texels, each weighted down by how
    // far its depth is from this pixel's, so a shaft behind a rock does not
    // spill over the rock's edge.
    vec2 p = (gl_FragCoord.xy - rect.xy) / factor - 0.5;
    vec2 base = floor(p);
    vec2 f = p - base;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    vec3 nearest = vec3(0.0);
    float nearestGap = 1e9;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
      vec4 tap = texture2D(tShafts, (clamp(base + o, vec2(0.0), smallSize - 1.0) + 0.5) / smallSize);
      vec2 w2 = mix(1.0 - f, f, o);
      float gap = abs(tap.a - depth);
      float w = w2.x * w2.y / (1.0 + gap / (depth * ${f(DEPTH_TOLERANCE)}));
      sum += tap.rgb * w;
      total += w;
      if (gap < nearestGap) { nearestGap = gap; nearest = tap.rgb; }
    }
    vec3 add = total > 1e-4 ? sum / total : nearest;
    if (max(add.r, max(add.g, add.b)) < ${f(VISIBLE)}) discard;
    vec3 own = sRGBTransferEOTF(texelFetch(tColor, pixel, 0)).rgb;
    // Screened rather than summed, so the brightest air rolls off toward
    // white instead of clipping at it.
    vec3 c = 1.0 - (1.0 - own) * (1.0 - min(add, vec3(1.0)));
    gl_FragColor = sRGBTransferOETF(vec4(c, 1.0));
  }`;

function f(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

function viewZUniforms(): Record<string, THREE.IUniform> {
  return {
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 400 },
    orthographic: { value: false },
  };
}

function marchMaterial(shadowed: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: MARCH_FRAGMENT,
    defines: shadowed ? { SHADOWED: "" } : {},
    uniforms: {
      ...viewZUniforms(),
      tShadow: { value: null },
      viewToShadow: { value: new THREE.Matrix4() },
      shadowSoftness: { value: 0 },
      projectionInverse: { value: new THREE.Matrix4() },
      rect: { value: new THREE.Vector4() },
      factor: { value: 2 },
      apex: { value: new THREE.Vector3() },
      axis: { value: new THREE.Vector3() },
      across: { value: new THREE.Vector3() },
      across2: { value: new THREE.Vector3() },
      coneCos: { value: 1 },
      penumbraCos: { value: 1 },
      coneTan: { value: 0 },
      reach: { value: 1 },
      light: { value: new THREE.Vector3() },
      phase: { value: 0 },
      time: { value: 0 },
      fogMode: { value: 0 },
      fogDensity: { value: 0 },
      fogNear: { value: 0 },
      fogFar: { value: 1 },
    },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    // Each shaft adds its light; the alpha is the depth, the same from every
    // shaft, so it is written rather than summed.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.ZeroFactor,
  });
}

export class LightShafts {
  private factor = 2;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly fittedTo = new THREE.Vector2();
  // One program with the shadow map and one without: a shadow sampler cannot
  // be left unbound or bound to an ordinary texture.
  private readonly shadowedMaterial = marchMaterial(true);
  private readonly plainMaterial = marchMaterial(false);
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: COMPOSITE_FRAGMENT,
    uniforms: {
      ...viewZUniforms(),
      tColor: { value: null },
      tShafts: { value: null },
      smallSize: { value: new THREE.Vector2() },
      rect: { value: new THREE.Vector4() },
      factor: { value: 2 },
    },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  private readonly marchQuad = new FullScreenQuad(this.plainMaterial);
  private readonly compositeQuad = new FullScreenQuad(this.compositeMaterial);
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly apex = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();
  // This frame's `SHAFT_FOG_TINT`, from the scene's fog.
  private readonly tint = new THREE.Color();
  // The shafts in view this frame, chosen by `select`.
  private readonly inView: Shaft[] = [];

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  // Which of `shafts` this view can see, kept for `render`; true when any.
  // Before the frame is drawn, so a frame with none in view keeps no depth.
  // Also where every shaft's glow lights are set for the frame (in view or
  // not: a shaft just off screen still lights the rock that is on it), which
  // is why it takes the fog.
  select(
    shafts: readonly Shaft[],
    camera: THREE.Camera,
    fog: THREE.Fog | THREE.FogExp2 | null,
  ): boolean {
    this.inView.length = 0;
    if (shafts.length === 0) return false;
    this.tint.setRGB(1, 1, 1);
    if (fog) {
      const c = fog.color;
      const top = Math.max(c.r, c.g, c.b);
      if (top > 0) {
        this.tint.setRGB(c.r / top, c.g / top, c.b / top);
        this.tint.lerp(WHITE, 1 - SHAFT_FOG_TINT);
      }
    }
    for (const s of shafts) {
      const on = s.light.visible ? s.level : 0;
      for (const g of s.glow) {
        g.color.copy(s.light.color).multiply(this.tint);
        g.intensity = s.glowIntensity * on;
      }
    }
    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    for (const s of shafts) {
      if (s.level <= 0 || !s.light.visible) continue;
      this.cone(s);
      const far = s.range * Math.tan(s.light.angle);
      this.sphere.center.copy(this.apex).addScaledVector(this.aim, s.range / 2);
      this.sphere.radius = Math.hypot(s.range / 2, far + SHAFT_HALO_RADIUS * 4);
      if (this.frustum.intersectsSphere(this.sphere)) this.inView.push(s);
    }
    return this.inView.length > 0;
  }

  // The selected shafts added to `frame`, which has just had the scene drawn
  // into it with its depth resolved. `rect` is the viewport inside it, in
  // device pixels, bottom-left origin.
  render(
    frame: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    fog: THREE.Fog | THREE.FogExp2 | null,
    clock: number,
    rect: { x: number; y: number; w: number; h: number },
  ): void {
    if (this.inView.length === 0) return;
    const r = this.renderer;
    this.fitTarget(rect.w, rect.h);
    const target = this.target!;
    const orthographic = camera instanceof THREE.OrthographicCamera;
    camera.updateMatrixWorld();

    const autoClear = r.autoClear;
    const autoReset = r.info.autoReset;
    const resolveDepth = frame.resolveDepthBuffer;
    r.getClearColor(this.clearColor);
    const clearAlpha = r.getClearAlpha();
    r.info.autoReset = false;
    try {
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.autoClear = false;
      for (const s of this.inView) {
        const shadowMap = s.light.castShadow ? s.light.shadow.map?.depthTexture : null;
        const m = shadowMap ? this.shadowedMaterial : this.plainMaterial;
        const u = m.uniforms;
        u.tDepth!.value = frame.depthTexture;
        u.cameraNear!.value = camera.near;
        u.cameraFar!.value = camera.far;
        u.orthographic!.value = orthographic;
        (u.projectionInverse!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
        (u.rect!.value as THREE.Vector4).set(rect.x, rect.y, rect.w, rect.h);
        u.factor!.value = this.factor;
        this.cone(s);
        const view = camera.matrixWorldInverse;
        (u.apex!.value as THREE.Vector3).copy(this.apex).applyMatrix4(view);
        const axis = (u.axis!.value as THREE.Vector3).copy(this.aim).transformDirection(view);
        // Any two directions square to the axis and each other: the rays'
        // azimuth is measured in them.
        const across = (u.across!.value as THREE.Vector3)
          .copy(Math.abs(axis.x) < 0.9 ? X : Y)
          .cross(axis)
          .normalize();
        (u.across2!.value as THREE.Vector3).crossVectors(axis, across);
        u.coneCos!.value = Math.cos(s.light.angle);
        u.penumbraCos!.value = Math.cos(s.light.angle * (1 - s.light.penumbra));
        u.coneTan!.value = Math.tan(s.light.angle);
        u.reach!.value = s.range;
        const level = s.level * SHAFT_GAIN;
        (u.light!.value as THREE.Vector3).set(
          s.light.color.r * this.tint.r * level,
          s.light.color.g * this.tint.g * level,
          s.light.color.b * this.tint.b * level,
        );
        u.phase!.value = s.phase;
        u.time!.value = clock;
        if (fog instanceof THREE.FogExp2) {
          u.fogMode!.value = 2;
          u.fogDensity!.value = fog.density;
        } else if (fog instanceof THREE.Fog) {
          u.fogMode!.value = 1;
          u.fogNear!.value = fog.near;
          u.fogFar!.value = fog.far;
        } else {
          u.fogMode!.value = 0;
        }
        if (shadowMap) {
          u.tShadow!.value = shadowMap;
          // The map spans the cone's full angle, 2 tan(angle) at unit
          // distance across 1 of uv.
          u.shadowSoftness!.value = SHAFT_SHADOW_SOFTNESS / (2 * Math.tan(s.light.angle));
          (u.viewToShadow!.value as THREE.Matrix4).multiplyMatrices(
            s.light.shadow.matrix,
            camera.matrixWorld,
          );
        }
        this.marchQuad.material = m;
        this.marchQuad.render(r);
      }

      // Into the frame's own samples, only where a shaft adds something. Its
      // depth is the scene's and stays resolved as it is.
      const c = this.compositeMaterial.uniforms;
      c.tDepth!.value = frame.depthTexture;
      c.cameraNear!.value = camera.near;
      c.cameraFar!.value = camera.far;
      c.orthographic!.value = orthographic;
      c.tColor!.value = frame.texture;
      c.tShafts!.value = target.texture;
      (c.smallSize!.value as THREE.Vector2).set(target.width, target.height);
      (c.rect!.value as THREE.Vector4).set(rect.x, rect.y, rect.w, rect.h);
      c.factor!.value = this.factor;
      r.setRenderTarget(frame);
      frame.resolveDepthBuffer = false;
      this.compositeQuad.render(r);
    } finally {
      frame.resolveDepthBuffer = resolveDepth;
      r.autoClear = autoClear;
      r.info.autoReset = autoReset;
      r.setClearColor(this.clearColor, clearAlpha);
    }
  }

  dispose(): void {
    this.freeTarget();
    this.shadowedMaterial.dispose();
    this.plainMaterial.dispose();
    this.compositeMaterial.dispose();
    this.marchQuad.dispose();
    this.compositeQuad.dispose();
  }

  // The spot's lamp and aim in world space, into `apex` and `aim`.
  private cone(s: Shaft): void {
    s.light.updateWorldMatrix(true, false);
    s.light.target.updateWorldMatrix(true, false);
    this.apex.setFromMatrixPosition(s.light.matrixWorld);
    this.scratch.setFromMatrixPosition(s.light.target.matrixWorld);
    this.aim.subVectors(this.scratch, this.apex).normalize();
  }

  // The small target for a viewport of w x h, made on first use and remade
  // when the viewport is resized.
  private fitTarget(w: number, h: number): void {
    if (this.target && this.fittedTo.x === w && this.fittedTo.y === h) return;
    this.freeTarget();
    this.fittedTo.set(w, h);
    this.factor = Math.min(MAX_FACTOR, Math.max(2, Math.round(h / SHAFT_LINES)));
    // Half float: linear light, and the depth in the alpha.
    this.target = new THREE.WebGLRenderTarget(Math.ceil(w / this.factor), Math.ceil(h / this.factor), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
  }

  private freeTarget(): void {
    this.target?.dispose();
    this.target = null;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
