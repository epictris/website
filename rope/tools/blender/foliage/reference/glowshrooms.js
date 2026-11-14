/**
 * glowshrooms.js — procedural glowing flora for three.js (r150+).
 *
 * Kinds: 'mushroom', 'lantern' (arched stalks with hanging glowing bulbs), 'fern' (glow ferns
 * with unfurling fiddleheads), 'reed' (blade tufts with glowing seed pods) and 'grove'
 * (a mushroom cluster with all of the plants around it).
 *
 *   const patch = generatePatch({ kind: 'mushroom', seed: 7, count: 14 });  // plain JSON
 *   patch.items[3].capRadius *= 1.4;              // edit any single item…
 *   resolveCollisions(patch, { locked: [3] });    // …and let the others make room
 *   const group = buildPatch(patch, { light: 1 });
 *   scene.add(group);
 *   updateGlowshrooms(time);                      // every frame: sway + glow pulse
 *
 * Nothing intersects: generatePatch runs a collision solver so no cap, stem, bulb, frond or
 * blade cuts into another item, the ground, the mound, or itself — with clearance for the
 * wind sway. Units are metres, Y up; a patch is centred on its origin.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);
const TAU = Math.PI * 2;

// ================================================================== palettes
export const PALETTES = {
  pastel: {
    caps: [['#f2a6e8', '#b591f6'], ['#f6ea8a', '#8ff2c8'], ['#c8a2ff', '#f5a2d8'], ['#a8f4e4', '#8ab6ff'],
           ['#ffb2cf', '#d59eff'], ['#d9f78f', '#f6a5dc'], ['#e4b0ff', '#9fd8ff']],
    stem: '#cbc5f3', glow: '#55f0ff', spot: '#fdf6ff',
    leaf: ['#7fe3c9', '#c9a6ff'], bulb: [['#ffb2e6', '#8ff4ff'], ['#f6ea8a', '#ffa6d6'], ['#c8a2ff', '#8ff2e4']],
    stalk: '#9fd9c4', reed: ['#a9d8f5', '#e7b8ff'],
  },
  moonlight: {
    caps: [['#a8ecff', '#5d86ff'], ['#c9f8ff', '#82d2ff'], ['#a9b7ff', '#7c68ff'], ['#9ff5ea', '#59a8ff']],
    stem: '#b7d5f6', glow: '#6ef7ff', spot: '#f2fbff',
    leaf: ['#79c9f2', '#a7a3ff'], bulb: [['#c9f8ff', '#7ccfff'], ['#b8c4ff', '#7fe8ff']],
    stalk: '#93b9e8', reed: ['#a9c4f2', '#b9f2ff'],
  },
  toxic: {
    caps: [['#dcff6c', '#3fdb8b'], ['#b4ff5c', '#27c79f'], ['#f2ff8a', '#7ce86a'], ['#9cf7c4', '#5fd05a']],
    stem: '#d6f0c6', glow: '#9dff57', spot: '#fbfff2',
    leaf: ['#5fd05a', '#d7ff6a'], bulb: [['#eaff8a', '#3fdb8b'], ['#b4ff5c', '#7cf7d0']],
    stalk: '#8fd68a', reed: ['#a7e39a', '#e9ff9a'],
  },
  ember: {
    caps: [['#ffb46b', '#ff5d7b'], ['#ffd37a', '#ff7a52'], ['#ff9fb0', '#ff6a3d'], ['#ffe39a', '#ff9a4d']],
    stem: '#f3d6c4', glow: '#ffae42', spot: '#fff6ec',
    leaf: ['#e0794a', '#ffcf7a'], bulb: [['#ffe39a', '#ff6a3d'], ['#ffb2a0', '#ffd37a']],
    stalk: '#c99a6c', reed: ['#e6b48f', '#ffd9a0'],
  },
};

// ================================================================== defaults per kind
export const DEFAULTS = {
  mushroom: {
    kind: 'mushroom', seed: 7, count: 14, spread: 0.32, depth: 0.6, size: 0.55, sizeVariety: 0.75,
    heightVariety: 0.35, lean: 0.6, bend: 0.5, dome: 0.42, domeVariety: 0.8, flare: 0.1, flareVariety: 0.7, capVariety: 0.6,
    separation: 1.0, tilt: 0.4, spots: 0.7, spotSize: 1.0, glow: 1.0, palette: 'pastel', mound: 0.5,
  },
  lantern: {
    kind: 'lantern', seed: 7, count: 5, spread: 0.45, depth: 0.6, size: 0.7, sizeVariety: 0.45, arch: 0.6,
    bulbSize: 1.0, bulbLength: 1.3, ribs: 8, leaves: 3, glow: 1.0, palette: 'pastel',
  },
  fern: {
    kind: 'fern', seed: 7, count: 2, spread: 0.5, depth: 0.6, size: 0.5, sizeVariety: 0.35, fronds: 9,
    tilt: 0.55, droop: 0.5, curl: 0.3, leaflets: 14, width: 1.0, glow: 1.0, palette: 'pastel',
  },
  reed: {
    kind: 'reed', seed: 7, count: 3, spread: 0.45, depth: 0.6, size: 0.7, sizeVariety: 0.35, blades: 11,
    lean: 0.35, width: 1.0, orbs: 0.4, orbSize: 1.0, glow: 1.0, palette: 'pastel',
  },
  grove: {
    kind: 'grove', seed: 7, mushrooms: 12, lanterns: 3, ferns: 2, reeds: 2, size: 0.55, width: 1.0, depth: 0.6,
    dome: 0.42, flare: 0.1, capVariety: 0.6, tilt: 0.4, spots: 0.7, glow: 1.0, palette: 'pastel', mound: 0.5,
  },
};

/** Slider ranges for the patch options of each kind: [key, label, min, max, step]. */
export const PATCH_FIELDS = {
  mushroom: [['count', 'Count', 1, 40, 1], ['spread', 'Spread', 0.04, 1, 0.01], ['depth', 'Depth', 0.15, 1, 0.01],
    ['size', 'Size', 0.12, 1.6, 0.01], ['sizeVariety', 'Size variety', 0, 1, 0.01], ['heightVariety', 'Height variety', 0, 1, 0.01],
    ['lean', 'Lean', 0, 1.3, 0.01], ['bend', 'Bend', 0, 1.5, 0.01], ['capVariety', 'Cap variety', 0, 1, 0.01], ['dome', 'Dome', 0, 1, 0.01], ['domeVariety', 'Dome variety', 0, 1, 0.01],
    ['flare', 'Flare', -1, 1, 0.01], ['flareVariety', 'Flare variety', 0, 1, 0.01], ['separation', 'Fan out', 0, 1.4, 0.01],
    ['tilt', 'Cap tilt', 0, 1, 0.01], ['spots', 'Spots', 0, 1.5, 0.01], ['spotSize', 'Spot size', 0.3, 2, 0.01],
    ['glow', 'Glow', 0, 2.5, 0.01], ['mound', 'Mound', 0, 1.5, 0.01]],
  lantern: [['count', 'Count', 1, 16, 1], ['spread', 'Spread', 0.05, 1.5, 0.01], ['depth', 'Depth', 0.15, 1, 0.01],
    ['size', 'Height', 0.2, 1.6, 0.01], ['sizeVariety', 'Height variety', 0, 1, 0.01], ['arch', 'Arch', 0, 1.2, 0.01],
    ['bulbSize', 'Bulb size', 0.4, 2, 0.01], ['bulbLength', 'Bulb length', 0.6, 2.2, 0.01], ['ribs', 'Ribs', 3, 16, 1],
    ['leaves', 'Leaves', 0, 6, 1], ['glow', 'Glow', 0, 2.5, 0.01]],
  fern: [['count', 'Count', 1, 8, 1], ['spread', 'Spread', 0.05, 1.5, 0.01], ['depth', 'Depth', 0.15, 1, 0.01],
    ['size', 'Frond length', 0.15, 1.2, 0.01], ['sizeVariety', 'Size variety', 0, 1, 0.01], ['fronds', 'Fronds', 3, 16, 1],
    ['tilt', 'Upright', 0, 1, 0.01], ['droop', 'Droop', 0, 1.2, 0.01], ['curl', 'Fiddleheads', 0, 1, 0.01],
    ['leaflets', 'Leaflets', 4, 26, 1], ['width', 'Leaflet width', 0.3, 2, 0.01], ['glow', 'Glow', 0, 2.5, 0.01]],
  reed: [['count', 'Count', 1, 10, 1], ['spread', 'Spread', 0.05, 1.5, 0.01], ['depth', 'Depth', 0.15, 1, 0.01],
    ['size', 'Height', 0.15, 1.6, 0.01], ['sizeVariety', 'Height variety', 0, 1, 0.01], ['blades', 'Blades', 3, 24, 1],
    ['lean', 'Lean', 0, 1.2, 0.01], ['width', 'Blade width', 0.3, 2.5, 0.01], ['orbs', 'Seed pods', 0, 1, 0.01],
    ['orbSize', 'Pod size', 0.4, 2, 0.01], ['glow', 'Glow', 0, 2.5, 0.01]],
  grove: [['mushrooms', 'Mushrooms', 0, 30, 1], ['lanterns', 'Lantern blooms', 0, 10, 1], ['ferns', 'Ferns', 0, 6, 1],
    ['reeds', 'Reeds', 0, 6, 1], ['size', 'Size', 0.2, 1.4, 0.01], ['width', 'Width', 0.3, 2.5, 0.01],
    ['depth', 'Depth', 0.15, 1, 0.01], ['capVariety', 'Cap variety', 0, 1, 0.01], ['dome', 'Cap dome', 0, 1, 0.01], ['flare', 'Cap flare', -1, 1, 0.01],
    ['tilt', 'Cap tilt', 0, 1, 0.01], ['spots', 'Spots', 0, 1.5, 0.01], ['glow', 'Glow', 0, 2.5, 0.01], ['mound', 'Mound', 0, 1.5, 0.01]],
};

/** Per-item editable fields: [key, label, min, max, step]; colours: [key, label]. */
export const ITEM_FIELDS = {
  mushroom: {
    sliders: [['height', 'Height', 0.04, 2, 0.005], ['stemRadius', 'Stem thickness', 0.004, 0.08, 0.001],
      ['lean', 'Lean', 0, 1.25, 0.01], ['dirDeg', 'Lean direction', -180, 180, 1], ['bend', 'Bend', 0, 1.5, 0.01],
      ['capRadius', 'Cap radius', 0.02, 0.8, 0.005], ['dome', 'Dome', 0, 1, 0.01], ['flare', 'Flare', -1, 1, 0.01],
      ['peak', 'Pointed', 0, 1, 0.01], ['umbo', 'Centre bump', 0, 1, 0.01], ['wave', 'Wavy rim', 0, 1, 0.01], ['waves', 'Waves', 3, 12, 1],
      ['capTilt', 'Cap tilt', -0.6, 1.4, 0.01], ['spots', 'Spots', 0, 1.5, 0.01], ['spotSize', 'Spot size', 0.3, 2.2, 0.01],
      ['glow', 'Glow', 0, 3, 0.01], ['gills', 'Gills', 8, 72, 1], ['x', 'Position x', -1.5, 1.5, 0.005], ['z', 'Position z', -1, 1, 0.005]],
    colors: [['capColorA', 'Cap centre'], ['capColorB', 'Cap rim'], ['stemColor', 'Stem'], ['glowColor', 'Glow']],
  },
  lantern: {
    sliders: [['height', 'Height', 0.15, 1.6, 0.005], ['arch', 'Arch', 0, 1.2, 0.01], ['dirDeg', 'Facing', -180, 180, 1],
      ['stalkRadius', 'Stalk thickness', 0.003, 0.03, 0.0005], ['bulbRadius', 'Bulb radius', 0.015, 0.16, 0.001],
      ['bulbLength', 'Bulb length', 0.6, 2.2, 0.01], ['ribs', 'Ribs', 3, 16, 1], ['leaves', 'Leaves', 0, 6, 1],
      ['leafLength', 'Leaf length', 0.04, 0.5, 0.005], ['glow', 'Glow', 0, 3, 0.01],
      ['x', 'Position x', -1.5, 1.5, 0.005], ['z', 'Position z', -1, 1, 0.005]],
    colors: [['bulbColorA', 'Bulb top'], ['bulbColorB', 'Bulb bottom'], ['stalkColor', 'Stalk'], ['glowColor', 'Glow']],
  },
  fern: {
    sliders: [['length', 'Frond length', 0.1, 1.2, 0.005], ['fronds', 'Fronds', 3, 16, 1], ['tilt', 'Upright', 0, 1, 0.01],
      ['droop', 'Droop', 0, 1.2, 0.01], ['curl', 'Fiddleheads', 0, 1, 0.01], ['leaflets', 'Leaflets', 4, 26, 1],
      ['width', 'Leaflet width', 0.3, 2, 0.01], ['rotDeg', 'Rotation', -180, 180, 1], ['glow', 'Glow', 0, 3, 0.01],
      ['x', 'Position x', -1.5, 1.5, 0.005], ['z', 'Position z', -1, 1, 0.005]],
    colors: [['leafColorA', 'Base'], ['leafColorB', 'Tips'], ['glowColor', 'Glow']],
  },
  reed: {
    sliders: [['height', 'Height', 0.15, 1.6, 0.005], ['blades', 'Blades', 3, 24, 1], ['lean', 'Lean', 0, 1.2, 0.01],
      ['width', 'Blade width', 0.3, 2.5, 0.01], ['orbs', 'Seed pods', 0, 1, 0.01], ['orbSize', 'Pod size', 0.4, 2, 0.01],
      ['rotDeg', 'Rotation', -180, 180, 1], ['glow', 'Glow', 0, 3, 0.01],
      ['x', 'Position x', -1.5, 1.5, 0.005], ['z', 'Position z', -1, 1, 0.005]],
    colors: [['bladeColorA', 'Base'], ['bladeColorB', 'Tips'], ['glowColor', 'Glow']],
  },
};
/** Fields that change shape (an override on any of these locks the item in the solver). */
export const SHAPE_KEYS = new Set(['x', 'z', 'height', 'stemRadius', 'lean', 'dir', 'bend', 'capRadius', 'dome', 'flare',
  'capTilt', 'peak', 'umbo', 'wave', 'waves', 'spots', 'spotSize', 'arch', 'stalkRadius', 'bulbRadius', 'bulbLength', 'ribs', 'leaves', 'leafLength',
  'length', 'fronds', 'tilt', 'droop', 'curl', 'leaflets', 'width', 'rot', 'blades', 'orbs', 'orbSize']);

