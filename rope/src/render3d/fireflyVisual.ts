// The fireflies made visible: every mote of every swarm in the level, drawn as
// one `THREE.Points` in world space (see `fireflies.ts` for how they fly, and
// `LightRig` for the light they throw).
//
// ONE draw for the whole level, built at `setLevel` with a vertex per mote and
// never resized while the level is loaded, so `Scene3D.prewarm` compiles its
// program under the loading screen and a played frame writes two small
// attribute buffers and nothing else. In world space rather than under a body,
// because a swarm leaves its body the moment it notices the ball.
//
// A mote is a point sprite sized in METRES (the beams' dust rule, see
// `beam.ts`): a hot core that tone-maps toward white, inside a soft halo in the
// swarm's colour. Additive, depth-tested (a mote behind a rock is hidden by it)
// and not depth-written (motes never hide each other), and dimmed by the fog as
// attenuation like every other additive light here.

import * as THREE from "three";
import { FOG_ATTENUATE } from "./beam";
import type { Swarm } from "./fireflies";

// The sprite's size in metres: the halo's diameter. The core is the middle of
// it, falling to 1/e at FIREFLY_CORE of the radius - about 5 cm across on the
// larger sprites, which is bigger than a firefly and is what keeps one a
// readable point at the camera's widest framing (~125 px/m, where the first
// cut's 1.5 cm core was a pixel).
export const FIREFLY_SPRITE: readonly [number, number] = [0.2, 0.3];
const FIREFLY_CORE = 0.18;
// How far past its colour the core is pushed before tone mapping, so it reads
// as a hot point rather than a flat dot.
const FIREFLY_CORE_BOOST = 2.2;
// The halo's strength against the core's.
const FIREFLY_HALO = 0.45;

// Above the beams (12), so a swarm flying through a shaft is drawn over its
// dust rather than sorted under it.
const FIREFLY_RENDER_ORDER = 13;

export interface DrawnSwarm {
  // Null until the rig has read the swarm's home and hatched it.
  swarm: Swarm | null;
  count: number;
  color: THREE.Color;
}

export class FireflyVisual {
  readonly root: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly position: THREE.BufferAttribute;
  private readonly bright: THREE.BufferAttribute;

  constructor(
    private readonly swarms: readonly DrawnSwarm[],
    viewHalfHeight: { value: number },
  ) {
    const total = swarms.reduce((n, s) => n + s.count, 0);
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(total * 3), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.bright = new THREE.BufferAttribute(new Float32Array(total), 1);
    this.bright.setUsage(THREE.DynamicDrawUsage);
    const color = new Float32Array(total * 3);
    const size = new Float32Array(total);
    let v = 0;
    for (const s of swarms) {
      for (let i = 0; i < s.count; i++, v++) {
        color[v * 3] = s.color.r;
        color[v * 3 + 1] = s.color.g;
        color[v * 3 + 2] = s.color.b;
        // Seeded by position in the level, not random: the same level draws the
        // same swarm, and a headless grab is reproducible.
        const u = fract(Math.sin(v * 12.9898 + 4.1414) * 43758.5453);
        size[v] = FIREFLY_SPRITE[0] + (FIREFLY_SPRITE[1] - FIREFLY_SPRITE[0]) * u;
      }
    }
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("aBright", this.bright);
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.material = fireflyMaterial(viewHalfHeight);
    this.root = new THREE.Points(this.geometry, this.material);
    this.root.name = "fireflies";
    // The motes fly wherever the ball goes, so the bounding sphere computed at
    // build is wrong a second later; the draw is one call either way.
    this.root.frustumCulled = false;
    this.root.renderOrder = FIREFLY_RENDER_ORDER;
    this.root.raycast = () => {};
  }

  // Copy every hatched swarm's motes into the buffers. A swarm not yet hatched
  // draws nothing (brightness 0).
  update(): void {
    const pos = this.position.array as Float32Array;
    const bright = this.bright.array as Float32Array;
    let v = 0;
    for (const s of this.swarms) {
      if (s.swarm) {
        pos.set(s.swarm.positions, v * 3);
        bright.set(s.swarm.brightness, v);
      } else {
        bright.fill(0, v, v + s.count);
      }
      v += s.count;
    }
    this.position.needsUpdate = true;
    this.bright.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

function fract(v: number): number {
  return v - Math.floor(v);
}

// A number as a GLSL float literal (`1` is an int in GLSL).
function f(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

function fireflyMaterial(viewHalfHeight: { value: number }): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      uniform float uViewHalfHeight;
      attribute float aBright;
      attribute vec3 aColor;
      attribute float aSize;
      varying float vBright;
      varying vec3 vColor;
      void main() {
        vBright = aBright;
        vColor = aColor;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = aBright > 0.0 ? aSize * projectionMatrix[1][1] * uViewHalfHeight / -mvPosition.z : 0.0;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying float vBright;
      varying vec3 vColor;
      void main() {
        // 0 at the sprite's centre, 1 at its rim.
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = exp(-d * d * ${f(1 / (FIREFLY_CORE * FIREFLY_CORE))});
        float halo = exp(-d * d * 7.0) * (1.0 - d);
        float a = (core + ${f(FIREFLY_HALO)} * halo) * vBright;
        ${FOG_ATTENUATE}
        if (a < 0.002) discard;
        vec3 color = mix(vColor, vec3(1.0), core * 0.5) * (1.0 + ${f(FIREFLY_CORE_BOOST)} * core);
        gl_FragColor = vec4(color, min(a, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  // By REFERENCE after the merge (which clones): the rig writes the viewport
  // once a frame for the beams and the motes at once.
  material.uniforms.uViewHalfHeight = viewHalfHeight;
  return material;
}
