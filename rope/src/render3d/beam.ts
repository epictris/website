// A spot light's beam made visible: the lit air inside the spot's own cone
// (the shaft), and dust drifting in it.
//
// NOTHING NEW TO PLACE, AND NOTHING THAT CAN DISAGREE WITH THE LIGHT. The beam
// is not an object of its own with a position and a direction that could drift
// off the lamp it belongs to. The shaft is read straight off the spot itself
// (its place, aim, `range`, cone, penumbra, colour and shadow map) by
// `lightShafts.ts`, which draws it as lit fog; the dust is one draw hung on the
// spot's own holder (see `LightRig.add`). Both flicker with its intensity.
// `beam` and `dust` on `LightObjectData` say only how much of each shows.
//
// A shaft that should stop at a floor is authored with a `range` that stops
// there, or let the spot cast shadows: the shaft is then cut by whatever stands
// in its light, the way the reference's cave mouth cuts its beams. Screen-space
// god rays were rejected because they need the source on screen, and the
// camera never stops panning.
//
// Until 2026-10-05 the shaft was an additive cone MESH here, which the fog
// attenuated like a surface and the depth of field could not place; see
// `lightShafts.ts` for why it became a volume.
//
// Everything moving is a pure function of the clock and a seed, like the
// water's spray (`water.ts`): no CPU update beyond two shared uniforms, nothing
// to reset, and a pinned clock (`Scene3D.pinClock`) draws the same beam twice.

import * as THREE from "three";

// The dust's cone's radius at the lamp, in metres: a point source is a
// degenerate cone, and dust seeded in a disc the size of a lamp's lens is also
// what a lamp looks like.
export const BEAM_SOURCE_RADIUS = 0.06;

// Along the cone, as fractions of `range`: the beam fades IN from nothing at the
// lamp to full by BEAM_FADE_IN, and eases OUT from BEAM_FADE_OUT_FROM to nothing
// at the reach, so the shaft dies in the air rather than at a rim.
export const BEAM_FADE_IN = 0.1;
export const BEAM_FADE_OUT_FROM = 0.35;

// The rays: two octaves of a smooth wave around the cone's azimuth, drifting
// slowly with the clock, so the shaft reads as a bundle of soft rays rather
// than one flat cone even where no shadow breaks it up. Integer counts, so the
// waves close on themselves with no seam; a depth, the fraction of the
// brightness the darkest gap loses; and a drift in radians per second. No
// grain: the rule in docs/art-style.md stands.
export const BEAM_RAYS = 7;
export const BEAM_RAYS_FINE = 17;
export const BEAM_RAY_DEPTH = 0.55;
export const BEAM_RAY_DRIFT = 0.05;

// The dust. Motes per metre of beam at `dust = 1`, and a cap on one beam's
// count so a 30 m shaft does not become thirty thousand points.
export const DUST_PER_METRE = 60;
export const DUST_MAX = 1500;
// A mote's size in metres (drawn in metres, the spray's `uViewHalfHeight`
// rule), its speed along the beam away from the lamp in metres per second, and
// how far it wanders sideways and how fast.
export const DUST_SIZE: readonly [number, number] = [0.014, 0.034];
export const DUST_FALL: readonly [number, number] = [0.01, 0.045];
export const DUST_WANDER = 0.05;
export const DUST_WANDER_RATE: readonly [number, number] = [0.12, 0.45];
// A mote's brightness at `dust = 1` on the beam's axis.
export const DUST_ALPHA = 0.85;

// Above the water's spray (11), so dust falling on a fall is drawn over its
// mist rather than sorted under it.
const BEAM_RENDER_ORDER = 12;

// The cone's radius at the end of its reach: the pool a spot of this cone
// throws on a surface `range` away. `angle` is the spot's HALF-angle in
// degrees, as `LightObjectData.angle` is.
export function beamFarRadius(range: number, angleDeg: number): number {
  return range * Math.tan((angleDeg * Math.PI) / 180);
}

// The cone's radius `along` (0 at the lamp, 1 at the reach) of the way down.
export function beamRadiusAt(along: number, sourceRadius: number, farRadius: number): number {
  return sourceRadius + (farRadius - sourceRadius) * along;
}

// How many motes a beam carries.
export function dustCount(dust: number, range: number): number {
  return Math.min(DUST_MAX, Math.round(clamp01(dust) * DUST_PER_METRE * range));
}