// ================================================================== small utilities
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const col = (hex) => new THREE.Color(hex);

function jitterHex(hex, r, amount) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL((hsl.h + (r() - 0.5) * amount + 1) % 1, clamp(hsl.s + (r() - 0.5) * amount, 0, 1),
    clamp(hsl.l + (r() - 0.5) * amount * 0.6, 0, 1), THREE.SRGBColorSpace);
  return '#' + c.getHexString(THREE.SRGBColorSpace);
}

function basisFrom(Y) {
  const ref = Math.abs(Y.x) < 0.9 ? new V3(1, 0, 0) : new V3(0, 0, 1);
  const X = new V3().crossVectors(Y, ref).normalize();
  const Z = new V3().crossVectors(X, Y).normalize();
  return { X, Y, Z };
}

/** Wind: neighbours sway almost in step, so moving parts never swing into each other. */
const windPhase = (it) => it.x * 1.2 + it.z * 0.4;
const AMP = { mushroom: 0.045, lantern: 0.05, fern: 0.05, reed: 0.06 };
function swayAmp(it) {
  const s = it.kind === 'mushroom' || it.kind === 'lantern' || it.kind === 'reed' ? it.height : it.length;
  return s * AMP[it.kind];
}

// ================================================================== geometry builder
const DETAIL = [
  { stemR: 12, stemL: 18, capSeg: 40, top: 10, under: 6, spotSeg: 8, spots: true, ribbon: 1, tubeR: 6, lathe: 24 },
  { stemR: 9, stemL: 11, capSeg: 26, top: 7, under: 4, spotSeg: 6, spots: true, ribbon: 0.6, tubeR: 5, lathe: 16 },
  { stemR: 6, stemL: 6, capSeg: 14, top: 4, under: 2, spotSeg: 0, spots: false, ribbon: 0.35, tubeR: 4, lathe: 10 },
];

class GeoBuilder {
  constructor() { this.p = []; this.c = []; this.g = []; this.gi = []; this.s = []; this.i = []; this.parts = []; this.cur = null; }
  part(name) { this.close(); this.cur = { name, start: this.i.length }; }
  close() { if (this.cur) { this.cur.count = this.i.length - this.cur.start; this.parts.push(this.cur); this.cur = null; } }
  v(p, c, g, gi, s) {
    this.p.push(p.x, p.y, p.z); this.c.push(c.r, c.g, c.b); this.g.push(g.r, g.g, g.b);
    this.gi.push(gi[0], gi[1], gi[2], gi[3]); this.s.push(s[0], s[1], s[2], s[3]);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /** Tube along pts with radii; parallel-transport frames. attr(k, a) -> [color, glow, gill, sway]. */
  tube(pts, radii, nR, attr, capEnd = false) {
    const n = pts.length;
    const tans = pts.map((p, k) => new V3().subVectors(pts[Math.min(n - 1, k + 1)], pts[Math.max(0, k - 1)]).normalize());
    let N = basisFrom(tans[0]).X;
    const rings = [];
    for (let k = 0; k < n; k++) {
      if (k > 0) N = N.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(tans[k - 1], tans[k]));
      const B = new V3().crossVectors(tans[k], N).normalize();
      const Nn = new V3().crossVectors(B, tans[k]).normalize();
      const ring = [];
      for (let j = 0; j < nR; j++) {
        const a = (j / nR) * TAU;
        const pos = pts[k].clone().addScaledVector(Nn, Math.cos(a) * radii[k]).addScaledVector(B, Math.sin(a) * radii[k]);
        const [c, g, gi, s] = attr(k, a);
        ring.push(this.v(pos, c, g, gi, s));
      }
      rings.push(ring);
    }
    for (let k = 0; k < n - 1; k++) for (let j = 0; j < nR; j++) {
      const j2 = (j + 1) % nR;
      this.quad(rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j]);
    }
    if (capEnd) {
      const [c, g, gi, s] = attr(n - 1, 0);
      const tip = this.v(pts[n - 1].clone().addScaledVector(tans[n - 1], radii[n - 1] * 0.8), c, g, gi, s);
      for (let j = 0; j < nR; j++) this.tri(rings[n - 1][j], rings[n - 1][(j + 1) % nR], tip);
    }
  }
  /** Lathe: profile [{r, y}] in local frame toW(x, y, z); optional poles. attr(i, a) -> [c, g, gi, s]. */
  lathe(toW, prof, S, attr, poleTop = null, poleBottom = null, rMul = null, yAdd = null) {
    const rings = prof.map((pr, i) => {
      const ring = [];
      for (let j = 0; j < S; j++) {
        const a = (j / S) * TAU;
        const rr = pr.r * (rMul ? rMul(i, a) : 1);
        const [c, g, gi, s] = attr(i, a);
        ring.push(this.v(toW(rr * Math.cos(a), pr.y + (yAdd ? yAdd(i, a) : 0), rr * Math.sin(a)), c, g, gi, s));
      }
      return ring;
    });
    if (poleTop) {
      const [c, g, gi, s] = attr(-1, 0);
      const pole = this.v(toW(0, poleTop.y, 0), c, g, gi, s);
      for (let j = 0; j < S; j++) this.tri(pole, rings[0][(j + 1) % S], rings[0][j]);
    }
    for (let k = 0; k < rings.length - 1; k++) for (let j = 0; j < S; j++) {
      const j2 = (j + 1) % S;
      this.quad(rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j]);
    }
    if (poleBottom) {
      const [c, g, gi, s] = attr(prof.length, 0);
      const pole = this.v(toW(0, poleBottom.y, 0), c, g, gi, s);
      const last = rings[rings.length - 1];
      for (let j = 0; j < S; j++) this.tri(last[j], last[(j + 1) % S], pole);
    }
  }
  /** Double-sided ribbon: centre line C, side vectors S, half widths W; 3 vertices across. */
  ribbon(C, S, W, attr) {
    for (let side = 0; side < 2; side++) {
      const rows = C.map((c, k) => [-1, 0, 1].map((j) => {
        const [cc, g, gi, s] = attr(k, j);
        return this.v(c.clone().addScaledVector(S[k], j * W[k]), cc, g, gi, s);
      }));
      for (let k = 0; k < C.length - 1; k++) for (let j = 0; j < 2; j++) {
        const a = rows[k][j], b = rows[k][j + 1], c = rows[k + 1][j + 1], d = rows[k + 1][j];
        if (side === 0) this.quad(a, b, c, d); else this.quad(a, d, c, b);
      }
    }
  }
  geometry() {
    this.close();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.g, 3));
    geo.setAttribute('aGill', new THREE.Float32BufferAttribute(this.gi, 4));
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(this.s, 4));
    geo.setIndex(this.i);
    geo.computeVertexNormals();
    geo.userData.parts = this.parts;
    return geo;
  }
}
const NOGILL = [0, 0, 0, 0];
const STEMGILL = [0, 0, -1, 0];

// ================================================================== MUSHROOM
function capProfile(m) {
  const R = m.capRadius;
  const lip = R * (0.06 + 0.04 * m.dome);
  const yRim = R * m.flare * 0.38;
  const yTopC = Math.max(R * (0.14 + 0.66 * m.dome), lip * 1.7, yRim + R * 0.05);
  const k = 1 - 0.5 * m.dome;
  const peak = clamp(m.peak || 0, 0, 1), umbo = clamp(m.umbo || 0, 0, 1);
  const coneTop = yTopC + peak * R * 0.5;
  const top = (u) => {
    const round = yRim + (yTopC - yRim) * Math.pow(Math.max(0, 1 - u * u), k);
    const cone = yRim + (coneTop - yRim) * Math.pow(Math.max(0, 1 - Math.sqrt(u * u + 0.0025)) / 0.95, 1.15);   // rounded tip
    return lerp(round, cone, peak) + umbo * R * 0.16 * Math.exp(-Math.pow(u / 0.2, 2));
  };
  // wavy rim: the outer part of the cap ripples up and down around the circumference
  const waveAmp = clamp(m.wave || 0, 0, 1) * R * 0.11;
  const waves = Math.max(3, Math.round(m.waves || 6));
  const waveAt = (u, a) => (waveAmp ? waveAmp * Math.pow(clamp(u, 0, 1), 3) * Math.sin(waves * a + (m.phase || 0)) : 0);
  return { R, lip, yRim, top, waveAmp, waveAt };
}

/** Cap styles mixed in by capVariety: [min, max] ranges or fixed values. */
const CAP_STYLES = {
  dome: { dome: [0.45, 0.85], flare: [-0.2, 0.15], peak: 0, umbo: 0, wave: 0, scale: 1.0 },
  parasol: { dome: [0.06, 0.2], flare: [0.0, 0.18], peak: 0, umbo: [0, 0.35], wave: 0, scale: 1.2 },
  cone: { dome: [0.35, 0.65], flare: [-0.25, 0.05], peak: [0.55, 1], umbo: 0, wave: 0, scale: 0.85 },
  funnel: { dome: [0.04, 0.18], flare: [0.55, 0.95], peak: 0, umbo: 0, wave: [0, 0.3], scale: 1.0 },
  umbo: { dome: [0.12, 0.32], flare: [0.0, 0.25], peak: 0, umbo: [0.6, 1.0], wave: 0, scale: 1.05 },
  wavy: { dome: [0.18, 0.42], flare: [0.05, 0.35], peak: 0, umbo: 0, wave: [0.45, 0.9], scale: 1.05 },
};
const MAX_TIP = 0.95;   // caps never tip further than ~54 degrees from upright

/** Everything about a mushroom's shape that geometry and collisions share. */
function mushroomFrame(m) {
  const out = new V3(Math.cos(m.dir), 0, Math.sin(m.dir));
  const kAxis = new V3().crossVectors(UP, out).normalize();
  const D_top = UP.clone().applyAxisAngle(kAxis, clamp(m.lean, 0, 1.45));
  const f = 0.55 - 0.15 * m.bend;
  const chord = UP.clone().applyAxisAngle(kAxis, clamp(m.lean * f, 0, 1.4));
  const P0 = new V3(m.x, -0.02, m.z);
  const P3 = P0.clone().addScaledVector(chord, m.height);
  const P1 = P0.clone().addScaledVector(UP, m.height * 0.38 * (1 - 0.35 * m.bend)).addScaledVector(out, -m.height * 0.04 * m.bend);
  const P2 = P3.clone().addScaledVector(D_top, -m.height * (0.22 + 0.3 * m.bend));
  const curve = new THREE.CubicBezierCurve3(P0, P1, P2, P3);
  const prof = capProfile(m);
  const topR = m.stemRadius * 0.62;
  const A = D_top.clone().applyAxisAngle(kAxis, m.capTilt).normalize();
  const { X, Y, Z } = basisFrom(A);
  const T0 = P3.clone().addScaledVector(A, -prof.lip * 0.3);
  const rs = topR * 1.05;
  const yU0 = prof.yRim - prof.lip;
  const radiusAt = (t) => {
    const rad = m.stemRadius * (1 - 0.38 * t + 0.6 * Math.exp(-Math.pow(t / 0.07, 2)) + 0.1 * Math.exp(-Math.pow((t - 0.2) / 0.12, 2)));
    return lerp(rad, topR * 1.25, smooth(0.86, 1, t));
  };
  const toW = (lx, ly, lz) => T0.clone().addScaledVector(X, lx).addScaledVector(Y, ly).addScaledVector(Z, lz);
  return { out, kAxis, f, P0, P3, curve, prof, topR, A, X, Y, Z, T0, rs, yU0, radiusAt, toW };
}

