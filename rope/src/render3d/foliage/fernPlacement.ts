import * as THREE from "three";
import { VineSurface } from "./vine/hangingVine";
import { generateFern, disposeFern, type FernSettings } from "./vine/fern";
function rayToRock(rockSurface: VineSurface, from: THREE.Vector3, dir: THREE.Vector3, max: number): number {
  if (!rockSurface) return Infinity;
  let t = 0; const p = new THREE.Vector3();
  for (let i = 0; i < 40 && t < max; i++) {
    p.copy(from).addScaledVector(dir, t);
    const h = rockSurface.nearest(p, max);
    if (!h || h.distance > max) return Infinity;
    if (h.distance < 0.008) return t;
    t += h.distance;
  }
  return Infinity;
}
/** How good a spot is for a fern: enclosed (a crack or inside corner) and facing up, plus its open side. */
function scoreFernSpot(rockSurface: VineSurface, point: THREE.Vector3, normal: THREE.Vector3): { score: number; open: THREE.Vector3 } {
  const tA = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const tB = new THREE.Vector3().crossVectors(normal, tA).normalize();
  const from = point.clone().addScaledVector(normal, 0.04), open = new THREE.Vector3();
  let hits = 0, cramped = 0, total = 0;
  for (const elev of [0.35, 0.95]) for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2 + elev;
    const d = tA.clone().multiplyScalar(Math.cos(a)).addScaledVector(tB, Math.sin(a)).multiplyScalar(Math.cos(elev)).addScaledVector(normal, Math.sin(elev)).normalize();
    total++;
    const dist = rayToRock(rockSurface, from, d, 0.6);
    if (dist < 0.6) hits++; else open.add(d);
    if (dist < 0.22) cramped++;                       // a slot too tight for fronds to unfurl
  }
  if (open.lengthSq() < 1e-6) open.copy(normal);
  open.normalize();
  const enclosure = hits / total, up = Math.max(0, normal.y);
  return { score: normal.y < -0.2 ? -1 : 0.55 * enclosure + 0.45 * up, open };
}
/** The best fern spots on the rock: sampled by area, scored, spaced at least `spacing` apart. */
export function findFernSpots(rockSurface: VineSurface, soup: Float32Array, fernSettingsUI: FernSettings, existingRoots: THREE.Vector3[], count: number, spacing: number, scatterSeed = 12345): { point: THREE.Vector3; normal: THREE.Vector3; open: THREE.Vector3 }[] {
  if (!rockSurface || soup.length < 9) return [];
  const tris = soup.length / 9, areas = new Float32Array(tris); let sum = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tri = new THREE.Triangle();
  for (let i = 0; i < tris; i++) { tri.set(a.fromArray(soup, i * 9), b.fromArray(soup, i * 9 + 3), c.fromArray(soup, i * 9 + 6)); sum += tri.getArea(); areas[i] = sum; }
  let seed = scatterSeed; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const cands: { point: THREE.Vector3; normal: THREE.Vector3; open: THREE.Vector3; score: number }[] = [];
  for (let k = 0; k < 220; k++) {
    const target = rnd() * sum; let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (areas[mid] < target) lo = mid + 1; else hi = mid; }
    tri.set(a.fromArray(soup, lo * 9), b.fromArray(soup, lo * 9 + 3), c.fromArray(soup, lo * 9 + 6));
    let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const point = a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), v);
    const normal = tri.getNormal(new THREE.Vector3());
    if (normal.y < 0.15) continue;
    const { score, open } = scoreFernSpot(rockSurface, point, normal);
    cands.push({ point, normal, open, score });
  }
  cands.sort((x, y) => y.score - x.score);
  const out: typeof cands = [];
  for (const cnd of cands) {
    if (out.length >= count) break;
    if (out.some(o => o.point.distanceTo(cnd.point) < spacing)) continue;
    if (existingRoots.some(root => root.distanceTo(cnd.point) < spacing)) continue;
    // Trial grow: skip slots where most fronds would have nowhere to go.
    try {
      const trial = generateFern(rockSurface, { version: 1, kind: "fern", root: cnd.point.toArray(), normal: cnd.normal.toArray(), open: cnd.open.toArray(), settings: { ...fernSettingsUI, seed: 4242 + out.length * 97 } }, { quick: true });
      disposeFern(trial.group);
      if (trial.frondCount < Math.round(fernSettingsUI.fronds) * 0.5) continue;
    } catch { continue; }
    out.push(cnd);
  }
  return out;
}
