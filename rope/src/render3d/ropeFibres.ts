import * as THREE from "three";
import { ROPE_STRAND_RADIUS } from "../render/ropeLay";

// The surface of one rope strand, as a colour (tone) map and a normal map in
// the strand's own coordinates: u once round its circumference, v along it.
//
// A strand is yarns twisted the OTHER way to the lay, so on the strand's skin
// they run at a shallow angle across it, each yarn a bundle of a few fibres
// with stray hairs lifting off them. The yarns are drawn as lines that wrap
// the circumference exactly once over one tile, which is what makes the tile
// seamless both ways without a seam down the fibres: every yarn comes back to
// itself. Built once, from a fixed seed, and shared by every rope.
//
// The fibres are a texture rather than a shader pattern for the mipmaps: a
// 2 mm fibre at the game's distance is under a pixel, and a procedural stripe
// there shimmers where a filtered texture fades to the strand's average.

const WIDTH = 256, HEIGHT = 2048;
const YARNS = 22, FIBRES = 3;
const HAIRS = 150;
// Metres along the strand per tile, set by the yarns' angle across it: one
// wrap of the circumference per tile is a fixed tan(angle) = C / tile. A
// shallow angle: on a hard-laid rope the yarns run nearly with the strand.
const YARN_ANGLE = 9 * Math.PI / 180;
export const ROPE_FIBRE_TILE = 2 * Math.PI * ROPE_STRAND_RADIUS / Math.tan(YARN_ANGLE);
// How steep the yarns' sides read, in height per texel to normal tilt.
const RELIEF = 4.5;

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RopeFibreMaps { readonly color: THREE.DataTexture; readonly normal: THREE.DataTexture; }

let maps: RopeFibreMaps | null = null;

// The shared maps, built on first use.
export function ropeFibreMaps(): RopeFibreMaps {
  return maps ??= buildMaps();
}