function underY(F, r) {
  const R = F.prof.R;
  if (r >= R * 0.985) return F.yU0;
  if (r <= F.rs) return 0;
  const w = (R * 0.985 - r) / (R * 0.985 - F.rs);
  return F.yU0 * Math.pow(1 - w, 0.75);
}

function genMushrooms(p, r, pal, n, offset = { x: 0, z: 0 }) {
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(1 - p.sizeVariety * 0.78 * Math.pow(r(), 0.85));
  sizes.sort((a, b) => b - a);
  const bases = [];
  const items = sizes.map((sF, i) => {
    const height = p.size * (0.22 + 0.9 * Math.pow(sF, 1.25)) * (1 + p.heightVariety * (r() * 2 - 1) * 0.5);
    const capRadius = p.size * 0.36 * (0.38 + 0.62 * sF) * (0.85 + 0.3 * r());
    const foot = capRadius * 0.17 * 1.65 + 0.004;          // flared stem base
    // place the base where it doesn't overlap an earlier one (big ones first, near the middle)
    let ang = 0, dist = 0, x = 0, z = 0;
    for (let tries = 0; tries < 40; tries++) {
      ang = r() * TAU;
      dist = p.spread * Math.sqrt(r()) * (i === 0 ? 0.15 : 0.3 + 0.7 * (1 - sF * 0.6)) * (1 + tries * 0.04);
      x = Math.cos(ang) * dist + offset.x;
      z = Math.sin(ang) * dist * p.depth + (0.5 - sF) * p.spread * p.depth * 0.9 + offset.z;
      if (bases.every((q) => Math.hypot(q.x - x, q.z - z) > q.f + foot)) break;
    }
    bases.push({ x, z, f: foot });
    const outward = p.spread > 1e-4 ? clamp(dist / p.spread, 0, 1) : 0;
    const pair = pal.caps[Math.floor(r() * pal.caps.length)];
    const flip = r() < 0.5;
    // pick a cap style: round domes, wide parasols, pointed cones, funnels, bumps, wavy rims
    const v = clamp(p.capVariety ?? 0.6, 0, 1);
    const names = Object.keys(CAP_STYLES);
    const weights = names.map((n) => (n === 'dome' ? 1 : v * 0.5));
    let pick = r() * weights.reduce((a, b) => a + b, 0), style = 'dome';
    for (let q = 0; q < names.length; q++) { pick -= weights[q]; if (pick <= 0) { style = names[q]; break; } }
    const st = CAP_STYLES[style];
    const val = (x) => (Array.isArray(x) ? lerp(x[0], x[1], r()) : x);
    let flare = clamp(val(st.flare) + (p.flare - 0.1) * 0.8 + (r() * 2 - 1) * p.flareVariety * 0.15, -1, 1);
    if (flare < -0.4) flare = -0.4 + (flare + 0.4) * 0.35;           // soften heavy bells: less droopy
    const shape = {
      dome: r4(clamp(val(st.dome) + (p.dome - 0.42) * 0.8 + (r() * 2 - 1) * p.domeVariety * 0.12, 0.03, 1)),
      flare: r4(flare), peak: r4(val(st.peak)), umbo: r4(val(st.umbo)), wave: r4(val(st.wave)),
      waves: Math.round(lerp(5, 9, r())), style,
    };
    return {
      kind: 'mushroom', x: r4(x), z: r4(z), height: r4(height), stemRadius: r4(capRadius * (0.11 + 0.06 * r())),
      lean: r4(clamp(p.lean * (0.2 + 0.95 * outward) * (0.6 + 0.8 * r()) + (1 - sF) * p.lean * 0.5, 0, 1.05)),
      dir: r4(Math.atan2(Math.sin(ang) * p.depth, Math.cos(ang)) + (r() - 0.5) * 0.9),
      bend: r4(p.bend * (0.5 + r())), capRadius: r4(capRadius * st.scale),
      ...shape,
      capTilt: r4(p.tilt * (0.25 + r() * 1.1)),
      capColorA: jitterHex(flip ? pair[1] : pair[0], r, 0.05), capColorB: jitterHex(flip ? pair[0] : pair[1], r, 0.05),
      stemColor: jitterHex(pal.stem, r, 0.04), glowColor: jitterHex(pal.glow, r, 0.03), spotColor: pal.spot,
      glow: r4(p.glow * (0.8 + 0.4 * r())), gills: Math.round(lerp(26, 46, r())),
      spots: r4(p.spots * (0.6 + 0.6 * r())), spotSize: r4(p.spotSize), spotSeed: Math.floor(r() * 1e9),
      phase: r4(r() * TAU),
    };
  });
  if (p.separation > 0) separateCaps(items, p.separation, 40, p.depth);
  for (const m of items) {
    // a sidescroller sees the patch from +Z: keep caps from flattening out towards the camera
    const fwd = Math.max(0, Math.sin(m.dir));
    m.lean = r4(Math.min(m.lean, 1.05 - 0.35 * fwd));
    m.capTilt = r4(m.capTilt * (1 - 0.65 * fwd));
    // less droop: the cap's total tip (stem lean + cap tilt) stays within MAX_TIP of upright,
    // so caps on steep stems turn back up instead of hanging sideways
    m.capTilt = r4(clamp(m.capTilt, -0.6 * m.lean, MAX_TIP - m.lean));
  }
  return items;
}

/** Fast first pass: fan cap centres apart (the full solver then removes every remaining contact). */
export function separateCaps(list, strength = 1.0, iterations = 40, depth = 1) {
  const caps = list.map((m) => {
    const F = mushroomFrame(m);
    return { m, f: F.f, base: F.P0.clone(), p: F.P3.clone() };
  });
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) {
      const A = caps[i], B = caps[j];
      const minD = (A.m.capRadius + B.m.capRadius) * strength;
      const d = new V3().subVectors(A.p, B.p);
      const dv = new V3(d.x, d.y * 1.6, d.z);
      const len = dv.length();
      if (len >= minD) continue;
      moved = true;
      if (len < 1e-5) dv.set(Math.cos(i * 2.4), 0.3, Math.sin(i * 2.4));
      dv.normalize();
      dv.z *= depth;
      const push = (minD - len) * 0.5;
      const wa = B.m.capRadius / (A.m.capRadius + B.m.capRadius);
      A.p.addScaledVector(dv, push * wa);
      B.p.addScaledVector(dv, -push * (1 - wa));
    }
    for (const c of caps) c.p.y = Math.max(c.p.y, c.m.capRadius * 0.9 + 0.02);
    if (!moved) break;
  }
  for (const c of caps) setMushroomTop(c.m, c.p);
  return list;
}

function setMushroomTop(m, top) {
  const base = new V3(m.x, -0.02, m.z);
  const v = new V3().subVectors(top, base);
  const len = Math.max(v.length(), 0.03);
  const ang = Math.acos(clamp(v.y / len, -1, 1));
  const f = 0.55 - 0.15 * m.bend;
  m.height = r4(len);
  m.lean = r4(clamp(ang / f, 0, 1.1));
  if (Math.hypot(v.x, v.z) > 1e-4) m.dir = r4(Math.atan2(v.z, v.x));
  if (m.capTilt > MAX_TIP - m.lean) m.capTilt = r4(MAX_TIP - m.lean);
}

function mushroomGeometry(m, D, b) {
  const F = mushroomFrame(m);
  const glowC = col(m.glowColor), stemC = col(m.stemColor), capA = col(m.capColorA), capB = col(m.capColorB);
  const spotC = col(m.spotColor || '#ffffff');
  const amp = swayAmp(m), wp = windPhase(m);
  const SW = (hf) => [wp, amp, hf, m.phase];
  const c = new THREE.Color();
  // stem
  b.part('stem');
  const nL = D.stemL;
  const pts = [], radii = [];
  for (let k = 0; k <= nL; k++) {
    const t = k / nL;
    pts.push(F.curve.getPoint(t));
    radii.push(F.radiusAt(t) * (1 + 0.05 * Math.sin(t * 11 + m.phase * 3)));
  }
  b.tube(pts, radii, D.stemR, (k, a) => {
    const t = k / nL;
    const stripe = 1 + 0.08 * Math.sin(a * 7 + t * 4 + m.phase);
    const cc = stemC.clone().lerp(glowC, 0.18 * t * t).multiplyScalar(stripe * (0.9 + 0.1 * t));
    const g = glowC.clone().multiplyScalar(m.glow * (0.02 + 0.36 * Math.pow(t, 2.2))).add(stemC.clone().multiplyScalar(0.1 * m.glow));
    return [cc, g, STEMGILL, SW(t)];
  });
  // cap
  b.part('cap');
  const { R, lip, yRim, top } = F.prof;
  const profile = [];
  for (let i = 1; i <= D.top; i++) { const u = Math.pow(i / D.top, 0.9); profile.push({ r: R * u, y: top(u), kind: 'top', w: u }); }
  profile.push({ r: R * 1.015, y: yRim - lip * 0.5, kind: 'lip', w: 1 });
  for (let i = 0; i <= D.under; i++) {
    const w = i / D.under;
    profile.push({ r: lerp(R * 0.985, F.rs, w), y: F.yU0 * Math.pow(1 - w, 0.75), kind: 'under', w });
  }
  const capSelf = (cc) => cc.clone().multiplyScalar(0.2 * m.glow);
  const white = new THREE.Color(1, 1, 1);
  b.lathe(F.toW, profile, D.capSeg, (i, a) => {
    if (i < 0) return [capA, capSelf(capA), NOGILL, SW(1)];
    const pr = profile[i];
    if (pr.kind === 'top') {
      const mott = 1 + 0.05 * Math.sin(a * 5 + pr.w * 9 + m.phase) * Math.sin(a * 3 - pr.w * 5);
      const cc = capA.clone().lerp(capB, smooth(0.05, 1, pr.w)).multiplyScalar(mott);
      return [cc, capSelf(cc).add(glowC.clone().multiplyScalar(m.glow * 0.3 * Math.pow(pr.w, 7))), NOGILL, SW(1)];
    }
    if (pr.kind === 'lip') {
      const cc = capB.clone().lerp(white, 0.25);
      return [cc, capSelf(cc).add(glowC.clone().multiplyScalar(m.glow * 0.45)), NOGILL, SW(1)];
    }
    const cc = glowC.clone().lerp(white, 0.55).lerp(capB, 0.2);
    return [cc, glowC.clone().multiplyScalar(m.glow * (0.22 + 0.42 * pr.w)), [Math.cos(a), Math.sin(a), 0.05 + 0.95 * pr.w, m.gills], SW(1)];
  }, { y: top(0) }, null, null, (i, a) => F.prof.waveAt(profile[i].r / R, a));
  // spots
  if (D.spots && m.spots > 0) {
    b.part('spots');
    const sr = rng(m.spotSeed || 1);
    const want = Math.round(m.spots * 26);
    const placed = [];
    const uMin = 0.1, uMax = 0.9;
    for (let tries = 0; tries < want * 12 && placed.length < want; tries++) {
      const u = Math.sqrt(sr() * (uMax * uMax - uMin * uMin) + uMin * uMin);
      const a = sr() * TAU;
      const rS = R * lerp(0.035, 0.085, Math.pow(sr(), 1.6)) * m.spotSize * (1.15 - 0.4 * u);
      const px = R * u * Math.cos(a), pz = R * u * Math.sin(a);
      if (placed.some((q) => Math.hypot(q.x - px, q.z - pz) < (q.r + rS) * 1.35)) continue;
      placed.push({ x: px, z: pz, r: rS, u, a });
    }
    const seg = D.spotSeg;
    const ringC = spotC.clone().lerp(glowC, 0.45);
    const gS = spotC.clone().multiplyScalar(0.22 * m.glow);
    for (const s of placed) {
      // surface point + numeric normal (includes the wavy rim)
      const S = (u, a) => new V3(R * u * Math.cos(a), top(u) + F.prof.waveAt(u, a), R * u * Math.sin(a));
      const du = 0.01, da = 0.01;
      const dU = S(Math.min(1, s.u + du), s.a).sub(S(Math.max(0, s.u - du), s.a));
      const dA = S(s.u, s.a + da).sub(S(s.u, s.a - da));
      const nl = new V3().crossVectors(dA, dU).normalize();
      if (nl.y < 0) nl.negate();
      const nW = F.X.clone().multiplyScalar(nl.x).addScaledVector(F.Y, nl.y).addScaledVector(F.Z, nl.z).normalize();
      const sp0 = S(s.u, s.a);
      const base = F.toW(sp0.x, sp0.y, sp0.z);
      const fb = basisFrom(nW);
      const h = s.r * 0.38;
      const toW = (lx, ly, lz) => base.clone().addScaledVector(fb.X, lx).addScaledVector(fb.Y, ly).addScaledVector(fb.Z, lz);
      b.lathe(toW, [{ r: s.r * 0.62, y: h * 0.72 }, { r: s.r, y: -h * 0.25 }], seg, (i) => (
        i === 1 ? [ringC, ringC.clone().multiplyScalar(0.25 * m.glow), NOGILL, SW(1)] : [spotC, gS, NOGILL, SW(1)]), { y: h });
    }
  }
}