// The cone's frame: the lamp at the origin and the axis down -y, the direction
// `LightRig` turns onto the spot's aim. A mote's seed is (along, radial, turn,
// rate), each in 0..1, and its position at time 0 is where the seed puts it:
// `along` of the way down the axis, at a radius up to the cone's there (the
// square root makes the disc uniformly filled rather than crowded at its
// centre), at `turn` of a full turn around it. The shader moves it on from
// there and keeps it inside the same cone.
//
// Exported, and pure, so `cli render3d` can hold every seed to the cone.
export function seedDust(
  count: number,
  range: number,
  sourceRadius: number,
  farRadius: number,
  seed: number,
): { positions: Float32Array; seeds: Float32Array } {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  // A fixed pseudo-random sequence per light, so two builds of the same level
  // are the same dust and a headless grab is reproducible.
  let s = (Math.floor(seed * 7919) + 1234567) & 0x7fffffff;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    const along = rnd();
    const radial = rnd();
    const turn = rnd();
    const rate = rnd();
    const r = Math.sqrt(radial) * beamRadiusAt(along, sourceRadius, farRadius);
    const a = turn * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = -along * range;
    positions[i * 3 + 2] = Math.sin(a) * r;
    seeds.set([along, radial, turn, rate], i * 4);
  }
  return { positions, seeds };
}

// A spot whose air shows, as `lightShafts.ts` draws it: everything else (place,
// aim, cone, penumbra, colour, shadow) is read off the light every frame.
export interface Shaft {
  light: THREE.SpotLight;
  range: number;
  // `beam` times the light's current flicker fraction.
  level: number;
  phase: number;
  // The lit air lighting the surfaces around it (see SHAFT_SURFACE_GLOW), and
  // each light's intensity at level 1.
  glow: THREE.PointLight[];
  glowIntensity: number;
}

// THE LIT AIR LIGHTS ITS SURROUNDINGS: a shaft is a long glowing body of fog,
// and the rock beside it is lit by it, the way a skylit cave's walls are bright
// around the beam (Tris, 2026-10-05). Three shadowless point lights down the
// axis, at these fractions of the reach (inside the length fade, where the
// shaft is brightest), share SHAFT_SURFACE_GLOW of the spot's intensity at
// `beam = 1`, each reaching SHAFT_GLOW_REACH metres past the cone's far
// radius. Shadowless, so they light the back of a rock too; their reach is
// what keeps that local. Three lights per beam is three more lights in every
// lit program, which is the price.
export const SHAFT_SURFACE_GLOW = 0.4;
export const SHAFT_GLOW_AT: readonly number[] = [0.2, 0.4, 0.6];
export const SHAFT_GLOW_REACH = 6;

// What a beam is built from: the spot itself, its own numbers, and the rig's
// clock.
export interface BeamSpec {
  light: THREE.SpotLight;
  range: number;
  angleDeg: number;
  color: THREE.Color;
  beam: number;
  dust: number;
  // The spot's aim in its holder's frame, unit length.
  dir: THREE.Vector3;
  // Per light, so two shafts side by side do not ripple in step.
  phase: number;
  // Shared by every beam in a rig and written once a frame (`LightRig.update`).
  time: { value: number };
  viewHalfHeight: { value: number };
}

export class Beam {
  // Hung on the spot's holder, turned so its -y is the spot's aim.
  readonly root = new THREE.Group();
  // The lit air, or null for a spot asking only for dust.
  readonly shaft: Shaft | null = null;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly dustLevel: { value: number } | null = null;
  private readonly beam: number;
  private readonly dust: number;

  constructor(spec: BeamSpec) {
    this.beam = clamp01(spec.beam);
    this.dust = clamp01(spec.dust);
    this.root.name = "beam";
    this.root.quaternion.setFromUnitVectors(DOWN, spec.dir);
    const far = beamFarRadius(spec.range, spec.angleDeg);
    const source = Math.min(BEAM_SOURCE_RADIUS, far);

    if (this.beam > 0) {
      // The lit air as a light on what is around it: shadowless points down
      // the axis where the shaft is brightest, coloured and driven each frame
      // by `LightShafts.select` (the fog's tint is the scene's, not the rig's).
      const glow: THREE.PointLight[] = [];
      const far = beamFarRadius(spec.range, spec.angleDeg);
      for (const along of SHAFT_GLOW_AT) {
        const g = new THREE.PointLight(0xffffff, 0, far + SHAFT_GLOW_REACH, 2);
        g.name = "beam-glow";
        g.castShadow = false;
        g.position.set(0, -along * spec.range, 0);
        this.root.add(g);
        glow.push(g);
      }
      this.shaft = {
        light: spec.light,
        range: spec.range,
        level: this.beam,
        phase: spec.phase,
        glow,
        glowIntensity: (spec.light.intensity * SHAFT_SURFACE_GLOW) / SHAFT_GLOW_AT.length,
      };
    }

    const count = dustCount(this.dust, spec.range);
    if (count > 0) {
      const { positions, seeds } = seedDust(count, spec.range, source, far, spec.phase);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 4));
      // Bounds around the whole cone rather than around wherever the motes
      // happen to have been seeded: the frustum test reads the sphere, and the
      // depth of field's "does this reach the sharp plane" reads the box.
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, -spec.range / 2, 0),
        Math.hypot(spec.range / 2, far),
      );
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(-far, -spec.range, -far),
        new THREE.Vector3(far, 0, far),
      );
      const level = { value: this.dust };
      const material = dustMaterial(spec, level, source, far);
      const points = new THREE.Points(geometry, material);
      points.name = "beam-dust";
      points.renderOrder = BEAM_RENDER_ORDER;
      points.raycast = noRaycast;
      this.root.add(points);
      this.geometries.push(geometry);
      this.materials.push(material);
      this.dustLevel = level;
    }
  }

  // The light's current intensity as a fraction of its authored one, so a
  // guttering lamp's beam and dust gutter with it.
  setLevel(fraction: number): void {
    if (this.shaft) this.shaft.level = this.beam * fraction;
    if (this.dustLevel) this.dustLevel.value = this.dust * fraction;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
  }
}