function buildMaps(): RopeFibreMaps {
  const rand = random(0x4d616e69);
  const height = new Float32Array(WIDTH * HEIGHT), tone = new Float32Array(WIDTH * HEIGHT).fill(.8);
  // Where yarns overlap the surface is the higher of them, and a hard max
  // flips from one to the other between texel rows along the crease, which
  // reads as a dotted line. A soft max (log-sum-exp, sharpness `SOFT`) rounds
  // the crease and blends the two yarns' shades across it.
  const SOFT = 24;
  const weight = new Float32Array(WIDTH * HEIGHT), shaded = new Float32Array(WIDTH * HEIGHT);
  const wrapU = (u: number): number => ((u % WIDTH) + WIDTH) % WIDTH;
  const wrapV = (v: number): number => ((v % HEIGHT) + HEIGHT) % HEIGHT;

  // Each yarn's and each fibre's own wobble and shade. Every along-the-strand
  // variation is a whole number of periods per tile, so the tile closes.
  const yarns = Array.from({ length: YARNS }, (_, y) => ({
    centre: (y + .5 + (rand() - .5) * .2) / YARNS * WIDTH,
    // Wider than the spacing, so neighbours always overlap - jittered apart
    // and at their narrowest too - and meet in a soft crease rather than
    // leaving a bare line between them.
    half: WIDTH / YARNS * .75 * (1 + (rand() - .5) * .2),
    wobble: (.6 + rand()) * (rand() < .5 ? -1 : 1), cycles: 1 + Math.floor(rand() * 4), phase: rand() * Math.PI * 2,
    fibres: Array.from({ length: FIBRES }, (_, f) => ({
      at: (f + .5) / FIBRES * 2 - 1 + (rand() - .5) * .25,
      wobble: .5 + rand() * .8, cycles: 2 + Math.floor(rand() * 7), phase: rand() * Math.PI * 2,
      shade: .8 + rand() * .26,
      streaks: Array.from({ length: 3 }, () => ({ cycles: 3 + Math.floor(rand() * 20), phase: rand() * Math.PI * 2, depth: rand() * .09 })),
    })),
  }));
  // A row's fibre positions and shades, which do not vary across the yarn.
  const at = new Float64Array(FIBRES), own = new Float64Array(FIBRES);
  for (let v = 0; v < HEIGHT; v++) {
    const t = v / HEIGHT, turn = t * Math.PI * 2;
    for (const yarn of yarns) {
      const centre = yarn.centre + t * WIDTH + yarn.wobble * Math.sin(turn * yarn.cycles + yarn.phase);
      for (let f = 0; f < FIBRES; f++) {
        const fibre = yarn.fibres[f]!;
        at[f] = fibre.at + fibre.wobble / yarn.half * Math.sin(turn * fibre.cycles + fibre.phase);
        own[f] = fibre.shade;
        for (const streak of fibre.streaks) own[f] -= streak.depth * (.5 + .5 * Math.sin(turn * streak.cycles + streak.phase));
      }
      for (let du = Math.floor(-yarn.half) - 1; du <= Math.ceil(yarn.half) + 1; du++) {
        const u = Math.round(centre) + du, x = (u - centre) / yarn.half;
        if (Math.abs(x) >= 1) continue;
        // The yarn is round; its fibres are rounder ridges on it.
        // Shallow between yarns: they are packed into one strand, not laid
        // side by side.
        const body = .35 + .65 * Math.pow(1 - x * x, .6);
        // The fibres' shades blend by the same soft max as the yarns'.
        let ridge = 0, shade = 0, fibreWeight = 0;
        for (let f = 0; f < FIBRES; f++) {
          const r = (x - at[f]!) * FIBRES * .9;
          const lift = r * r < 1 ? 1 - r * r : 0;
          ridge = Math.max(ridge, lift);
          const w = Math.exp(8 * lift);
          shade += w * own[f]!; fibreWeight += w;
        }
        shade /= fibreWeight;
        const w = Math.exp(SOFT * body * (.5 + .5 * ridge)), k = wrapU(u) + v * WIDTH;
        weight[k] += w;
        shaded[k] += w * shade;
      }
    }
  }
  for (let k = 0; k < WIDTH * HEIGHT; k++) {
    if (!weight[k]) continue;
    height[k] = Math.log(weight[k]!) / SOFT;
    tone[k] = shaded[k]! / weight[k]!;
  }

  // Stray hairs: short, fine and a touch lighter, lifted off the yarns at a
  // small angle to them, drawn wrapped so they cross the tile's edges too.
  for (let i = 0; i < HAIRS; i++) {
    const u0 = rand() * WIDTH, v0 = rand() * HEIGHT, length = 12 + rand() * 40;
    const angle = (rand() - .5) * .9;
    const du = Math.sin(angle), dv = Math.cos(angle), lift = .04 + rand() * .08, shade = .98 + rand() * .08;
    for (let s = 0; s <= length; s += .5) {
      const bend = .04 * s * s / length;
      const cu = u0 + du * s + dv * bend, cv = v0 + dv * s - du * bend;
      const fade = Math.sin(Math.PI * s / length);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const u = Math.round(cu) + a, v = Math.round(cv) + b;
        const near = Math.max(0, 1 - Math.hypot(u - cu, v - cv) / 1.1) * fade;
        if (!near) continue;
        const k = wrapU(u) + wrapV(v) * WIDTH;
        const h = Math.min(1, Math.max(height[k]!, .78) + lift) * near + height[k]! * (1 - near);
        if (h <= height[k]!) continue;
        height[k] = h;
        tone[k] = tone[k]! * (1 - near) + shade * near;
      }
    }
  }

  // Deep between yarns is shadowed fibre, and darker fibre is browner: the
  // tone is a multiplier on the rope's colour, warmed as it darkens - by
  // channel, one table entry per green byte.
  const warmRed = new Uint8Array(256), warmBlue = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    warmRed[i] = Math.round(255 * Math.pow(i / 255, .88));
    warmBlue[i] = Math.round(255 * Math.pow(i / 255, 1.18));
  }
  const color = new Uint8Array(WIDTH * HEIGHT * 4), normal = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let v = 0; v < HEIGHT; v++) for (let u = 0; u < WIDTH; u++) {
    const k = u + v * WIDTH, o = k * 4, h = height[k]!;
    const g = Math.round(255 * Math.max(0, Math.min(1, tone[k]! * (.5 + .5 * h) * (.97 + .06 * rand()))));
    color[o] = warmRed[g]!;
    color[o + 1] = g;
    color[o + 2] = warmBlue[g]!;
    color[o + 3] = 255;
    const dhdu = (height[wrapU(u + 1) + v * WIDTH]! - height[wrapU(u - 1) + v * WIDTH]!) / 2;
    const dhdv = (height[u + wrapV(v + 1) * WIDTH]! - height[u + wrapV(v - 1) * WIDTH]!) / 2;
    const nx = -dhdu * RELIEF, ny = -dhdv * RELIEF, n = Math.hypot(nx, ny, 1);
    normal[o] = Math.round(255 * (nx / n * .5 + .5));
    normal[o + 1] = Math.round(255 * (ny / n * .5 + .5));
    normal[o + 2] = Math.round(255 * (1 / n * .5 + .5));
    normal[o + 3] = 255;
  }
  return { color: texture(color, THREE.SRGBColorSpace), normal: texture(normal, THREE.NoColorSpace) };
}

function texture(data: Uint8Array, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const map = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.colorSpace = colorSpace;
  map.needsUpdate = true;
  return map;
}