function mushroomShape(m) {
  const F = mushroomFrame(m);
  const { R, lip, yRim, top } = F.prof;
  const topPad = m.spots > 0 ? 0.045 * R * m.spotSize : 0;
  const cap = {
    part: 'cap', center: F.toW(0, (top(0) + F.yU0) * 0.5, 0),
    inside(p, pad) {
      const v = new V3().subVectors(p, F.T0);
      const ly = v.dot(F.Y);
      const r = Math.hypot(v.dot(F.X), v.dot(F.Z));
      if (r > R * 1.015 + pad) return false;
      const u = Math.min(r / R, 1);
      const wv = F.prof.waveAmp * u * u * u;
      const yTop = top(u) + topPad + pad + wv;
      const yBot = (r <= F.rs ? 0 : underY(F, r)) - pad - wv;
      return ly <= yTop && ly >= yBot;
    },
  };
  // surface samples
  const sp = Math.max(0.11 * R, 0.005);
  const pts = [];
  for (let u = 0; u <= 1.0001; u += sp / R) {
    const uu = Math.min(u, 1), rr = R * uu;
    const nA = Math.max(1, Math.ceil(TAU * rr / sp));
    for (let j = 0; j < nA; j++) { const a = j / nA * TAU; pts.push(F.toW(rr * Math.cos(a), top(uu) + topPad + F.prof.waveAt(uu, a), rr * Math.sin(a))); }
  }
  {
    const rr = R * 1.015, nA = Math.ceil(TAU * rr / sp);
    for (let j = 0; j < nA; j++) { const a = j / nA * TAU; pts.push(F.toW(rr * Math.cos(a), yRim - lip * 0.5 + F.prof.waveAt(1, a), rr * Math.sin(a))); }
  }
  const span = R * 0.985 - F.rs;
  for (let w = 0; w <= 1.0001; w += sp / Math.max(span, 1e-4)) {
    const ww = Math.min(w, 1), rr = lerp(R * 0.985, F.rs, ww);
    const nA = Math.max(3, Math.ceil(TAU * rr / sp));
    for (let j = 0; j < nA; j++) { const a = j / nA * TAU; pts.push(F.toW(rr * Math.cos(a), F.yU0 * Math.pow(1 - ww, 0.75) + F.prof.waveAt(rr / R, a), rr * Math.sin(a))); }
  }
  // stem tube
  const nT = clamp(Math.ceil(m.height / 0.01), 8, 120);
  const tp = [], tr = [], tt = [];
  for (let k = 0; k <= nT; k++) { const t = k / nT; tp.push(F.curve.getPoint(t)); tr.push(F.radiusAt(t) * 1.06); tt.push(t); }
  return finishShape({
    kind: 'mushroom', bulk: R, amp: swayAmp(m),
    solids: [{ ...cap, w: swayAmp(m) }], samples: [{ part: 'cap', pts, d: sp * 0.75, w: swayAmp(m) }],
    tubes: [{ part: 'stem', pts: tp, r: tr, t: tt, w: tt.map((t) => swayAmp(m) * t * t), ignoreMound: true }],
    capCenter: cap.center, F,
  });
}

// ================================================================== LANTERN BLOOM
function lanternFrame(it) {
  const out = new V3(Math.cos(it.dir), 0, Math.sin(it.dir));
  const B = new V3(it.x, -0.02, it.z);
  const R = it.bulbRadius, halfH = R * it.bulbLength, neck = 0.15 * R, drip = 0.25 * R;
  const reach = Math.max(it.arch * it.height * 0.5, R * 1.8 + 0.03);
  const H = it.height;
  const P1 = B.clone().addScaledVector(UP, H * 0.8);
  const P2 = B.clone().addScaledVector(out, reach).addScaledVector(UP, H * 1.0);
  const tip = B.clone().addScaledVector(out, reach).addScaledVector(UP, H * 0.9);
  const curve = new THREE.CubicBezierCurve3(B, P1, P2, tip);
  const bulbTop = tip.clone().addScaledVector(UP, -neck);
  const bulbProfile = (v) => R * (0.18 + 0.82 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.85)), 0.9));
  const stalkR = (t) => it.stalkRadius * lerp(1.3, 0.75, t);
  // leaves: evenly spaced, rotated so the stalk and bulb fall between two leaves
  const L = Math.max(0, Math.round(it.leaves));
  const leaves = [];
  for (let l = 0; l < L; l++) {
    const az = it.dir + Math.PI / Math.max(L, 1) + l * TAU / Math.max(L, 1) + (it.rot || 0);
    const o = new V3(Math.cos(az), 0, Math.sin(az));
    const side = new V3(-o.z, 0, o.x);
    const r0 = it.stalkRadius * 1.3 + 0.006;
    const n = 9;
    const C = [], W = [];
    for (let k = 0; k <= n; k++) {
      const s = k / n;
      const d = r0 + it.leafLength * 0.85 * s;
      const y = Math.max(0.012, it.leafLength * 0.42 * Math.sin(Math.PI * s * 0.85) * (1 - 0.3 * s) + 0.004);
      C.push(new V3(it.x, 0, it.z).addScaledVector(o, d).setY(y));
      let w = it.leafLength * 0.13 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.02 + 0.02)), 0.7);
      if (L >= 2) w = Math.min(w, d * Math.sin(Math.PI / L) * 0.85 - 0.002);
      W.push(Math.max(0.0008, w));
    }
    leaves.push({ C, W, side });
  }
  return { out, B, R, halfH, neck, drip, reach, curve, tip, bulbTop, bulbProfile, stalkR, leaves };
}

function fixLanternHeight(it) {
  const R = it.bulbRadius, need = 0.045 + 0.25 * R + 2 * R * it.bulbLength + 0.15 * R;
  if (it.height * 0.9 < need) it.height = r4(need / 0.9 + 0.005);
}

function genLantern(p, r, pal, x, z, sF = 1) {
  const pair = pal.bulb[Math.floor(r() * pal.bulb.length)];
  const it = {
    kind: 'lantern', x: r4(x), z: r4(z), height: r4(p.size * (1 - p.sizeVariety * 0.6 * r()) * sF),
    arch: r4(clamp(p.arch * (0.7 + 0.6 * r()), 0, 1.2)), dir: r4(r() * TAU),
    stalkRadius: r4(0.007 * (p.size / 0.7) * (0.85 + 0.3 * r())),
    bulbRadius: r4(0.045 * p.bulbSize * (p.size / 0.7) * (0.8 + 0.4 * r())), bulbLength: r4(p.bulbLength * (0.85 + 0.3 * r())),
    ribs: Math.round(p.ribs), leaves: Math.round(p.leaves), leafLength: r4(p.size * 0.28 * (0.8 + 0.4 * r())), rot: 0,
    stalkColor: jitterHex(pal.stalk, r, 0.04), bulbColorA: jitterHex(pair[0], r, 0.04), bulbColorB: jitterHex(pair[1], r, 0.04),
    glowColor: jitterHex(pal.glow, r, 0.03), glow: r4(p.glow * (0.85 + 0.3 * r())), phase: r4(r() * TAU),
  };
  // face the bulb sideways more than towards / away from the camera
  it.dir = r4(Math.atan2(Math.sin(it.dir) * 0.45, Math.cos(it.dir)));
  fixLanternHeight(it);
  return it;
}

function lanternGeometry(it, D, b) {
  const F = lanternFrame(it);
  const glowC = col(it.glowColor), stalkC = col(it.stalkColor), bA = col(it.bulbColorA), bB = col(it.bulbColorB);
  const amp = swayAmp(it), wp = windPhase(it);
  const SW = (hf) => [wp, amp, hf, it.phase];
  // stalk
  b.part('stalk');
  const n = Math.round(lerp(6, 22, D.ribbon));
  const pts = [], radii = [];
  for (let k = 0; k <= n; k++) { const t = k / n; pts.push(F.curve.getPoint(t)); radii.push(F.stalkR(t)); }
  b.tube(pts, radii, Math.max(4, D.tubeR), (k) => {
    const t = k / n;
    return [stalkC.clone().multiplyScalar(0.75 + 0.25 * t), glowC.clone().multiplyScalar(it.glow * 0.08 * t * t).add(stalkC.clone().multiplyScalar(0.06 * it.glow)), STEMGILL, SW(t)];
  });
  // calyx (little lobed cap the bulb hangs from)
  b.part('calyx');
  const cTop = F.tip.clone().addScaledVector(UP, 0.004);
  const toWc = (lx, ly, lz) => cTop.clone().add(new V3(lx, ly, lz));
  b.lathe(toWc, [{ r: F.R * 0.2, y: -F.neck * 0.3 }, { r: F.R * 0.38, y: -F.neck * 1.25 }], Math.max(6, D.lathe / 2),
    () => [stalkC.clone().multiplyScalar(0.8), stalkC.clone().multiplyScalar(0.05), NOGILL, SW(1)], { y: 0.002 }, null,
    (i, a) => (i === 1 ? 1 + 0.25 * Math.cos(a * 5) : 1));
  // bulb
  b.part('bulb');
  const rings = Math.round(lerp(5, 13, D.ribbon));
  const prof = [];
  for (let i = 0; i <= rings; i++) { const v = i / rings; prof.push({ r: F.bulbProfile(v), y: -2 * F.halfH * v, v }); }
  const toWb = (lx, ly, lz) => F.bulbTop.clone().add(new V3(lx, ly, lz));
  b.lathe(toWb, prof, D.lathe, (i, a) => {
    const v = i < 0 ? 0 : i >= prof.length ? 1 : prof[i].v;
    const cc = bA.clone().lerp(bB, smooth(0, 1, v));
    const g = cc.clone().lerp(glowC, 0.45).multiplyScalar(it.glow * (0.45 + 0.4 * Math.sin(Math.PI * v)));
    return [cc, g, [Math.cos(a), Math.sin(a), 0.9, it.ribs], SW(1)];
  }, { y: 0 }, { y: -2 * F.halfH - F.drip }, (i, a) => 1 + 0.06 * Math.cos(a * it.ribs));
  // leaves
  F.leaves.forEach((lf, li) => {
    b.part('leaf' + li);
    const lc = stalkC.clone().lerp(bA, 0.15);
    b.ribbon(lf.C, lf.C.map(() => lf.side), lf.W, (k, j) => {
      const s = k / (lf.C.length - 1);
      const g = glowC.clone().multiplyScalar(it.glow * (j === 0 ? 0.35 : 0.05) * (0.3 + 0.7 * s));
      return [lc.clone().multiplyScalar(0.7 + 0.3 * s), g, NOGILL, SW(0.12 * s)];
    });
  });
}