// A beam for a spot, or null when it asks for nothing visible: no beam and no
// dust, or no reach to draw one over. Every spot authored before the fields
// existed lands here, and so draws exactly what it drew.
export function buildBeam(spec: BeamSpec): Beam | null {
  if (!(spec.range > 0)) return null;
  if (clamp01(spec.beam) <= 0 && dustCount(spec.dust, spec.range) <= 0) return null;
  return new Beam(spec);
}

const DOWN = new THREE.Vector3(0, -1, 0);

function noRaycast(): void {}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// A number as a GLSL float literal (`1` is an int in GLSL).
function f(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

// Additive light seen through the level's haze: dimmed by the fraction of the
// fog a surface at this depth would take, computed exactly as three's own
// `fog_fragment` computes it. Mixing toward the fog colour instead would ADD
// fog colour wherever a mote is. Shared with the fireflies
// (`fireflyVisual.ts`), which are the same additive light in the same haze.
export const FOG_ATTENUATE = /* glsl */ `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    a *= 1.0 - fogFactor;
  #endif
`;

// Zero at the lamp, full by BEAM_FADE_IN, easing out to nothing at the reach.
const ALONG_FADE = /* glsl */ `
  float alongFade(float along) {
    return smoothstep(0.0, ${f(BEAM_FADE_IN)}, along) * (1.0 - smoothstep(${f(BEAM_FADE_OUT_FROM)}, 1.0, along));
  }
`;

// Attached by REFERENCE after the merge below (which clones): the rig writes the
// clock and the viewport once a frame for every beam at once, and `setLevel`
// writes this beam's level.
function shareUniforms(material: THREE.ShaderMaterial, spec: BeamSpec, level: { value: number }): void {
  material.uniforms.uTime = spec.time;
  material.uniforms.uViewHalfHeight = spec.viewHalfHeight;
  material.uniforms.uLevel = level;
}

function dustMaterial(
  spec: BeamSpec,
  level: { value: number },
  source: number,
  far: number,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uColor: { value: spec.color.clone() },
        uLength: { value: spec.range },
        uSourceRadius: { value: source },
        uFarRadius: { value: far },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform float uViewHalfHeight;
      uniform float uLevel;
      uniform float uLength;
      uniform float uSourceRadius;
      uniform float uFarRadius;
      attribute vec4 aSeed;
      varying float vBright;
      ${ALONG_FADE}
      void main() {
        // Away from the lamp at the mote's own few cm/s, wrapping back to the
        // lamp at the reach, where the length fade has already put it out.
        float fall = mix(${f(DUST_FALL[0])}, ${f(DUST_FALL[1])}, aSeed.w);
        float along = fract(aSeed.x + uTime * fall / uLength);
        float radius = mix(uSourceRadius, uFarRadius, along);
        float turn = aSeed.z * 6.28318530718;
        vec2 p = vec2(cos(turn), sin(turn)) * sqrt(aSeed.y) * radius;
        // A slow sideways wander, then back inside the cone if it strayed.
        float rate = mix(${f(DUST_WANDER_RATE[0])}, ${f(DUST_WANDER_RATE[1])}, fract(aSeed.w * 7.13));
        p += vec2(sin(uTime * rate + aSeed.x * 40.0), cos(uTime * rate * 0.83 + aSeed.y * 40.0)) * ${f(DUST_WANDER)};
        float reach = length(p);
        if (reach > radius) p *= radius / reach;
        float radial = radius > 0.0 ? length(p) / radius : 0.0;
        // Dim toward the cone's edge, out at either end, and a slow glint as
        // the mote tumbles.
        float glint = 0.6 + 0.4 * sin(uTime * (1.3 + 2.0 * aSeed.y) + aSeed.z * 30.0);
        vBright = uLevel * (1.0 - radial * radial) * alongFade(along) * glint;
        vec3 pos = vec3(p.x, -along * uLength, p.y);
        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float size = mix(${f(DUST_SIZE[0])}, ${f(DUST_SIZE[1])}, fract(aSeed.z * 3.7));
        gl_PointSize = size * projectionMatrix[1][1] * uViewHalfHeight / -mvPosition.z;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uColor;
      varying float vBright;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.1, d) * vBright * ${f(DUST_ALPHA)};
        ${FOG_ATTENUATE}
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  shareUniforms(material, spec, level);
  return material;
}
