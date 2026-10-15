// The berry of a berry vine and its leafy cap (`starberryVisual.ts`). The
// shape is karin-lu's round lantern berry (`add-boulder-and-root-generation`,
// f831e14); the flesh and the cap follow Tris's reference: a dark, translucent
// amber fruit with a faint light glowing at its heart, pale flecks suspended
// in it catching that light, under a cap of leaves stacked on it and on each
// other, their tips flaring out (`berryCapGeometry`).

import * as THREE from "three";
import { STALK_KNOT_HEIGHT, STALK_RADIUS } from "../render/starberryArt";

const hash = (x: number, y: number, z: number): number => {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

// Flecks in the flesh, as directions on the unit sphere with a size and a
// brightness each.
const FLECKS = Array.from({ length: 360 }, (_, i) => {
  const u = hash(i, 1, 7) * 2 - 1;
  const phi = hash(i, 2, 9) * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return {
    x: s * Math.cos(phi),
    y: u,
    z: s * Math.sin(phi),
    size: 0.012 + Math.pow(hash(i, 3, 5), 2) * 0.04,
    strength: 0.35 + hash(i, 4, 3) * 0.65,
  };
});

// The flecks as a map over the berry's UVs: 0 in the flesh, up to 1 at a
// fleck's heart. Data, not colour (`NoColorSpace`): the berry's shader reads
// it as how much fleck is there (`roundBerryMaterial`).
export function roundBerryTexture(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // three's SphereGeometry UV: u around from -x, v from the bottom pole.
      const phi = (x / (width - 1)) * Math.PI * 2;
      const theta = (1 - y / (height - 1)) * Math.PI;
      const nx = -Math.cos(phi) * Math.sin(theta);
      const ny = Math.cos(theta);
      const nz = Math.sin(phi) * Math.sin(theta);
      let fleck = 0;
      for (const f of FLECKS) {
        const d = 1 - (nx * f.x + ny * f.y + nz * f.z);
        if (d > f.size * f.size * 2) continue;
        const r = Math.sqrt(2 * d) / f.size;
        fleck = Math.max(fleck, f.strength * (1 - r * r));
      }
      const at = (y * width + x) * 4;
      const v = Math.round(255 * fleck);
      pixels[at] = pixels[at + 1] = pixels[at + 2] = v;
      pixels[at + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// One berry's material: a dark glossy skin over flesh lit from inside. The
// light is computed rather than mapped, by how square the surface faces the
// eye - so it is always at the berry's heart whichever way the stalk has
// turned it: a deep amber body darkening to the rim, a faint warm glow at the
// centre, and the flecks lit by it, brightest where it is. `glow` scales all
// of it (the vine's glow setting and the grab pulse).
//
// The colours are linear radiance chosen for the scene's ACES Filmic curve
// (`configureRenderer`): it lifts and bleaches anything bright, so a dark
// translucent fruit is said in small numbers.
export function roundBerryMaterial(flecks: THREE.Texture): {
  material: THREE.MeshStandardMaterial;
  glow: { value: number };
} {
  const glow = { value: 1 };
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a1004,
    // White, so the map's value comes through untouched (see the shader).
    emissive: 0xffffff,
    emissiveMap: flecks,
    roughness: 0.24,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.berryGlow = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float berryGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float berryFleck = totalEmissiveRadiance.r;
        float berryFacing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        vec3 berryLight = mix(vec3(0.05, 0.014, 0.002), vec3(0.13, 0.045, 0.005), smoothstep(0.0, 0.85, berryFacing));
        berryLight += vec3(0.6, 0.22, 0.04) * pow(berryFacing, 9.0);
        berryLight += vec3(0.34, 0.16, 0.03) * berryFleck * pow(berryFacing, 2.0);
        totalEmissiveRadiance = berryLight * berryGlow;`,
      );
  };
  material.customProgramCacheKey = () => "translucent-berry";
  return { material, glow };
}

// A softly asymmetric, slightly oval berry with a rounded bottom (karin's).
function berryShape(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    p.setXYZ(i, x * (0.91 + 0.04 * y + 0.02 * z) + 0.025 * (1 - y * y), y + 0.015 * (1 - y * y) * x, z * 0.92);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

export function roundBerryGeometry(): THREE.BufferGeometry {
  return berryShape(new THREE.SphereGeometry(1, 48, 32));
}

// The cap's leaves, after Tris's reference: long pointed leaves, each folded
// along a raised midrib, rising out of the stalk on top of the berry, arching
// down over its shoulder and curling their tips out and up - a crown wider
// than the berry's top. They DRAPE: each leaf is laid over the fruit and over
// every leaf laid before it, so it rests on what is under it along its length
// and across its width, follows the edge of the leaf it overlaps, and never
// stands off into the air except at its tip. Painted by the standard vine's
// leaf material (`makeVineLeafMaterial`: its veins, mottle and light through
// the leaf), in the reference's muted olives, yellowing toward the tip.
// Every berry's cap is its own (the vine's seed and the berry's index): how
// many leaves, where each stands round the stalk, its length, width, bow,
// fold and curl, and its green.

// Olive greens, linear (sRGB ~#3f4c1c, #56662a, #6f7e35), and the yellower
// olive the tips turn toward (~#8e9440).
const LEAF_OLIVES = [
  [0.049, 0.072, 0.012],
  [0.092, 0.133, 0.024],
  [0.159, 0.209, 0.036],
] as const;
const LEAF_TIP = [0.27, 0.3, 0.05] as const;

// The cap's tiers, laid bottom first: how many leaves (the least, and how many
// more), how far down the fruit they run (radians of arc, and the spread), the
// leaf's greatest half-width as a share of its length, how far the tip curls
// off (berry radii), and the green it leans to (0 dark to 1 light).
const CAP_TIERS = [
  { count: 6, extra: 2, reach: 1.0, reachSpread: 0.12, width: 0.21, curl: 0.22, light: 0.3 },
  { count: 5, extra: 2, reach: 0.8, reachSpread: 0.1, width: 0.22, curl: 0.14, light: 0.55 },
  { count: 3, extra: 1, reach: 0.55, reachSpread: 0.08, width: 0.22, curl: 0.06, light: 0.8 },
] as const;
// How far out from the stalk's axis a leaf's base grips the knot, in stalk
// radii: just outside the knot's swelling (`roundBerryKnot`).
const KNOT_GRIP = 1.7;
// A leaf's thickness, in berry radii (2.4 mm on the default 15 cm berry): how
// far a leaf lies above whatever it rests on.
const LEAF_THICKNESS = 0.016;
// How far the leaf's halves fall away from its midrib, as a share of its
// half-width: the fold that gives each leaf its keel.
const LEAF_FOLD = 0.3;
// The leaf mesh: rows along it, columns across (odd, so one runs down the
// midrib, which the vine material's veins are drawn along at u = 0.5).
const LEAF_ROWS = 22;
const LEAF_COLUMNS = 12;

// One leaf's centreline and outline over the fruit, in the berry's frame.
interface CapLeaf {
  phi: number;
  reach: number;
  width: number;
  bow: number;
  sweep: number;
  curl: number;
  // The leaf's radius at each mesh vertex, rows by columns: what a leaf laid
  // later reads to rest on it.
  radii: Float32Array;
}

// Where along the fruit the leaf's centreline is at `t` (radians from the
// top), out from under the knot.
function leafTheta(leaf: CapLeaf, t: number): number {
  return 0.12 + leaf.reach * t;
}

function leafAzimuth(leaf: CapLeaf, t: number): number {
  return leaf.phi + leaf.bow * Math.sin(Math.PI * t) + leaf.sweep * t;
}

// Half the leaf's width at `t`, radians of arc: a narrow base, widest a third
// of the way along, drawn to a long point.
function leafHalfWidth(leaf: CapLeaf, t: number): number {
  return leaf.width * leaf.reach * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.85) * (1 - 0.15 * t);
}

// The direction of the point `across` (-1 to 1) of the way across the leaf at
// `t`: its width laid round the fruit, not across a chord of it.
function leafDirection(leaf: CapLeaf, t: number, across: number, out: THREE.Vector3): THREE.Vector3 {
  const theta = leafTheta(leaf, t);
  const phi = leafAzimuth(leaf, t);
  const half = leafHalfWidth(leaf, t);
  out.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
  return out.addScaledVector(SIDEWAYS.set(-Math.sin(phi), 0, Math.cos(phi)), Math.tan(across * half)).normalize();
}
const SIDEWAYS = new THREE.Vector3();

// The top of whatever lies under direction `d` among `under`: the leaves
// already laid, found by inverting each one's centreline at d's angle from
// the top and its width there, and read off its own radii. 0 where none does.
function restingOn(under: readonly CapLeaf[], d: THREE.Vector3): number {
  const theta = Math.acos(Math.max(-1, Math.min(1, d.y)));
  const phi = Math.atan2(d.z, d.x);
  let top = 0;
  for (const leaf of under) {
    // The centreline only moves away from the top, so the `t` at `theta` is
    // a bisection.
    if (theta < leafTheta(leaf, 0) || theta > leafTheta(leaf, 1)) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (leafTheta(leaf, mid) < theta) lo = mid;
      else hi = mid;
    }
    const t = (lo + hi) / 2;
    const half = leafHalfWidth(leaf, t);
    if (half <= 1e-6) continue;
    let dphi = phi - leafAzimuth(leaf, t);
    dphi -= Math.round(dphi / (Math.PI * 2)) * Math.PI * 2;
    const across = Math.atan(Math.sin(theta) * Math.tan(dphi)) / half;
    if (Math.abs(across) > 1) continue;
    // Bilinear in the leaf's own mesh.
    const row = t * LEAF_ROWS;
    const column = ((across + 1) / 2) * LEAF_COLUMNS;
    const r0 = Math.min(LEAF_ROWS - 1, Math.floor(row));
    const c0 = Math.min(LEAF_COLUMNS - 1, Math.floor(column));
    const fr = row - r0;
    const fc = column - c0;
    const at = (r: number, c: number): number => leaf.radii[r * (LEAF_COLUMNS + 1) + c]!;
    const height =
      (at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc) * (1 - fr) +
      (at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc) * fr;
    top = Math.max(top, height);
  }
  return top;
}

// One berry's cap as one mesh, in the berry's own frame (radius 1, its
// growth axis +y). Carries the vine leaf material's per-instance attributes as
// per-vertex ones at rest (no shape, no turn, no wrap, no ring), its UVs as
// that material draws veins by (u across, the midrib at 0.5; v along), and
// its colour per vertex.
// `size` is the berry's radius (metres): the stalk is the same thickness on
// every berry, so where a leaf's base grips it, in the berry's units, depends
// on it.
export function berryCapGeometry(seed: number, berry: number, size: number): THREE.BufferGeometry {
  // The stalk's radius in berry radii.
  const stalk = STALK_RADIUS / size;
  const out = new THREE.Vector3();
  const around = new THREE.Vector3();
  const random = (leaf: number, salt: number): number => hash(seed * 0.0137 + berry * 7.31, leaf * 1.73 + salt, 3.3);
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const laid: CapLeaf[] = [];
  let leafIndex = 0;
  let phase = random(0, 3) * Math.PI * 2;
  for (const [tier, spec] of CAP_TIERS.entries()) {
    const n = spec.count + Math.floor(random(tier, 4) * (spec.extra + 1));
    // Each tier set between the leaves of the one under it.
    phase += Math.PI / n;
    for (let k = 0; k < n; k++, leafIndex++) {
      const r = (salt: number): number => random(leafIndex + 11, salt);
      const leaf: CapLeaf = {
        phi: phase + ((k + (r(1) - 0.5) * 0.4) * Math.PI * 2) / n,
        reach: spec.reach + spec.reachSpread * (r(2) - 0.5) * 2,
        width: spec.width * (0.85 + 0.3 * r(3)),
        bow: (r(4) - 0.5) * 0.22,
        sweep: (r(5) - 0.5) * 0.25,
        curl: spec.curl * (0.7 + 0.6 * r(6)),
        radii: new Float32Array((LEAF_ROWS + 1) * (LEAF_COLUMNS + 1)),
      };
      const pick = r(7) + (spec.light - 0.5) * 0.6;
      const tone = LEAF_OLIVES[pick < 0.35 ? 0 : pick < 0.75 ? 1 : 2];
      const shade = 0.75 + 0.25 * r(8);
      // A leaf is STIFF: each row across it is its folded section laid as one
      // piece, leaning (`lean`, radius per unit across) to sit on the highest
      // of whatever is under it rather than taking every bump, and along its
      // length it drapes smoothly over what it crosses rather than dipping
      // into every gap.
      const rows = LEAF_ROWS + 1;
      const columns = LEAF_COLUMNS + 1;
      const directions: THREE.Vector3[] = [];
      const support = new Float32Array(rows * columns);
      for (let row = 0; row < rows; row++) {
        const t = row / LEAF_ROWS;
        for (let column = 0; column < columns; column++) {
          const dir = leafDirection(leaf, t, (column / LEAF_COLUMNS) * 2 - 1, new THREE.Vector3());
          directions.push(dir);
          support[row * columns + column] = Math.max(1.004, restingOn(laid, dir) + LEAF_THICKNESS);
        }
      }
      const fold = (t: number, across: number): number => LEAF_FOLD * leafHalfWidth(leaf, t) * (1 - Math.abs(across));
      // The lowest the row's section can sit at a given lean.
      const seat = (row: number, lean: number): number => {
        const t = row / LEAF_ROWS;
        let h = -Infinity;
        for (let column = 0; column < columns; column++) {
          const across = (column / LEAF_COLUMNS) * 2 - 1;
          h = Math.max(h, support[row * columns + column]! - fold(t, across) - lean * across);
        }
        return h;
      };
      const lean = new Float32Array(rows);
      for (let row = 0; row < rows; row++) {
        let best = Infinity;
        for (let i = -6; i <= 6; i++) {
          const h = seat(row, i * 0.02);
          if (h < best) {
            best = h;
            lean[row] = i * 0.02;
          }
        }
      }
      // The lean eased along the leaf, which bends it gently rather than
      // twisting it row by row; then each row seated at that lean.
      const eased = lean.map((_, row) => {
        const a = lean[Math.max(0, row - 1)]!;
        const b = lean[Math.min(rows - 1, row + 1)]!;
        return 0.25 * a + 0.5 * lean[row]! + 0.25 * b;
      });
      const seated = eased.map((value, row) => seat(row, value));
      // Draped: eased along its length so it bends rather than kinks over
      // what it crosses, and never below a seat.
      let height = seated;
      for (let pass = 0; pass < 4; pass++) {
        height = height.map((value, row) =>
          Math.max(
            seated[row]!,
            0.25 * height[Math.max(0, row - 1)]! + 0.5 * value + 0.25 * height[Math.min(rows - 1, row + 1)]!,
          ),
        );
      }
      const start = positions.length / 3;
      for (let row = 0; row < rows; row++) {
        const t = row / LEAF_ROWS;
        // Rising out of the stalk at the base, and curling off what it rests
        // on at the tip, late and sharply.
        const rise = 0.06 * Math.pow(Math.max(0, 1 - t / 0.25), 2);
        const tip = Math.max(0, (t - 0.55) / 0.45);
        const curl = leaf.curl * tip * tip;
        for (let column = 0; column < columns; column++) {
          const across = (column / LEAF_COLUMNS) * 2 - 1;
          const dir = directions[row * columns + column]!;
          const lying = height[row]! + eased[row]! * across + fold(t, across) + rise;
          const radius = lying + curl * 0.6;
          // What a later leaf rests on is the leaf where it LIES: its curled
          // tip is in free air, and nothing is laid on that.
          leaf.radii[row * columns + column] = lying;
          // The curl turns the tip out AND up, back toward the stalk, as the
          // reference's tips turn.
          let x = dir.x * radius;
          let y = dir.y * radius + curl;
          let z = dir.z * radius;
          // The base GROWS OUT OF THE STALK: blended from where the leaf lies
          // to a collar round the knot (`roundBerryKnot`), wrapped part way
          // round it - each tier a little higher up the knot than the one
          // under it, as the inner leaves are.
          const grip = 1 - THREE.MathUtils.smoothstep(t, 0, 0.32);
          if (grip > 0) {
            const phi = leafAzimuth(leaf, 0);
            out.set(Math.cos(phi), 0, Math.sin(phi));
            around.set(-Math.sin(phi), 0, Math.cos(phi));
            const collar = stalk * (KNOT_GRIP + 0.25 * tier);
            const wrap = across * 0.45;
            const cx = (out.x * Math.cos(wrap) + around.x * Math.sin(wrap)) * collar;
            const cz = (out.z * Math.cos(wrap) + around.z * Math.sin(wrap)) * collar;
            const cy = 1 + stalk * (0.4 + 0.75 * tier);
            x += (cx - x) * grip;
            y += (cy - y) * grip;
            z += (cz - z) * grip;
          }
          positions.push(x, y, z);
          uvs.push(column / LEAF_COLUMNS, t);
          // Darker at the base, yellowing toward the tip; the midrib a shade
          // lighter.
          const yellow = 0.35 * t * t;
          const rib = column === LEAF_COLUMNS / 2 ? 1.12 : 1;
          colors.push(
            (tone[0] * shade * (1 - yellow) + LEAF_TIP[0] * yellow) * rib,
            (tone[1] * shade * (1 - yellow) + LEAF_TIP[1] * yellow) * rib,
            (tone[2] * shade * (1 - yellow) + LEAF_TIP[2] * yellow) * rib,
          );
        }
      }
      for (let row = 0; row < LEAF_ROWS; row++) {
        for (let column = 0; column < LEAF_COLUMNS; column++) {
          const a = start + row * (LEAF_COLUMNS + 1) + column;
          const b = a + LEAF_COLUMNS + 1;
          indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
      laid.push(leaf);
    }
  }
  const g = new THREE.BufferGeometry();
  const count = positions.length / 3;
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute("leafShape", new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  g.setAttribute("leafFaceTurn", new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  const wrap = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) wrap.set([0, 1, 1, 0], i * 4);
  g.setAttribute("leafWrap", new THREE.Float32BufferAttribute(wrap, 4));
  g.setAttribute("leafRing", new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// The knot: the stalk's end swelling into the top of the berry, in STALK
// radii (`STALK_RADIUS`), its origin on the berry's top and +y up the stalk -
// placed there and scaled by the stalk, not the berry, so it is the stalk's
// own thickness on every berry. The leaves' bases grip it (`KNOT_GRIP`).
export function roundBerryKnot(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const rings = [
    [1.6, -1.2],
    [1.75, 0],
    [1.55, 1.2],
    [1.25, 2.2],
    [1.0, STALK_KNOT_HEIGHT / STALK_RADIUS],
  ];
  const around = 14;
  for (const [ring, [radius, height]] of rings.entries()) {
    for (let i = 0; i <= around; i++) {
      const angle = (i / around) * Math.PI * 2;
      const wobble = 1 + 0.06 * Math.sin(angle * 3 + ring);
      positions.push(Math.cos(angle) * radius! * wobble, height!, Math.sin(angle) * radius! * wobble);
      if (ring < rings.length - 1 && i < around) {
        const a = ring * (around + 1) + i;
        const b = a + around + 1;
        // Wound to face out of the collar.
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  // Closed at the top, where the stalk runs into it.
  const top = positions.length / 3;
  positions.push(0, rings.at(-1)![1]!, 0);
  const last = (rings.length - 1) * (around + 1);
  for (let i = 0; i < around; i++) indices.push(last + i, top, last + i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