function lanternShape(it) {
  const F = lanternFrame(it);
  const nT = clamp(Math.ceil(it.height * 1.6 / 0.01), 10, 160);
  const tp = [], tr = [], tt = [];
  for (let k = 0; k <= nT; k++) { const t = k / nT; tp.push(F.curve.getPoint(t)); tr.push(F.stalkR(t) * 1.05); tt.push(t); }
  const top = F.bulbTop, R = F.R, H2 = 2 * F.halfH;
  const bulb = {
    part: 'bulb', center: top.clone().addScaledVector(UP, -F.halfH),
    inside(p, pad) {
      const v = (top.y - p.y) / H2;
      if (v < -(pad + F.neck * 1.3) / H2 || v > 1 + (F.drip + pad) / H2) return false;
      const rr = Math.hypot(p.x - top.x, p.z - top.z);
      const prof = v < 0 ? R * 0.4 : v > 1 ? R * 0.2 : Math.max(F.bulbProfile(v), R * 0.2);
      return rr <= prof * 1.07 + pad;
    },
  };
  const sp = Math.max(0.15 * R, 0.004);
  const pts = [];
  for (let v = 0; v <= 1.0001; v += sp / H2) {
    const rr = F.bulbProfile(Math.min(v, 1)) * 1.06, nA = Math.max(3, Math.ceil(TAU * rr / sp));
    for (let j = 0; j < nA; j++) { const a = j / nA * TAU; pts.push(new V3(top.x + rr * Math.cos(a), top.y - H2 * Math.min(v, 1), top.z + rr * Math.sin(a))); }
  }
  pts.push(new V3(top.x, top.y - H2 - F.drip, top.z));
  const A = swayAmp(it);
  const tubes = [{ part: 'stalk', pts: tp, r: tr, t: tt, w: tt.map((t) => A * t * t) }];
  F.leaves.forEach((lf, li) => tubes.push({ part: 'leaf' + li, pts: lf.C.map((c) => c.clone()), r: lf.W.map((w) => w + 0.0015), t: lf.C.map((_, k) => k / (lf.C.length - 1)), w: lf.C.map((_, k) => A * Math.pow(0.12 * k / (lf.C.length - 1), 2)), leaf: true }));
  bulb.w = A;
  return finishShape({
    kind: 'lantern', bulk: R * 2.2, amp: A, solids: [bulb], samples: [{ part: 'bulb', pts, d: sp * 0.75, w: A }],
    tubes, bulbBottom: top.y - H2 - F.drip, F,
  });
}

// ================================================================== FERN
function fernFronds(it, segs = 24) {
  const r = rng((it.seed || 1) >>> 0);
  const F = Math.max(3, Math.round(it.fronds));
  const D = TAU / F;
  const crown = 0.035 * it.length / 0.5 + 0.01;
  const C = new V3(it.x, 0, it.z);
  const fronds = [];
  for (let f = 0; f < F; f++) {
    const az = (it.rot || 0) + f * D + (r() - 0.5) * D * 0.25;
    const young = r() < it.curl;
    const Lf = it.length * (young ? 0.55 : 0.8 + 0.25 * r());
    const curlAmt = young ? 1 : 0.25 * r();
    const e0 = lerp(0.5, 1.4, it.tilt) + (r() - 0.5) * 0.25;
    const droop = it.droop * (0.8 + 0.4 * r());
    const o = new V3(Math.cos(az), 0, Math.sin(az));
    const pts = [], sArr = [];
    let P = C.clone().addScaledVector(o, crown * 0.7).setY(0.015);
    const ds = Lf / segs;
    for (let k = 0; k <= segs; k++) {
      const s = k / segs;
      pts.push(P.clone()); sArr.push(s);
      const e = e0 - droop * 1.9 * s - curlAmt * 6.0 * Math.pow(smooth(0.68, 1, s), 1.2);
      P = P.clone().addScaledVector(o, Math.cos(e) * ds).addScaledVector(UP, Math.sin(e) * ds);
      if (P.y < 0.015) P.y = 0.015;
    }
    const halfWedge = D * 0.75 / 2;
    const leafLen = (k) => {
      const s = sArr[k];
      const p = pts[k];
      const hd = Math.hypot(p.x - C.x, p.z - C.z);
      const lmax = it.width * Lf * 0.2 * Math.pow(Math.sin(Math.PI * clamp((s - 0.08) / 0.92, 0, 1)), 0.6) * (1 - 0.65 * curlAmt * smooth(0.6, 1, s));
      return Math.max(0, Math.min(lmax, hd * Math.sin(halfWedge) * 0.85 - 0.004));
    };
    fronds.push({ az, o, pts, sArr, Lf, curlAmt, leafLen, young });
  }
  return { fronds, crown, C, F, D };
}

function genFern(p, r, pal, x, z, sF = 1) {
  return {
    kind: 'fern', x: r4(x), z: r4(z), length: r4(p.size * (1 - p.sizeVariety * 0.5 * r()) * sF),
    fronds: Math.round(p.fronds), tilt: r4(clamp(p.tilt + (r() - 0.5) * 0.15, 0, 1)), droop: r4(p.droop * (0.85 + 0.3 * r())),
    curl: r4(p.curl), leaflets: Math.round(p.leaflets), width: r4(p.width), rot: r4(r() * TAU), seed: Math.floor(r() * 1e9),
    leafColorA: jitterHex(pal.leaf[0], r, 0.04), leafColorB: jitterHex(pal.leaf[1], r, 0.04), glowColor: jitterHex(pal.glow, r, 0.03),
    glow: r4(p.glow * (0.85 + 0.3 * r())), phase: r4(r() * TAU),
  };
}

function fernGeometry(it, D, b) {
  const segs = Math.round(lerp(8, 24, D.ribbon));
  const { fronds, crown, C } = fernFronds(it, segs);
  const glowC = col(it.glowColor), lA = col(it.leafColorA), lB = col(it.leafColorB);
  const amp = swayAmp(it), wp = windPhase(it);
  const SW = (hf) => [wp, amp, hf, it.phase];
  b.part('crown');
  const toWc = (lx, ly, lz) => C.clone().add(new V3(lx, ly + crown * 0.15, lz));
  b.lathe(toWc, [{ r: crown * 0.55, y: crown * 0.45 }, { r: crown, y: crown * 0.1 }, { r: crown * 0.9, y: -crown * 0.4 }], Math.max(6, D.lathe / 2),
    () => [lA.clone().multiplyScalar(0.55), glowC.clone().multiplyScalar(0.12 * it.glow), STEMGILL, SW(0)], { y: crown * 0.6 }, null,
    (i, a) => 1 + 0.12 * Math.cos(a * 3 + i));
  const nLeaf = Math.max(3, Math.round(it.leaflets * lerp(0.45, 1, D.ribbon)));
  const nq = D.ribbon > 0.8 ? 3 : D.ribbon > 0.5 ? 2 : 1;
  fronds.forEach((fr, fi) => {
    b.part('frond' + fi);
    const radii = fr.pts.map((_, k) => 0.0035 * (it.length / 0.5) * lerp(1.2, 0.5, fr.sArr[k]));
    b.tube(fr.pts, radii, Math.max(3, D.tubeR - 2), (k) => {
      const s = fr.sArr[k];
      return [lA.clone().lerp(lB, s).multiplyScalar(0.8), glowC.clone().multiplyScalar(it.glow * (0.3 + 0.4 * s)), STEMGILL, SW(s)];
    }, true);
    // leaflet pairs
    for (let q = 0; q < nLeaf; q++) {
      const sq = 0.12 + 0.86 * (q / Math.max(1, nLeaf - 1));
      const kf = sq * (fr.pts.length - 1);
      const k0 = Math.floor(kf), k1 = Math.min(fr.pts.length - 1, k0 + 1), w = kf - k0;
      const P = fr.pts[k0].clone().lerp(fr.pts[k1], w);
      const l = lerp(fr.leafLen(k0), fr.leafLen(k1), w);
      if (l < 0.004) continue;
      const T = new V3().subVectors(fr.pts[k1], fr.pts[Math.max(0, k0 - (k1 === k0 ? 1 : 0))]).normalize();
      if (T.lengthSq() < 0.5) continue;
      const side = new V3().crossVectors(T, UP);
      if (side.lengthSq() < 1e-6) side.set(-fr.o.z, 0, fr.o.x);
      side.normalize();
      const spacing = fr.Lf * 0.86 / Math.max(1, nLeaf - 1);
      for (const sgn of [-1, 1]) {
        const dir = side.clone().multiplyScalar(sgn * Math.cos(0.42)).addScaledVector(T, Math.sin(0.42)).addScaledVector(UP, -0.12).normalize();
        const Cl = [], Wl = [], Sl = [];
        for (let i = 0; i <= nq; i++) {
          const t = i / nq;
          const pos = P.clone().addScaledVector(dir, l * t).addScaledVector(UP, -0.1 * l * t * t);
          if (pos.y < 0.008) pos.y = 0.008;
          Cl.push(pos);
          Wl.push(Math.min(l * 0.34, spacing * 0.45) * Math.pow(Math.sin(Math.PI * (0.18 + 0.82 * t)), 0.8) + 0.0004);
          Sl.push(T);
        }
        b.ribbon(Cl, Sl, Wl, (k, j) => {
          const t = k / nq;
          const cc = lA.clone().lerp(lB, sq * 0.8 + 0.2 * t);
          const g = glowC.clone().multiplyScalar(it.glow * ((j === 0 ? 0.36 : 0.05) + 0.22 * t * t) * (0.5 + 0.5 * sq)).add(cc.clone().multiplyScalar(0.12 * it.glow));
          return [cc, g, NOGILL, SW(sq)];
        });
      }
    }
  });
}

function fernShape(it) {
  const { fronds, crown, C } = fernFronds(it, 28);
  const tubes = fronds.map((fr, fi) => {
    const h = fr.Lf / 28;
    return {
      part: 'frond' + fi, pts: fr.pts.map((p) => p.clone()), t: fr.sArr.slice(), w: fr.sArr.map((s) => swayAmp(it) * s * s),
      r: fr.pts.map((_, k) => 0.0035 * (it.length / 0.5) * 1.2 + fr.leafLen(k) * 1.1 + h * 0.6),
    };
  });
  const crownS = { part: 'crown', w: 0, center: C.clone().setY(crown * 0.25), inside(p, pad) { return p.distanceTo(this.center) <= crown * 1.15 + pad; } };
  return finishShape({ kind: 'fern', bulk: it.length, amp: swayAmp(it), solids: [crownS], samples: [], tubes });
}

// ================================================================== REED
function reedBlades(it, segs = 16) {
  const r = rng((it.seed || 1) >>> 0);
  const N = Math.max(3, Math.round(it.blades));
  const D = TAU / N;
  const C = new V3(it.x, 0, it.z);
  const halfWedge = D * 0.7 / 2;
  const blades = [];
  for (let k = 0; k < N; k++) {
    const az = (it.rot || 0) + k * D + (r() - 0.5) * D * 0.3;
    const o = new V3(Math.cos(az), 0, Math.sin(az));
    const side = new V3(-o.z, 0, o.x);
    const hb = it.height * (0.55 + 0.45 * r());
    const lb = it.lean * (0.4 + 0.9 * r());
    const hasPod = r() < it.orbs;
    const pts = [], sArr = [], W = [];
    let P = C.clone().addScaledVector(o, 0.012).setY(-0.02);
    const ds = hb / segs;
    const wBase = it.width * 0.011 * Math.sqrt(it.height / 0.7);
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      pts.push(P.clone()); sArr.push(s);
      const hd = Math.hypot(P.x - C.x, P.z - C.z);
      let w = wBase * (1 - 0.85 * Math.pow(s, 1.4)) * (hasPod ? 0.55 : 1);
      w = Math.min(w, hd * Math.sin(halfWedge) * 0.85 - 0.0012);
      W.push(Math.max(0.0006, w));
      const a = lb * (0.25 + 1.1 * s * s);
      P = P.clone().addScaledVector(o, Math.sin(a) * ds).addScaledVector(UP, Math.cos(a) * ds);
    }
    let pod = null;
    if (hasPod) {
      const sc = 0.76, kf = sc * segs, k0 = Math.floor(kf);
      const c = pts[k0].clone().lerp(pts[k0 + 1], kf - k0);
      const T = new V3().subVectors(pts[k0 + 1], pts[k0]).normalize();
      const lowEnd = c.clone().addScaledVector(T, -0.06 * hb);
      const hd = Math.hypot(lowEnd.x - C.x, lowEnd.z - C.z);
      const rp = Math.max(0.004, Math.min(it.orbSize * 0.02 * Math.sqrt(it.height / 0.7), hd * Math.sin(halfWedge) * 0.8 - 0.002));
      pod = { c, T, rp, half: Math.min(rp * 2.4, 0.055 * hb), s: sc };
    }
    blades.push({ az, o, side, pts, sArr, W, pod, hb });
  }
  return { blades, C };
}

function genReed(p, r, pal, x, z, sF = 1) {
  return {
    kind: 'reed', x: r4(x), z: r4(z), height: r4(p.size * (1 - p.sizeVariety * 0.5 * r()) * sF), blades: Math.round(p.blades),
    lean: r4(p.lean * (0.85 + 0.3 * r())), width: r4(p.width), orbs: r4(p.orbs), orbSize: r4(p.orbSize), rot: r4(r() * TAU),
    seed: Math.floor(r() * 1e9), bladeColorA: jitterHex(pal.reed[0], r, 0.04), bladeColorB: jitterHex(pal.reed[1], r, 0.04),
    glowColor: jitterHex(pal.glow, r, 0.03), glow: r4(p.glow * (0.85 + 0.3 * r())), phase: r4(r() * TAU),
  };
}

function reedGeometry(it, D, b) {
  const segs = Math.round(lerp(5, 16, D.ribbon));
  const { blades } = reedBlades(it, segs);
  const glowC = col(it.glowColor), cA = col(it.bladeColorA), cB = col(it.bladeColorB);
  const amp = swayAmp(it), wp = windPhase(it);
  const SW = (hf) => [wp, amp, hf, it.phase];
  blades.forEach((bl, bi) => {
    b.part('blade' + bi);
    b.ribbon(bl.pts, bl.pts.map(() => bl.side), bl.W, (k, j) => {
      const s = bl.sArr[k];
      const cc = cA.clone().lerp(cB, s).multiplyScalar(0.7 + 0.3 * s);
      const g = glowC.clone().multiplyScalar(it.glow * ((j === 0 ? 0.1 : 0.22) * Math.pow(s, 1.5) + 0.03));
      return [cc, g, NOGILL, SW(s * bl.hb / it.height)];
    });
    if (bl.pod) {
      const pd = bl.pod;
      const { X, Y, Z } = basisFrom(pd.T);
      const toW = (lx, ly, lz) => pd.c.clone().addScaledVector(X, lx).addScaledVector(Y, ly).addScaledVector(Z, lz);
      const rings = Math.round(lerp(3, 8, D.ribbon));
      const prof = [];
      for (let i = 1; i < rings; i++) { const v = i / rings; prof.push({ r: pd.rp * Math.sin(Math.PI * v), y: pd.half * Math.cos(Math.PI * v) }); }
      const hf = pd.s * bl.hb / it.height;
      b.lathe(toW, prof, Math.max(6, Math.round(D.lathe * 0.5)), (i, a) => {
        const cc = cB.clone().lerp(glowC, 0.35);
        return [cc, glowC.clone().lerp(cB, 0.3).multiplyScalar(it.glow * 0.9), [Math.cos(a), Math.sin(a), 0.9, 10], SW(hf)];
      }, { y: pd.half }, { y: -pd.half });
    }
  });
}

function reedShape(it) {
  const { blades } = reedBlades(it, 24);
  const tubes = [];
  blades.forEach((bl, bi) => {
    const h = bl.hb / 24;
    const A = swayAmp(it), hs = bl.hb / it.height;
    tubes.push({ part: 'blade' + bi, pts: bl.pts.map((p) => p.clone()), r: bl.W.map((w) => w + 0.001 + h * 0.15), t: bl.sArr.slice(), w: bl.sArr.map((s) => A * (s * hs) ** 2), ignoreMound: false });
    if (bl.pod) {
      const pd = bl.pod;
      tubes.push({ part: 'blade' + bi, pts: [pd.c.clone().addScaledVector(pd.T, -pd.half), pd.c.clone(), pd.c.clone().addScaledVector(pd.T, pd.half)],
        r: [pd.rp * 0.4, pd.rp * 1.05, pd.rp * 0.4], t: [pd.s, pd.s, pd.s], w: [0, 0, 0].map(() => swayAmp(it) * (pd.s * bl.hb / it.height) ** 2) });
    }
  });
  return finishShape({ kind: 'reed', bulk: it.height * 0.5, amp: swayAmp(it), solids: [], samples: [], tubes });
}

// ================================================================== MOUND
function moundFrame(mound) {
  const r = rng(mound.seed || 3);
  const bumps = Array.from({ length: 5 }, () => [r() * TAU, 0.6 + r() * 0.8]);
  return { bumps, R: mound.radius, Hh: mound.radius * 0.32, depth: mound.depth, cx: mound.x || 0, cz: mound.z || 0 };
}

export function buildMoundGeometry(mound, detail = 0) {
  const D = DETAIL[clamp(detail | 0, 0, 2)];
  const b = new GeoBuilder();
  const M = moundFrame(mound);
  const S = Math.max(10, D.capSeg), rings = Math.max(3, D.top - 2);
  const cc = col(mound.color), glowC = col(mound.glowColor);
  const pole = b.v(new V3(M.cx, M.Hh, M.cz), cc.clone().multiplyScalar(0.9), glowC.clone().multiplyScalar(0.12), STEMGILL, [0, 0, 0, 0]);
  const ringIdx = [];
  for (let k = 1; k <= rings; k++) {
    const u = k / rings;
    const ring = [];
    for (let j = 0; j < S; j++) {
      const a = (j / S) * TAU;
      let lump = 1;
      for (const [ba, bs] of M.bumps) lump += 0.12 * bs * Math.cos(a - ba) * Math.cos(a * 2 - ba);
      const rr = M.R * u * lump;
      const y = M.Hh * Math.pow(1 - u * u, 0.7) * lump - (u > 0.98 ? 0.03 : 0);
      ring.push(b.v(new V3(M.cx + Math.cos(a) * rr, y, M.cz + Math.sin(a) * rr * M.depth), cc.clone().multiplyScalar(0.7 + 0.3 * (1 - u)),
        glowC.clone().multiplyScalar(0.05 + 0.2 * Math.pow(1 - u, 2)).add(cc.clone().multiplyScalar(0.06)), STEMGILL, [0, 0, 0, 0]));
    }
    ringIdx.push(ring);
  }
  for (let j = 0; j < S; j++) b.tri(pole, ringIdx[0][(j + 1) % S], ringIdx[0][j]);
  for (let k = 0; k < ringIdx.length - 1; k++) for (let j = 0; j < S; j++) {
    const j2 = (j + 1) % S;
    b.quad(ringIdx[k][j], ringIdx[k][j2], ringIdx[k + 1][j2], ringIdx[k + 1][j]);
  }
  return b.geometry();
}

function moundSolid(mound) {
  const M = moundFrame(mound);
  return {
    part: 'mound', center: new V3(M.cx, 0, M.cz),
    inside(p, pad) {
      const dx = (p.x - M.cx) / (M.R * 1.22 + pad), dz = (p.z - M.cz) / (M.R * M.depth * 1.22 + pad), dy = p.y / (M.Hh * 1.25 + pad);
      return dy < 1.05 && dx * dx + dz * dz + Math.max(0, dy) * Math.max(0, dy) <= 1;
    },
  };
}

// ================================================================== kinds registry
const KINDS = {
  mushroom: { geometry: mushroomGeometry, shape: mushroomShape },
  lantern: { geometry: lanternGeometry, shape: lanternShape },
  fern: { geometry: fernGeometry, shape: fernShape },
  reed: { geometry: reedGeometry, shape: reedShape },
};

/** Geometry for one item (in patch space). geometry.userData.parts lists its named parts. */
export function buildItemGeometry(item, detail = 0) {
  const D = DETAIL[clamp(detail | 0, 0, 2)];
  const b = new GeoBuilder();
  KINDS[item.kind || 'mushroom'].geometry(item, D, b);
  return b.geometry();
}
export const buildMushroomGeometry = buildItemGeometry;

// ================================================================== generation
/**
 * Make a patch description: { version: 2, kind, params, mound, items: [...] }.
 * options.kind: 'mushroom' | 'lantern' | 'fern' | 'reed' | 'grove'; any DEFAULTS[kind] field can be set.
 * Items are plain objects (see ITEM_FIELDS for what each kind has); edit them and call
 * resolveCollisions(patch, { locked }) + buildPatch again.
 */
export function generatePatch(options = {}) {
  const kind = options.kind || 'mushroom';
  const p = { ...DEFAULTS[kind], ...options, kind };
  const pal = PALETTES[p.palette] || PALETTES.pastel;
  const r = rng(p.seed * 9973 + 17 + kind.length * 101);
  let items = [];
  let mound = null;
  if (kind === 'mushroom') {
    items = genMushrooms(p, r, pal, Math.max(1, Math.round(p.count)));
    if (p.mound > 0) mound = makeMound(p, pal, r);
  } else if (kind === 'grove') {
    const mp = { ...DEFAULTS.mushroom, ...p, kind: 'mushroom', spread: 0.32 * p.size / 0.55 * clamp(Math.sqrt(p.mushrooms / 12), 0.6, 1.6) };
    if (p.mushrooms > 0) {
      items = genMushrooms(mp, r, pal, Math.round(p.mushrooms));
      if (p.mound > 0) mound = makeMound(mp, pal, r);
    }
    const S = p.size / 0.55;
    const W = p.width * S;
    const place = (n, fn, ringR, zBias, sizeF) => {
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const x = side * (ringR + (0.15 + 0.5 * r()) * W * 0.6) * (1 + Math.floor(i / 2) * 0.55);
        const z = (zBias + (r() - 0.5) * 0.3) * p.depth * S;
        items.push(fn(x, z, sizeF * (0.85 + 0.3 * r())));
      }
    };
    const core = p.mushrooms > 0 ? mp.spread + 0.12 * S : 0.1 * S;
    place(Math.round(p.ferns), (x, z, f) => genFern({ ...DEFAULTS.fern, glow: p.glow, palette: p.palette, size: 0.5 * S }, r, pal, x, z, f), core + 0.25 * S, -0.35, 1);
    place(Math.round(p.reeds), (x, z, f) => genReed({ ...DEFAULTS.reed, glow: p.glow, palette: p.palette, size: 0.75 * S }, r, pal, x, z, f), core + 0.1 * S, -0.55, 1);
    place(Math.round(p.lanterns), (x, z, f) => genLantern({ ...DEFAULTS.lantern, glow: p.glow, palette: p.palette, size: 0.7 * S }, r, pal, x, z, f), core + 0.05 * S, 0.25, 1);
  } else {
    const n = Math.max(1, Math.round(p.count));
    const gen = { lantern: genLantern, fern: genFern, reed: genReed }[kind];
    for (let i = 0; i < n; i++) {
      const ang = r() * TAU, dist = p.spread * Math.sqrt(r());
      items.push(gen(p, r, pal, Math.cos(ang) * dist, Math.sin(ang) * dist * p.depth, 1));
    }
  }
  const patch = { version: 2, kind, params: p, mound, items };
  spreadFootprints(patch);
  if (p.collisions !== false) resolveCollisions(patch);
  return patch;
}

function makeMound(p, pal, r) {
  return {
    radius: r4(Math.max(0.05, p.spread * 0.75 + p.size * 0.05) * p.mound + 0.02), depth: p.depth, x: 0, z: 0,
    color: jitterHex(pal.stem, r, 0.02), glowColor: pal.glow, seed: Math.floor(r() * 1e9),
  };
}

/** Ground footprint radius of a plant (mushrooms cluster on purpose, so they have none). */
function footprint(it) {
  if (it.kind === 'lantern') return Math.max(it.leafLength * 0.9 + 0.012, it.stalkRadius * 3);
  if (it.kind === 'fern') {
    const { fronds, C } = fernFronds(it, 12);
    let m = 0.05;
    for (const fr of fronds) for (let k = 0; k < fr.pts.length; k++) m = Math.max(m, Math.hypot(fr.pts[k].x - C.x, fr.pts[k].z - C.z) + fr.leafLen(k) * 0.5);
    return m * 0.95;
  }
  if (it.kind === 'reed') {
    const { blades, C } = reedBlades(it, 10);
    let m = 0.03;
    for (const bl of blades) for (const q of bl.pts) m = Math.max(m, Math.hypot(q.x - C.x, q.z - C.z));
    return m * 0.75 + 0.01;
  }
  return 0;
}

/**
 * Quick 2D pass: push plant footprints apart (and off the mushroom cluster's mound) so crowded
 * patches widen out before the fine solver runs. Locked items stay put.
 */
export function spreadFootprints(patch, locked = []) {
  const lock = new Set(locked);
  const P = patch.items.map((it, i) => ({ it, i, f: footprint(it) })).filter((q) => q.f > 0);
  const fixed = [];
  if (patch.mound) fixed.push({ x: patch.mound.x || 0, z: patch.mound.z || 0, f: patch.mound.radius * 1.15 });
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let a = 0; a < P.length; a++) {
      const A = P[a];
      const others = P.slice(a + 1).map((B) => ({ x: B.it.x, z: B.it.z, f: B.f, B }));
      for (const o of others.concat(fixed)) {
        let dx = A.it.x - o.x, dz = A.it.z - o.z;
        let d = Math.hypot(dx, dz);
        const need = A.f + o.f;
        if (d >= need) continue;
        moved = true;
        if (d < 1e-6) { dx = Math.cos(a * 2.4 + pass); dz = Math.sin(a * 2.4 + pass); d = 1; }
        const push = (need - d) + 0.002;
        const aFree = !lock.has(A.i), bFree = o.B ? !lock.has(o.B.i) : false;
        const share = aFree && bFree ? 0.5 : aFree ? 1 : 0;
        A.it.x = r4(A.it.x + dx / d * push * share); A.it.z = r4(A.it.z + dz / d * push * share);
        if (o.B && bFree) { o.B.it.x = r4(o.B.it.x - dx / d * push * (1 - share)); o.B.it.z = r4(o.B.it.z - dz / d * push * (1 - share)); }
      }
    }
    if (!moved) break;
  }
  return patch;
}

/** Re-roll a patch with new params but keep per-item edits (overrides[i] = partial item); edited items stay put. */
export function generatePatchWithOverrides(params, overrides = {}) {
  const patch = generatePatch({ ...params, collisions: false });
  const locked = [];
  patch.items = patch.items.map((m, i) => {
    const o = overrides[i];
    if (!o) return m;
    if (Object.keys(o).some((k) => SHAPE_KEYS.has(k))) locked.push(i);
    return { ...m, ...o };
  });
  spreadFootprints(patch, locked);
  if (params.collisions !== false) resolveCollisions(patch, { locked });
  patch.params = { ...patch.params, collisions: params.collisions };
  return patch;
}

// ================================================================== collisions
// Shapes: solids (inside tests), surface samples (points with spacing d) and tubes (polylines
// with radii). Every element carries w = how far the wind can move it, so clearance is only
// added where things actually sway (none at the ground, full at the caps).
const CHUNK = 8;
function finishShape(s) {
  const box = new THREE.Box3();
  for (const t of s.tubes) {
    t.box = new THREE.Box3();
    t.chunks = [];
    for (let i0 = 0; i0 < t.pts.length - 1; i0 += CHUNK) {
      const i1 = Math.min(t.pts.length - 1, i0 + CHUNK);
      const cb = new THREE.Box3();
      let rmax = 0, wmax = 0;
      for (let k = i0; k <= i1; k++) { cb.expandByPoint(t.pts[k]); rmax = Math.max(rmax, t.r[k]); wmax = Math.max(wmax, t.w[k]); }
      cb.expandByScalar(rmax);
      t.chunks.push({ i0, i1, box: cb, rmax, wmax });
      t.box.union(cb);
    }
    let h = 0;
    for (let k = 1; k < t.pts.length; k++) h = Math.max(h, t.pts[k].distanceTo(t.pts[k - 1]));
    t.h = h;
    box.union(t.box);
  }
  for (const g of s.samples) { g.box = new THREE.Box3().setFromPoints(g.pts).expandByScalar(g.d); box.union(g.box); }
  for (const so of s.solids) {
    so.box = new THREE.Box3();
    const own = s.samples.filter((g) => g.part === so.part);
    if (own.length) own.forEach((g) => so.box.union(g.box)); else so.box.setFromCenterAndSize(so.center, new V3(0.15, 0.15, 0.15));
    box.union(so.box);
  }
  s.box = box;
  s.sphere = box.getBoundingSphere(new THREE.Sphere());
  s.center = s.sphere.center.clone();
  return s;
}

const _a = new V3(), _b = new V3(), _c3 = new V3(), _d3 = new V3(), _e3 = new V3();
function segSeg(p1, q1, p2, q2) {
  // closest points between segments p1q1 and p2q2 -> [dist, s, t]
  const d1 = _a.subVectors(q1, p1), d2 = _b.subVectors(q2, p2), r = _c3.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return [p1.distanceTo(p2), 0, 0];
  if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); } else {
    const c = d1.dot(r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); } else {
      const bb = d1.dot(d2), den = a * e - bb * bb;
      s = den > 1e-12 ? clamp((bb * f - c * e) / den, 0, 1) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((bb - c) / a, 0, 1); }
    }
  }
  _d3.copy(p1).addScaledVector(d1, s);
  _e3.copy(p2).addScaledVector(d2, t);
  return [_d3.distanceTo(_e3), s, t];
}
function pointSeg(p, a, b) {
  const ab = _a.subVectors(b, a);
  const l2 = ab.lengthSq();
  const t = l2 > 1e-12 ? clamp(_b.subVectors(p, a).dot(ab) / l2, 0, 1) : 0;
  return [_c3.copy(a).addScaledVector(ab, t).distanceTo(p), t];
}
const tubePoint = (tb, kf) => { const k = Math.min(Math.floor(kf), tb.pts.length - 2); return tb.pts[k].clone().lerp(tb.pts[k + 1], kf - k); };
const tubeT = (tb, kf) => { const k = Math.min(Math.floor(kf), tb.pts.length - 2); return lerp(tb.t[k], tb.t[k + 1], kf - k); };
function boxesNear(a, b, m) {
  return !(a.max.x + m < b.min.x || b.max.x + m < a.min.x || a.max.y + m < b.min.y || b.max.y + m < a.min.y || a.max.z + m < b.min.z || b.max.z + m < a.min.z);
}
const pointNearBox = (p, b, m) => p.x >= b.min.x - m && p.x <= b.max.x + m && p.y >= b.min.y - m && p.y <= b.max.y + m && p.z >= b.min.z - m && p.z <= b.max.z + m;

/** Clearance between two swaying points: base gap + relative wind movement. */
const SWAY_K = 1.17;
const gap = (wa, wb, ph) => 0.003 + SWAY_K * (Math.abs(wa - wb) + Math.min(wa, wb) * ph);

/** First contact between two shapes (null = clear). ph = wind phase difference bound. */
function collide(A, B, ph) {
  const mMax = gap(A.amp, B.amp, ph) + SWAY_K * Math.max(A.amp, B.amp);
  if (A.center.distanceTo(B.center) > A.sphere.radius + B.sphere.radius + mMax) return null;
  if (!boxesNear(A.box, B.box, mMax)) return null;
  for (const ta of A.tubes) for (const tb of B.tubes) {
    if (!boxesNear(ta.box, tb.box, mMax)) continue;
    for (const ca of ta.chunks) for (const cb of tb.chunks) {
      if (!boxesNear(ca.box, cb.box, gap(ca.wmax, cb.wmax, ph) + SWAY_K * Math.max(ca.wmax, cb.wmax))) continue;
      for (let i = ca.i0; i < ca.i1; i++) for (let j = cb.i0; j < cb.i1; j++) {
        const [d, s, t] = segSeg(ta.pts[i], ta.pts[i + 1], tb.pts[j], tb.pts[j + 1]);
        const m = gap(Math.max(ta.w[i], ta.w[i + 1]), Math.max(tb.w[j], tb.w[j + 1]), ph);
        if (d < Math.max(ta.r[i], ta.r[i + 1]) + Math.max(tb.r[j], tb.r[j + 1]) + m) {
          return { a: { p: tubePoint(ta, i + s), part: ta.part, t: tubeT(ta, i + s) }, b: { p: tubePoint(tb, j + t), part: tb.part, t: tubeT(tb, j + t) } };
        }
      }
    }
  }
  for (const [X, Y, flip] of [[A, B, false], [B, A, true]]) {
    const hit = (px, py) => (flip ? { a: py, b: px } : { a: px, b: py });
    for (const t of X.tubes) for (const so of Y.solids) {
      if (!boxesNear(t.box, so.box, mMax)) continue;
      for (let k = 0; k < t.pts.length; k++) {
        const m = gap(t.w[k], so.w, ph);
        if (!pointNearBox(t.pts[k], so.box, t.r[k] + t.h + m)) continue;
        if (so.inside(t.pts[k], t.r[k] + t.h * 0.5 + m)) return hit({ p: t.pts[k].clone(), part: t.part, t: t.t[k] }, { p: so.center.clone(), part: so.part, t: 1 });
      }
    }
    for (const g of X.samples) {
      for (const so of Y.solids) {
        const m = gap(g.w, so.w, ph);
        if (!boxesNear(g.box, so.box, m)) continue;
        for (const p of g.pts) if (pointNearBox(p, so.box, g.d + m) && so.inside(p, g.d + m)) return hit({ p: p.clone(), part: g.part, t: 1 }, { p: so.center.clone(), part: so.part, t: 1 });
      }
      for (const tb of Y.tubes) {
        if (!boxesNear(g.box, tb.box, mMax)) continue;
        for (const ch of tb.chunks) {
          const mc = gap(g.w, ch.wmax, ph) + SWAY_K * ch.wmax;
          if (!boxesNear(g.box, ch.box, mc)) continue;
          for (const p of g.pts) {
            if (!pointNearBox(p, ch.box, g.d + mc)) continue;
            for (let k = ch.i0; k < ch.i1; k++) {
              const [d, t] = pointSeg(p, tb.pts[k], tb.pts[k + 1]);
              const m = gap(g.w, Math.max(tb.w[k], tb.w[k + 1]), ph);
              if (d - lerp(tb.r[k], tb.r[k + 1], t) < g.d + m) {
                return hit({ p: p.clone(), part: g.part, t: 1 }, { p: tubePoint(tb, k + t), part: tb.part, t: tubeT(tb, k + t) });
              }
            }
          }
        }
      }
    }
  }
  return null;
}

/** Bound on the wind phase difference between two items (radians). */
function phaseBound(ia, ib) {
  return Math.min(1.5, Math.hypot(ia.x - ib.x, ia.z - ib.z) * 1.27);
}

/** Problems an item has on its own: ground, mound, self-intersection. */
function selfIssue(it, S, mound) {
  if (it.kind === 'mushroom') {
    let minY = Infinity;
    for (const g of S.samples) for (const p of g.pts) minY = Math.min(minY, p.y - g.d);
    if (minY < 0.012) return 'ground';
    const cap = S.solids[0], stem = S.tubes[0];
    for (let k = 0; k < stem.pts.length; k++) {
      if (stem.t[k] > 0.8) break;
      if (cap.inside(stem.pts[k], stem.r[k] + stem.h * 0.5 + 0.002 + SWAY_K * (S.amp - stem.w[k]))) return 'self';
    }
  }
  if (it.kind === 'lantern') {
    if (S.bulbBottom < 0.04) return 'ground';
    const bulb = S.solids[0], stalk = S.tubes[0];
    for (const lf of S.tubes.slice(1)) {
      for (let k = 0; k < lf.pts.length; k++) if (bulb.inside(lf.pts[k], lf.r[k] + 0.004 + SWAY_K * S.amp)) return 'leaf';
      for (let i = 0; i < stalk.pts.length - 1; i++) {
        if (stalk.t[i] < 0.12) continue;
        for (let j = 0; j < lf.pts.length - 1; j++) {
          const [d] = segSeg(stalk.pts[i], stalk.pts[i + 1], lf.pts[j], lf.pts[j + 1]);
          if (d < stalk.r[i] + Math.max(lf.r[j], lf.r[j + 1]) + 0.003 + SWAY_K * stalk.w[i + 1]) return 'leaf';
        }
      }
    }
  }
  if (mound) {
    const ms = moundSolid(mound);
    for (const g of S.samples) for (const p of g.pts) if (ms.inside(p, g.d + 0.004)) return 'mound';
    for (const t of S.tubes) {
      if (t.ignoreMound) continue;
      for (let k = 0; k < t.pts.length; k++) if (t.pts[k].y > 0.002 && ms.inside(t.pts[k], t.r[k] + 0.004)) return 'mound';
    }
  }
  return null;
}

function fixSelf(it, issue, attempt, mound) {
  if (issue === 'mound') {
    if (it.kind === 'mushroom' && attempt < 25) { it.height = r4(it.height + 0.012); return; }
    const c = mound ? new V3(mound.x || 0, 0, mound.z || 0) : new V3();
    const d = new V3(it.x - c.x, 0, it.z - c.z);
    if (d.lengthSq() < 1e-8) d.set(Math.cos(attempt), 0, Math.sin(attempt));
    d.normalize();
    it.x = r4(it.x + d.x * 0.02); it.z = r4(it.z + d.z * 0.02);
    return;
  }
  if (it.kind === 'mushroom') {
    if (issue === 'ground') { if (it.capTilt > 0.05) it.capTilt = r4(it.capTilt * 0.85); else it.height = r4(it.height + 0.012); }
    if (issue === 'self') {
      if (it.stemRadius > it.capRadius * 0.17) it.stemRadius = r4(it.capRadius * 0.17);
      else if (Math.abs(it.capTilt) > 0.03) it.capTilt = r4(it.capTilt * 0.8);
      else it.flare = r4(Math.min(1, it.flare + 0.15));
    }
  } else if (it.kind === 'lantern') {
    if (issue === 'ground') fixLanternHeight(it);
    it.height = r4(it.height + 0.015);
    if (issue === 'leaf' && attempt % 4 === 3) it.rot = r4((it.rot || 0) + 0.35);
  }
}

function nudge(it, S, self, other, attempt) {
  let d = new V3().subVectors(self.p, other.p);
  if (d.lengthSq() < 1e-10) d.subVectors(S.center, other.p);
  if (d.lengthSq() < 1e-10) d.set(Math.cos(attempt * 2.4), 0.2, Math.sin(attempt * 2.4));
  d.normalize();
  const dh = new V3(d.x, 0, d.z);
  if (dh.lengthSq() < 1e-6) dh.set(Math.cos(attempt * 2.4), 0, Math.sin(attempt * 2.4));
  dh.normalize();
  const out = new V3(it.x, 0, it.z);
  if (out.lengthSq() < 1e-8) out.set(Math.cos(attempt * 2.4), 0, Math.sin(attempt * 2.4));
  out.normalize();
  const step = (0.045 * S.bulk + 0.004) * (1 + Math.min(attempt, 60) * 0.03);
  const moveBase = (v, f) => { it.x = r4(it.x + v.x * step * f); it.z = r4(it.z + v.z * step * f); };
  if (attempt > 40) {
    // escape mode: keeps colliding, so walk out of the crowd (there is always room outside)
    moveBase(dh.multiplyScalar(0.5).addScaledVector(out, 1.5).normalize(), 1);
    if (attempt > 160) {
      if (it.kind === 'mushroom') { it.capRadius = r4(Math.max(0.02, it.capRadius * 0.96)); it.stemRadius = r4(Math.min(it.stemRadius, it.capRadius * 0.17)); }
      if (it.kind === 'lantern') { it.bulbRadius = r4(Math.max(0.012, it.bulbRadius * 0.96)); fixLanternHeight(it); }
    }
    return;
  }
  if (it.kind === 'mushroom') {
    const lowStem = self.part === 'stem' && self.t < 0.3;
    if (lowStem) moveBase(attempt > 8 ? dh.add(out).normalize() : dh, 1);
    else setMushroomTop(it, mushroomFrame(it).P3.addScaledVector(d, step));
  } else if (it.kind === 'lantern') {
    const high = self.part === 'bulb' || (self.part === 'stalk' && self.t > 0.45);
    if (high && attempt < 20) {
      const o = new V3(Math.cos(it.dir), 0, Math.sin(it.dir));
      it.dir = r4(it.dir + Math.sign(o.x * dh.z - o.z * dh.x || 1) * 0.12);
      if (d.y > 0.5) it.height = r4(it.height + step);
    } else moveBase(dh, 1);
  } else {
    moveBase(dh, 1);
  }
}

/**
 * Move items until nothing intersects (pairs, ground, mound, self), leaving room for the sway.
 * The smaller item of a touching pair moves; items listed in `locked` (e.g. ones you edited)
 * only move if they touch another locked item. Mutates patch.items.
 * Returns { passes, moves, remaining } — remaining is 0 when the patch is clean.
 */
export function resolveCollisions(patch, { locked = [], maxPasses = 600 } = {}) {
  const items = patch.items;
  const lock = new Set(locked);
  const shapes = items.map((it) => KINDS[it.kind].shape(it));
  const attempts = items.map(() => 0);
  let moves = 0, pass = 0;
  for (; pass < maxPasses; pass++) {
    let any = false;
    for (let i = 0; i < items.length; i++) {
      const issue = selfIssue(items[i], shapes[i], patch.mound);
      if (!issue) continue;
      any = true; moves++;
      fixSelf(items[i], issue, attempts[i]++, patch.mound);
      shapes[i] = KINDS[items[i].kind].shape(items[i]);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const hit = collide(shapes[i], shapes[j], phaseBound(items[i], items[j]));
      if (!hit) continue;
      any = true; moves++;
      const li = lock.has(i), lj = lock.has(j);
      let mv;
      if (li !== lj) mv = li ? j : i; else mv = shapes[i].bulk <= shapes[j].bulk ? i : j;
      const self = mv === i ? hit.a : hit.b, other = mv === i ? hit.b : hit.a;
      nudge(items[mv], shapes[mv], self, other, attempts[mv]++);
      shapes[mv] = KINDS[items[mv].kind].shape(items[mv]);
    }
    if (!any) break;
  }
  return { passes: pass, moves, remaining: countCollisions(patch, shapes) };
}

/** List every contact (for debugging / tests). */
export function listCollisions(patch) {
  const items = patch.items;
  const S = items.map((it) => KINDS[it.kind].shape(it));
  const out = [];
  for (let i = 0; i < items.length; i++) { const s = selfIssue(items[i], S[i], patch.mound); if (s) out.push({ i, issue: s }); }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const h = collide(S[i], S[j], phaseBound(items[i], items[j]));
    if (h) out.push({ i, j, a: h.a.part + '@' + h.a.t.toFixed(2), b: h.b.part + '@' + h.b.t.toFixed(2) });
  }
  return out;
}

/** How many contacts a patch has (0 = clean). */
export function countCollisions(patch, shapes = null) {
  const items = patch.items;
  const S = shapes || items.map((it) => KINDS[it.kind].shape(it));
  let n = 0;
  for (let i = 0; i < items.length; i++) if (selfIssue(items[i], S[i], patch.mound)) n++;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (collide(S[i], S[j], phaseBound(items[i], items[j]))) n++;
  }
  return n;
}

// ================================================================== material
const SHARED = { material: null };

/**
 * One material for everything: vertex-coloured physical material (iridescent sheen), per-vertex
 * emission, glowing gill / rib lines, fresnel rim, inner glow in stems and stalks, slow pulse
 * and coherent wind sway — all in the shader.
 * quality: 'high' (MeshPhysicalMaterial) or 'low' (MeshStandardMaterial, no iridescence/sheen).
 */
export function createGlowshroomMaterial({ quality = 'high', iridescence = 0.4, uniforms } = {}) {
  const U = uniforms || {
    uTime: { value: 0 }, uGlow: { value: 1 }, uPulse: { value: 0.18 }, uSway: { value: 1 }, uRim: { value: 0.3 },
  };
  const high = quality === 'high';
  const mat = high
    ? new THREE.MeshPhysicalMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0, iridescence, iridescenceIOR: 1.35,
      iridescenceThicknessRange: [180, 520], sheen: 0.25, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'),
      clearcoat: 0.3, clearcoatRoughness: 0.4,
    })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aGlow; attribute vec4 aGill; attribute vec4 aSway;
uniform float uTime; uniform float uSway;
varying vec3 vGlow; varying vec4 vGill; varying float vPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float hf = aSway.z * aSway.z;
  float w = uTime * 1.15 + aSway.x;
  transformed.x += sin(w) * aSway.y * hf * uSway;
  transformed.z += cos(w * 0.83 + 0.6) * aSway.y * hf * uSway * 0.6;
  vGlow = aGlow; vGill = aGill; vPhase = aSway.w;
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uGlow; uniform float uPulse; uniform float uRim;
varying vec3 vGlow; varying vec4 vGill; varying float vPhase;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float pulse = 1.0 + uPulse * sin(uTime * 1.5 + vPhase * 3.0);
  float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.5);
  float k = 1.0;
  if (vGill.z > 0.01) {
    float ang = atan(vGill.y, vGill.x);
    float line = 1.0 - smoothstep(0.0, 0.42, abs(sin(ang * vGill.w * 0.5)));
    float half_ = (1.0 - smoothstep(0.0, 0.3, abs(sin(ang * vGill.w)))) * smoothstep(0.75, 0.2, vGill.z);
    k = 0.25 + 1.25 * max(line, half_ * 0.65);
  } else if (vGill.z < -0.5) {
    k = 0.55 + 0.9 * pow(1.0 - fres, 2.0);
  }
  totalEmissiveRadiance += vGlow * (k * pulse + fres * uRim) * uGlow;
}`);
  };
  mat.customProgramCacheKey = () => 'glowshroom2-' + quality;
  mat.side = THREE.FrontSide;
  mat.userData.uniforms = U;
  return mat;
}

export function glowshroomMaterial() {
  if (!SHARED.material) SHARED.material = createGlowshroomMaterial();
  return SHARED.material;
}

/** Advance sway + pulse for everything using the shared material (or pass your own). */
export function updateGlowshrooms(time, material = glowshroomMaterial()) {
  material.userData.uniforms.uTime.value = time;
}

/** Global look controls on a material: glow, pulse, sway, rim (multipliers). */
export function setGlowshroomLook(look, material = glowshroomMaterial()) {
  const U = material.userData.uniforms;
  if (look.glow !== undefined) U.uGlow.value = look.glow;
  if (look.pulse !== undefined) U.uPulse.value = look.pulse;
  if (look.sway !== undefined) U.uSway.value = look.sway;
  if (look.rim !== undefined) U.uRim.value = look.rim;
}

// ================================================================== patch
let _poolTex = null;
function glowPoolTexture() {
  if (_poolTex) return _poolTex;
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
    const a = Math.round(255 * Math.pow(Math.max(0, 1 - d), 2.2));
    const i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = a; data[i + 3] = 255;
  }
  _poolTex = new THREE.DataTexture(data, n, n);
  _poolTex.needsUpdate = true;
  return _poolTex;
}

const LABEL = { mushroom: 'Mushroom', lantern: 'Lantern', fern: 'Fern', reed: 'Reed' };

/**
 * Build a THREE.Group from a patch description.
 *   merge  true: one mesh for the whole patch (1 draw call). false: one mesh per item, named
 *          '<Kind>_<i>' with userData.index (for editors / picking / removal).
 *   detail 0 (close-up) .. 2 (distant)
 *   pool   strength of the additive glow decal on the ground (0 = none)
 *   light  0 = none, otherwise intensity multiplier for a soft PointLight above the patch
 */
export function buildPatch(patch, { material = glowshroomMaterial(), detail = 0, merge = true, light = 0, pool = 1 } = {}) {
  const items = patch.items || patch.mushrooms || [];
  for (const it of items) if (!it.kind) it.kind = 'mushroom';
  const group = new THREE.Group();
  group.name = 'GlowFloraPatch';
  const geos = items.map((it) => buildItemGeometry(it, detail));
  if (patch.mound) geos.push(buildMoundGeometry(patch.mound, detail));
  if (merge) {
    const geo = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'GlowFlora';
    mesh.receiveShadow = true;
    group.add(mesh);
  } else {
    geos.forEach((g, i) => {
      const mesh = new THREE.Mesh(g, material);
      const isMound = i >= items.length;
      mesh.name = isMound ? 'Mound' : `${LABEL[items[i].kind]}_${i}`;
      mesh.userData.index = isMound ? -1 : i;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
  }
  if ((light > 0 || pool > 0) && items.length) {
    const c = new THREE.Color(0, 0, 0);
    let w = 0, maxH = 0;
    const box = new THREE.Box3();
    for (const it of items) {
      c.add(new THREE.Color(it.glowColor).multiplyScalar(it.glow));
      w += it.glow;
      maxH = Math.max(maxH, it.height || it.length || 0.3);
      box.expandByPoint(new V3(it.x, 0, it.z));
    }
    c.multiplyScalar(1 / Math.max(w, 1e-6));
    const meanGlow = w / items.length;
    const size = patch.params?.size ?? 0.55;
    if (pool > 0) {
      const ext = box.getSize(new V3());
      const ctr = box.getCenter(new V3());
      const Rx = ext.x / 2 + size * 1.1, Rz = Math.max(ext.z / 2 + size * 0.6, Rx * 0.35);
      const mat = new THREE.MeshBasicMaterial({
        map: glowPoolTexture(), color: c.clone().multiplyScalar(0.55 * pool * meanGlow), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      });
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(2 * Rx, 2 * Rz), mat);
      decal.name = 'GlowPool';
      decal.rotation.x = -Math.PI / 2;
      decal.position.set(ctr.x, 0.004, ctr.z);
      decal.renderOrder = 1;
      group.add(decal);
    }
    if (light > 0) {
      const pl = new THREE.PointLight(c, 0.12 * light * Math.sqrt(items.length) * meanGlow * (size / 0.55) ** 2, 5 * size / 0.55, 2);
      pl.name = 'PatchGlow';
      pl.position.set(0, maxH * 1.35 + 0.05, 0.1);
      group.add(pl);
    }
  }
  group.userData.patch = patch;
  return group;
}
