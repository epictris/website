import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { VineSurface, rand, tangentOn, pointHitsObstacle, tubeGeometry, setRingAttribute, type VineObstacle } from "./hangingVine";
import { LEAF_SHADES } from "./hangingLeafProfiles";
import fernAtlasInfo from "../assets/ferns/ferns.json";
import leafletAtlasInfo from "../assets/leaflets/leaflets.json";
import sprigInfo from "../assets/sprig/sprig.json";

/**
 * Stylised painterly ferns that sprout from cracks and ledges in a rock.
 *
 * A clump is a rosette of fronds from one crown. Each frond is one painted card (from
 * the fern atlas) bent along an arching curve: it rises out of the crack, leans toward
 * the open side, and droops under gravity toward its tip. Croziers (coiled young fronds)
 * stand upright in the middle as two crossed cards. Shading is "clump" shading: card
 * normals are blended toward a dome around the crown, so the clump lights as one soft
 * painted mass. All coordinates in metres, Y up.
 *
 * Two varieties share the placement, layering and contact rules:
 *  - "painted": each frond is one painted card from the fern sheet;
 *  - "leaflet": each frond is built like a real compound leaf: a tapered stem (the rachis,
 *    a swept cylinder) carries pairs of leaflet stems (pinnae, thinner cylinders), and each
 *    pinna carries pairs of tiny painted leaves plus one at its tip. With "Tiny leaves" at 0
 *    the leaves sit straight on the rachis instead (a once-divided frond).
 */
export interface FernSettings {
  fronds: number; length: number; lengthVar: number; droop: number; spread: number;
  lean: number; fold: number; twist: number; croziers: number;
  paintTint: number; shades: string; pieces: string; seed: number;
  /** "painted" = one painted card per frond; "leaflet" = stems with pairs of tiny leaves */
  variety: FernVariety;
  /** leaflet ferns: leaflet pairs along each frond, and tiny leaves per side of each leaflet (0 = single leaves) */
  pinnae: number; leaflets: number;
  /** leaflet ferns: leaf size, as a multiple of the reference-based size */
  leafSize: number;
  /** leaflet ferns: how curved the leaves are (0 = flat; crease, tip curl and sideways sweep) */
  leafCurve: number;
  /** leaflet ferns: "smooth" leaves joined straight to the stem, or "creased" (deeply folded, overlapping like shingles) */
  leafForm: "smooth" | "creased";
  /** leaflet ferns: the two leaves of a pair are mirror images, the same size and colour */
  mirrorPairs: boolean;
  /** leaflet ferns: how much leaves vary in colour and size (0 = all alike) */
  leafVariation: number;
}
export type FernVariety = "painted" | "leaflet" | "sprig";
/** Settings that differ by variety; applied when a fern switches variety or is reset. The leaflet
 *  defaults follow the stylised references: fewer, longer fronds of single leaves. */
/** The creased leaflet fern: deeply creased leaves overlapping like shingles (an earlier look, kept as a variation). */
export const CREASED_DEFAULTS: Partial<FernSettings> = { variety: "leaflet", leafForm: "creased", pinnae: 14, leaflets: 0, leafSize: 0.8, leafCurve: 0.5, mirrorPairs: false, leafVariation: 0.6 };
export function varietyDefaults(variety: FernVariety): Partial<FernSettings> {
  if (variety === "sprig") return { variety, fronds: 10, length: 0.55, spread: 55, droop: 0.45, pinnae: 8, leaflets: 0, leafSize: 1, leafCurve: 0.4, mirrorPairs: true, leafVariation: 0.3, fold: 0.5 };
  return variety === "leaflet"
    ? { variety, fronds: 9, length: 0.55, spread: 52, droop: 0.42, pinnae: 16, leaflets: 0, leafSize: 0.8, leafCurve: 0.5, leafForm: "smooth", mirrorPairs: true, leafVariation: 0.3, fold: 0.55 }
    : { variety, fronds: 18, length: 0.45, spread: 50, droop: 0.55, fold: 0.55 };
}
export const DEFAULT_FERN_SETTINGS: FernSettings = {
  fronds: 18, length: 0.45, lengthVar: 0.3, droop: 0.55, spread: 50,
  lean: 0.55, fold: 0.55, twist: 0.3, croziers: 2,
  paintTint: 0.6, shades: "", pieces: "all", seed: 4242,
  variety: "painted", pinnae: 12, leaflets: 0, leafSize: 0.8, leafCurve: 0.5, leafForm: "smooth", mirrorPairs: true, leafVariation: 0.3,
};
export interface FernRecipe {
  version: 1; kind: "fern";
  /** crown on the rock, the rock's normal there, and the open side the clump leans toward */
  root: [number, number, number]; normal: [number, number, number]; open: [number, number, number];
  settings: FernSettings;
}
export interface FernResult { group: THREE.Group; frondCount: number; leafletCount: number; obstacles: VineObstacle[] }

export type FernPiece = {
  id: string; kind: "frond" | "crozier"; geometryAspect: number;
  baseUv: [number, number]; tipUv: [number, number];
  atlasRect: [number, number, number, number]; scale: number; avgColour: string;
  /** leafy half-width at 13 heights (base to tip), as a fraction of the card's half-width */
  widthProfile?: number[];
};
export const FERN_PIECES = fernAtlasInfo.pieces as FernPiece[];
export type LeafletPiece = { id: string; geometryAspect: number; baseUv: [number, number]; atlasRect: [number, number, number, number]; avgColour: string;
  /** the leaf's extent left / right of its stalk at 11 heights (stalk to tip), as fractions of the card width */
  profileLeft?: number[]; profileRight?: number[]; mirrored?: boolean };
export const LEAFLET_PIECES = leafletAtlasInfo.pieces as LeafletPiece[];
/** The painted sprig (a small stem carrying leaves) used as the "leaf" of the sprig fern. */
export const SPRIG_PIECE = (sprigInfo.pieces as LeafletPiece[])[0];
/** The rounder half of the leaves: used for tiny leaves on leaflet stems. */
const BROAD_LEAVES = LEAFLET_PIECES.filter(p => p.geometryAspect >= 0.47);
/** Narrower, pointed leaves (width 0.3–0.47 of length), like the references' single leaves. */
const NARROW_LEAVES = LEAFLET_PIECES.filter(p => p.geometryAspect >= 0.3 && p.geometryAspect < 0.47);
/** The same leaf flipped left to right, for the other side of a pair, so pairs are true mirror images. */
const mirroredCache = new Map<string, LeafletPiece>();
function mirrorPiece(p: LeafletPiece): LeafletPiece {
  let m = mirroredCache.get(p.id);
  if (!m) { m = { ...p, baseUv: [1 - p.baseUv[0], p.baseUv[1]], profileLeft: p.profileRight, profileRight: p.profileLeft, mirrored: true }; mirroredCache.set(p.id, m); }
  return m;
}

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));            // 137.5 degrees
const PAINT_SCALE = 0.6;
const FERN_TRANSLUCENCY = 0.45;
const CROWN_SKIP = 0.35;   // fronds may touch in their lower third, near the crown, as real ones do
/** Tiny leaves: angle from their leaflet stem, an unseen stalk (fraction of the leaf) that keeps the
 *  two leaves of a pair apart at the stem, and how far a leaf may reach toward the next leaflet
 *  (fraction of the gap between leaflets) so neighbouring leaflets' leaves just meet. */
const SPRIG_ROLL = 0.55;   // sprig fern: how far each sprig is turned about its axis (radians), like a louvre slat
const TINY_ANGLE = 60, TINY_STALK = -0.03, TINY_REACH = 0.55;   // leaves start right on the stem (tucked in a little)

const RANGES: [keyof FernSettings, number, number][] = [
  ["fronds", 1, 24], ["length", 0.05, 3], ["lengthVar", 0, 1], ["droop", 0, 1], ["spread", 5, 85],
  ["lean", 0, 1], ["fold", 0, 1], ["twist", 0, 1], ["croziers", 0, 6], ["paintTint", 0, 1], ["seed", 0, 2147483647],
  ["pinnae", 3, 30], ["leaflets", 0, 14], ["leafSize", 0.3, 2], ["leafCurve", 0, 1], ["leafVariation", 0, 1],
];
export function validateFernRecipe(r: FernRecipe): void {
  if (!r || r.version !== 1 || r.kind !== "fern" || !r.settings) throw new Error("Invalid fern recipe.");
  // Projects saved before the leaflet variety existed: fill in the new settings.
  r.settings.variety ??= "painted"; r.settings.pinnae ??= DEFAULT_FERN_SETTINGS.pinnae; r.settings.leaflets ??= DEFAULT_FERN_SETTINGS.leaflets; r.settings.leafSize ??= DEFAULT_FERN_SETTINGS.leafSize; r.settings.leafCurve ??= DEFAULT_FERN_SETTINGS.leafCurve; r.settings.leafForm ??= "smooth"; r.settings.mirrorPairs ??= true; r.settings.leafVariation ??= DEFAULT_FERN_SETTINGS.leafVariation;
  if (typeof r.settings.mirrorPairs !== "boolean") throw new Error("Fern mirrorPairs must be true or false.");
  if (r.settings.leafForm !== "smooth" && r.settings.leafForm !== "creased") throw new Error("Fern leaf form must be smooth or creased.");
  if (!["painted", "leaflet", "sprig"].includes(r.settings.variety)) throw new Error("Fern variety must be painted, leaflet or sprig.");
  for (const key of ["root", "normal", "open"] as const) {
    const v = r[key];
    if (!Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 10_000)) throw new Error(`Invalid fern ${key}.`);
  }
  for (const [key, min, max] of RANGES) {
    const v = r.settings[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`Fern ${key} must be between ${min} and ${max}.`);
  }
  if (typeof r.settings.pieces !== "string" || !/^[a-z0-9_+-]{1,2000}$/.test(r.settings.pieces)) throw new Error("Invalid fern pieces.");
  if (typeof r.settings.shades !== "string" || !/^[a-z+]{0,80}$/.test(r.settings.shades)) throw new Error("Invalid fern shades.");
}

/** Grow one fern clump. `avoid` = other plants' obstacles (vine leaves and stems, other ferns). */
export function generateFern(positions: Float32Array | number[] | VineSurface, recipe: FernRecipe,
  options: { texture?: THREE.Texture; leafletTexture?: THREE.Texture; sprigTexture?: THREE.Texture; avoid?: VineObstacle[]; /** fewer retries and no mesh: for quickly testing a spot */ quick?: boolean } = {}): FernResult {
  validateFernRecipe(recipe);
  const s = recipe.settings;
  const surface = positions instanceof VineSurface ? positions : new VineSurface(positions);
  const r = (i: number, salt: number) => rand(s.seed, i, salt);
  const normal = new THREE.Vector3(...recipe.normal).normalize();
  const anchor = surface.nearest(new THREE.Vector3(...recipe.root));
  if (!anchor || anchor.distance > 0.15) throw new Error("The fern's crown is no longer on this rock. Place it again.");
  const crown = anchor.point.clone().addScaledVector(normal, 0.008);
  // Lean: the open side, flattened onto the rock's tangent plane.
  const openT = tangentOn(new THREE.Vector3(...recipe.open), normal);
  const tanA = tangentOn(Math.abs(normal.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0), normal);
  const tanB = new THREE.Vector3().crossVectors(normal, tanA).normalize();
  // The rosette's axis tilts toward the open side (Lean), so fronds stay evenly spread around it
  // instead of bunching up on one side.
  const axis = normal.clone().addScaledVector(openT, s.lean * 0.9).normalize();
  const axA = tangentOn(tanA, axis), axB = new THREE.Vector3().crossVectors(axis, axA).normalize();

  const chosen = s.pieces === "all" ? [] : s.pieces.split("+");
  const fronds = FERN_PIECES.filter(p => p.kind === "frond" && (!chosen.length || chosen.includes(p.id)));
  const frondPool = fronds.length ? fronds : FERN_PIECES.filter(p => p.kind === "frond");
  const crozierPool = FERN_PIECES.filter(p => p.kind === "crozier");
  const wanted = s.shades.split("+").filter(Boolean);
  const shades = (wanted.length ? LEAF_SHADES.filter(x => wanted.includes(x.id)) : LEAF_SHADES).map(x => new THREE.Color(x.hex));
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const byLight = (shades.length ? shades : [new THREE.Color(LEAF_SHADES[3].hex)]).sort((a, b) => lum(a) - lum(b));

  const mesh = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], col: [] as number[], sway: [] as number[], idx: [] as number[] };
  const obstacles: VineObstacle[] = [];
  const avoid = options.avoid ?? [];
  const dome = crown.clone().addScaledVector(normal, -0.3 * s.length);   // centre of the clump's shading dome
  let frondCount = 0;

  type Frame = { p: THREE.Vector3; T: THREE.Vector3; W: THREE.Vector3; F: THREE.Vector3 };
  /** Width (W) and face (F) directions along a centre line, with `rollTurns` of twist toward the tip. */
  const framesOf = (line: THREE.Vector3[], rollTurns: number): Frame[] => {
    const ROWS = line.length - 1, out: Frame[] = [];
    let prevW: THREE.Vector3 | null = null;
    for (let row = 0; row <= ROWS; row++) {
      const T = line[Math.min(row + 1, ROWS)].clone().sub(line[Math.max(row - 1, 0)]).normalize();
      let W = new THREE.Vector3().crossVectors(T, UP);
      if (W.lengthSq() < 0.02) W = prevW ? prevW.clone().addScaledVector(T, -prevW.dot(T)) : new THREE.Vector3().crossVectors(T, tanA);   // upright stalk: keep the last width axis
      W.normalize();
      if (prevW && W.dot(prevW) < 0) W.negate();
      W.applyAxisAngle(T, rollTurns * row / ROWS);
      const F = new THREE.Vector3().crossVectors(W, T).normalize();
      if (F.y < 0 && !prevW) { W.negate(); F.negate(); }
      prevW = W.clone();
      out.push({ p: line[row], T, W, F });
    }
    return out;
  };
  /** Fold down the midrib: each half tilts down from the centre line, curling a little more toward
   *  the edge, so a frond is a ridge with drooping pinnae rather than a flat card. */
  const foldAngle = (foldAmt: number, edge: number, v: number) => foldAmt * 0.95 * (0.6 + 0.8 * edge * edge) * Math.min(1, v * 6 + 0.3);
  const cardSize = (piece: FernPiece, length: number, widthScale = 1) => {
    const size = length / Math.max(0.5, 1 - piece.baseUv[1]);
    const width = size * piece.geometryAspect * widthScale;
    return { width, half: width * Math.max(piece.baseUv[0], 1 - piece.baseUv[0]) };
  };
  const profileAt = (piece: FernPiece, v: number) => {
    const prof = piece.widthProfile; if (!prof) return Math.sin(Math.PI * Math.min(1, v * 1.1)) ** 0.6;
    const x = v * (prof.length - 1), i = Math.min(prof.length - 2, Math.floor(x));
    return prof[i] + (prof[i + 1] - prof[i]) * (x - i);
  };

  /** How wide a frond is: `reach(v)` = its leafy half-width at height v (0 = crown, 1 = tip),
   *  `half` = the widest it can be (the fold angle grows toward that edge). */
  type Shape = { half: number; reach: (v: number) => number; /** set for fronds whose sides rise (a V trough): the rise angle */ lift?: number };
  /** Where a point `d` across a frond (signed, metres) sits: [across, up] in the frond's W/F frame. */
  const across = (shape: Shape, fold: number, d: number, v: number): [number, number] => {
    if (shape.lift !== undefined) return [d * Math.cos(shape.lift), Math.abs(d) * Math.sin(shape.lift)];
    const th = foldAngle(fold, Math.abs(d) / shape.half, v);
    return [Math.sign(d) * Math.abs(d) * Math.cos(th), -Math.abs(d) * Math.sin(th)];
  };
  const paintedShape = (piece: FernPiece, length: number): Shape => {
    const { half } = cardSize(piece, length); return { half, reach: v => half * profileAt(piece, v) };
  };
  /** A frond already in the clump, kept so later fronds can be tested against it. */
  type Placed = { frames: Frame[]; shape: Shape; fold: number; bound: THREE.Sphere };
  /** A sphere around the leafy part of a card (above the crown zone), for a quick reject. */
  const boundOf = (frames: Frame[], half: number) => {
    const pts = frames.slice(Math.floor((frames.length - 1) * CROWN_SKIP)).map(f => f.p);
    const sphere = new THREE.Sphere().setFromPoints(pts); sphere.radius += half; return sphere;
  };
  const placed: Placed[] = [];
  /** True when a candidate card would pass through (or touch) a frond already placed. Each candidate
   *  is sampled along five lines (edges, quarter-widths, midrib); a sample is tested against the
   *  nearest row of each placed frond: within that frond's leafy width and within `gap` of its
   *  folded surface, or crossing from one side of it to the other between rows, is a collision.
   *  The stalks near the crown (lower 20 %) are ignored, where all fronds meet anyway. */
  const collidesWithClump = (frames: Frame[], shape: Shape, fold: number, gap: number) => {
    const half = shape.half, ROWS = frames.length - 1, bound = boundOf(frames, half);
    for (const other of placed) {
      if (!bound.intersectsSphere(other.bound)) continue;
      const oRows = other.frames.length - 1, oStep = other.frames[1].p.distanceTo(other.frames[0].p);
      for (const lateral of [-1, -0.5, 0, 0.5, 1]) {
        let prevH: number | null = null;
        for (let i = Math.ceil(ROWS * CROWN_SKIP); i <= ROWS; i++) {
          const v = i / ROWS, fr = frames[i];
          const [x, y] = across(shape, fold, lateral * shape.reach(v) * 0.8, v);
          const q = fr.p.clone().addScaledVector(fr.W, x).addScaledVector(fr.F, y);
          let best = -1, bestD = Infinity;
          for (let j = 0; j <= oRows; j++) { const dd = q.distanceToSquared(other.frames[j].p); if (dd < bestD) { bestD = dd; best = j; } }
          const ov = best / oRows, of = other.frames[best];
          const rel = q.clone().sub(of.p);
          const b = rel.dot(of.W), reach = other.shape.reach(ov);
          if (ov < CROWN_SKIP || Math.abs(rel.dot(of.T)) > oStep * 0.75 || Math.abs(b) > reach) { prevH = null; continue; }
          const surf = other.shape.lift !== undefined ? Math.abs(b) * Math.tan(other.shape.lift) : -Math.abs(b) * Math.sin(foldAngle(other.fold, Math.abs(b) / other.shape.half, ov));
          const hgt = rel.dot(of.F) - surf;
          if (Math.abs(hgt) < gap || (prevH !== null && Math.sign(hgt) !== Math.sign(prevH))) return true;
          prevH = hgt;
        }
      }
    }
    return false;
  };

  /** True when the leafy part of a card would dip into the rock: the card is sampled at nine points
   *  across its leafy width (folded as it will be drawn) on every row. */
  const cardHitsRock = (frames: Frame[], shape: Shape, fold: number, pad: number) => {
    const half = shape.half, ROWS = frames.length - 1;
    for (let i = 1; i <= ROWS; i++) {
      const v = i / ROWS, fr = frames[i], reach = shape.reach(v) * 0.95;
      for (let k = -4; k <= 4; k++) {
        const [x, y] = across(shape, fold, reach * k / 4, v);
        const q = fr.p.clone().addScaledVector(fr.W, x).addScaledVector(fr.F, y);
        const h = surface.nearest(q, pad * 4);
        if (h && h.signed < pad) return true;
      }
    }
    return false;
  };

  /** Add one painted card along precomputed frames. */
  const addCard = (piece: FernPiece, frames: Frame[], length: number, age: number, key: number, foldAmt: number) => {
    const COLS = 8, ROWS = frames.length - 1;
    const { width } = cardSize(piece, length);
    const [ru, rv, rw, rh] = piece.atlasRect;
    // Colour: the painted colour tinted toward a green picked by age (outer, older fronds darker).
    const spread = (r(key, 8) - 0.5) * byLight.length * 0.4;
    const shade = byLight[Math.min(byLight.length - 1, Math.max(0, Math.round((1 - age) * (byLight.length - 1) + spread)))];
    const avg = new THREE.Color(piece.avgColour);
    const tinted = new THREE.Color(1, 1, 1).lerp(new THREE.Color(shade.r / Math.max(avg.r, 1e-3), shade.g / Math.max(avg.g, 1e-3), shade.b / Math.max(avg.b, 1e-3)), s.paintTint);
    const tone = PAINT_SCALE * (0.92 + r(key, 5) * 0.12);
    const offset = mesh.pos.length / 3;
    let along = 0;
    for (let row = 0; row <= ROWS; row++) {
      const v = row / ROWS, { p: c, W, F } = frames[row];
      if (row) along += c.distanceTo(frames[row - 1].p);
      for (let col = 0; col <= COLS; col++) {
        const u = col / COLS, du = u - piece.baseUv[0];
        const edge = Math.abs(du) / Math.max(piece.baseUv[0], 1 - piece.baseUv[0]);
        const side = Math.sign(du), th = foldAngle(foldAmt, edge, v);
        const d = Math.abs(du) * width;
        const p = c.clone().addScaledVector(W, side * d * Math.cos(th)).addScaledVector(F, -d * Math.sin(th));
        mesh.pos.push(p.x, p.y, p.z);
        // Each half gets its own tilted normal (so the fold reads), blended toward a dome around the
        // crown (so the clump shades as one soft mass), plus a little lift toward the sky.
        const fn = F.clone().multiplyScalar(Math.cos(th)).addScaledVector(W, side * Math.sin(th));
        const n = fn.lerp(p.clone().sub(dome).normalize(), 0.35).normalize().addScaledVector(UP, 0.3).normalize();
        mesh.nrm.push(n.x, n.y, n.z);
        mesh.uv.push(ru + u * rw, rv + v * rh);
        const f = (0.74 + 0.30 * THREE.MathUtils.smoothstep(v, 0, 0.7)) * (1 - 0.06 * edge);   // darker toward the crown
        mesh.col.push(tinted.r * tone * f, tinted.g * tone * f, tinted.b * tone * f);
        mesh.sway.push(along * 2.5);
      }
    }
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
      const a = offset + row * (COLS + 1) + col, b = a + COLS + 1;
      mesh.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  };

  // ---- Leaflet fronds -------------------------------------------------------------------------
  const leafMeshMain = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], col: [] as number[], sway: [] as number[], idx: [] as number[] };
  const sprigMesh = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], col: [] as number[], sway: [] as number[], idx: [] as number[] };
  const tubes: THREE.BufferGeometry[] = [];
  let leafletCount = 0;
  const PINNA_LEN = 0.2;                                    // longest leaflet stem, as a fraction of the frond
  /** Angle of leaves (or leaflet stems) from the rachis, pointing tipward: about 50° all along for
   *  single leaves, as in the references; leaflet stems open wider near the base. */
  const pinnaAngle = (v: number) => THREE.MathUtils.degToRad(sprig ? 56 - 12 * v : once() ? 58 - 10 * v : 64 - 22 * v);
  /** Outline of a twice-divided frond: bare stalk at the base, widest about a third of the way up, to a point. */
  // Like real fern fronds: longest a little above the bare stalk, then steadily shorter to the tip.
  const outline2 = (v: number) => v < 0.1 ? 0 : v < 0.2 ? 0.8 + 0.2 * (v - 0.1) / 0.1 : 1 - 0.8 * (v - 0.2) / 0.8;
  /** Outline of a once-divided frond (as in the stylised references): leaves about 60 % size at the
   *  base, largest a third of the way up, shrinking steadily to about a quarter at the tip. */
  const outline1 = (v: number) => v < 0.06 ? 0 : v < 0.3 ? 0.6 + 0.4 * THREE.MathUtils.smoothstep(v, 0.06, 0.3) : 1 - 0.75 * Math.pow((v - 0.3) / 0.67, 1.2);
  /** Sprig fern: painted sprigs set at an angle along one stem (each sprig is a single card). */
  const sprig = s.variety === "sprig";
  const once = () => sprig || Math.round(s.leaflets) === 0;
  const creased = s.leafForm === "creased";
  const frondOutline = (v: number) => once() ? outline1(v) : outline2(v);
  /** Leaves rise from their stem in a V (as in the reference), more with Fold. */
  const leafLift = () => once() ? 0.6 * s.fold : 0.3 + 0.45 * s.fold;   // ≈ 19° (single leaves) / 31° at the default
  const pinnaLift = () => 0.35 * s.fold;                   // leaflet stems rise from the rachis (≈ 11°)
  const ONCE_LEN = sprig ? 0.3 : 0.32;                                   // longest single leaf, as a fraction of the frond (references: 0.2–0.3)
  const leafletShape = (length: number): Shape => {
    const lp = length * (once() ? ONCE_LEN * s.leafSize : PINNA_LEN);
    return { half: lp * Math.sin(pinnaAngle(0.3)) * 1.1, reach: v => lp * frondOutline(v) * Math.sin(pinnaAngle(v)) * 1.1,
      lift: once() ? leafLift() : pinnaLift() + 0.4 * leafLift() };
  };
  const STEM_BASE = new THREE.Color("#4e4a30"), STEM_MID = new THREE.Color("#616f3c"), STEM_TIP = new THREE.Color("#74863f");   // from the painted twig
  const stemColour = (f: number) => (f < 0.4 ? STEM_BASE.clone().lerp(STEM_MID, f / 0.4) : STEM_MID.clone().lerp(STEM_TIP, (f - 0.4) / 0.6)).multiplyScalar(0.6);
  /** A swept, tapering cylinder with per-ring colour and sway. */
  const addTube = (pts: THREE.Vector3[], radius: number, sides: number, tip: number, colourAt: (f: number) => THREE.Color, swayAt: (d: number) => number) => {
    const geo = tubeGeometry(pts, radius, sides, tip);
    const along = pts.map((_, i) => 0); for (let i = 1; i < pts.length; i++) along[i] = along[i - 1] + pts[i].distanceTo(pts[i - 1]);
    const total = Math.max(along[along.length - 1], 1e-6);
    setRingAttribute(geo, "sway", along.map(d => [swayAt(d)]));
    setRingAttribute(geo, "color", along.map(d => { const c = colourAt(d / total); return [c.r, c.g, c.b]; }));
    geo.deleteAttribute("uv"); tubes.push(geo);
  };
  // ---- Tiny leaves, placed one at a time so none passes through another --------------------------
  /** A placed leaf: its stalk point, frame (along, across, face), card size and visible length. */
  type LeafCard = { base: THREE.Vector3; dir: THREE.Vector3; wv: THREE.Vector3; n0: THREE.Vector3; size: number; width: number; left: number; right: number; len: number; cup: number; curl: number; bend: number; profL?: number[]; profR?: number[]; centre: THREE.Vector3; radius: number };
  const LEAF_CELL = Math.max(0.05, s.length * Math.max(1, s.leafSize) * (sprig ? 0.4 : Math.round(s.leaflets) === 0 ? 0.22 : 0.16));   // ≥ two leaf radii
  const leafGrid = new Map<string, LeafCard[]>();
  const cellOf = (p: THREE.Vector3) => [Math.floor(p.x / LEAF_CELL), Math.floor(p.y / LEAF_CELL), Math.floor(p.z / LEAF_CELL)];
  const leafCard = (base: THREE.Vector3, dir: THREE.Vector3, face: THREE.Vector3, len: number, piece: LeafletPiece, toward?: THREE.Vector3): LeafCard => {
    const size = len / Math.max(0.5, 1 - piece.baseUv[1]), width = size * piece.geometryAspect;
    const wv = new THREE.Vector3().crossVectors(dir, face).normalize();
    const n0 = new THREE.Vector3().crossVectors(wv, dir).normalize();
    if (n0.dot(face) < 0) { wv.negate(); n0.negate(); }
    return { base: base.clone(), dir: dir.clone(), wv, n0, size, width, left: width * piece.baseUv[0], right: width * (1 - piece.baseUv[0]), len,
      // Leaf curve: a crease down the midrib (edges up), the tip curling down, and (single leaves) a
      // sideways sweep toward the frond tip. Overlapping leaves are kept apart by the clash test.
      // Creased form: a deep crease (edges well up), a stronger tip curl, scaled by Leaf curve (0.5 = as first made).
      cup: sprig ? 0.06 * s.leafCurve : creased ? 0.25 * s.leafCurve : 0.02 + 0.16 * s.leafCurve, curl: sprig ? 0.02 + 0.12 * s.leafCurve : creased ? 0.28 * s.leafCurve : 0.03 + 0.2 * s.leafCurve,
      // Single leaves curve a little toward the frond tip (sickle-shaped, as in the references).
      bend: toward && once() && !sprig ? (creased ? 0.2 * s.leafCurve : 0.03 + 0.14 * s.leafCurve) * Math.sign(toward.dot(wv)) : 0, profL: piece.profileLeft, profR: piece.profileRight, centre: base.clone().addScaledVector(dir, len * 0.5), radius: Math.hypot(len * 0.5, width) + 0.002 };
  };
  /** The visible leaf is a lens: half-width at distance `a` along it. */
  const halfWAt = (c: LeafCard, a: number, x: number) => {
    const t = a / c.len; if (t <= 0 || t >= 1) return 0;
    const prof = x < 0 ? c.profL : c.profR;
    if (!prof) return (x < 0 ? c.left : c.right) * Math.sqrt(4 * t * (1 - t));
    // The leaf's measured outline (plus a 4 % margin), so leaves are tested by their real shape.
    const f = t * (prof.length - 1), i = Math.min(prof.length - 2, Math.floor(f));
    return (prof[i] + (prof[i + 1] - prof[i]) * (f - i)) * c.width * 1.04 + 0.0005;
  };
  /** Height of the leaf's surface above its flat frame: cupped (edges up), tip curling down. */
  const heightAt = (c: LeafCard, a: number, x: number) => c.cup * Math.abs(x) - Math.pow(Math.max(0, a / c.size), 2) * c.size * c.curl;
  /** Sideways offset of the leaf's midrib at `a` (its curve toward the frond tip). */
  const bendAt = (c: LeafCard, a: number) => c.bend ? c.bend * c.len * Math.pow(Math.max(0, a) / c.len, 2) : 0;
  /** A point on the leaf: `a` along it, `x` across from its (curved) midrib. */
  const pointOn = (c: LeafCard, a: number, x: number) => c.base.clone().addScaledVector(c.dir, a).addScaledVector(c.wv, x + bendAt(c, a)).addScaledVector(c.n0, heightAt(c, a, x));
  const SAMPLE_A = [0.04, 0.15, 0.27, 0.39, 0.5, 0.61, 0.73, 0.85, 0.96], SAMPLE_X = [-1, -0.67, -0.33, 0, 0.33, 0.67, 1];
  /** Sample points across a leaf (rows along it, columns across), flattened x, y, z. */
  const samplesOf = (c: LeafCard) => {
    const out = new Float64Array(SAMPLE_A.length * SAMPLE_X.length * 3); let k = 0;
    for (const af of SAMPLE_A) for (const xf of SAMPLE_X) {
      const a = af * c.len, x = xf * halfWAt(c, a, xf), h = heightAt(c, a, x), xb = x + bendAt(c, a);
      out[k++] = c.base.x + c.dir.x * a + c.wv.x * xb + c.n0.x * h;
      out[k++] = c.base.y + c.dir.y * a + c.wv.y * xb + c.n0.y * h;
      out[k++] = c.base.z + c.dir.z * a + c.wv.z * xb + c.n0.z * h;
    }
    return out;
  };
  const sampleCache = new WeakMap<LeafCard, Float64Array>();
  const samples = (c: LeafCard) => { let v = sampleCache.get(c); if (!v) { v = samplesOf(c); sampleCache.set(c, v); } return v; };
  const NA = SAMPLE_A.length, NX = SAMPLE_X.length, heights = new Float64Array(NA * NX), valid = new Uint8Array(NA * NX);
  /** True when leaf `c` touches or passes through leaf `o`: points across `c` are measured against
   *  `o`'s surface; a point within `gap` of it inside its outline, or two neighbouring points on
   *  opposite sides of it, is a clash. Checked along both rows and columns of samples. */
  const leafClash = (c: LeafCard, o: LeafCard, skip = 0) => {
    const gap = Math.max(0.0012, Math.min(0.0025, 0.03 * Math.min(c.len, o.len)));   // a few millimetres
    // Quick reject: c (a sphere) cannot reach o's curved surface.
    const cx = c.centre.x - o.base.x, cy = c.centre.y - o.base.y, cz = c.centre.z - o.base.z;
    const ch = cx * o.n0.x + cy * o.n0.y + cz * o.n0.z, ca = cx * o.dir.x + cy * o.dir.y + cz * o.dir.z, cw = cx * o.wv.x + cy * o.wv.y + cz * o.wv.z;
    if (ch > c.radius + o.cup * Math.max(o.left, o.right) + gap || ch < -c.radius - o.curl * o.size - gap) return false;
    if (ca < -c.radius || ca > o.len + c.radius || cw < -o.left - c.radius - Math.abs(o.bend) * o.len || cw > o.right + c.radius + Math.abs(o.bend) * o.len) return false;
    const pts = samples(c);
    const bx = o.base.x, by = o.base.y, bz = o.base.z;
    for (let k = 0; k < NA * NX; k++) {
      // `skip`: leaves that meet at the stem may touch over their first part (as real leaflets do).
      if (skip && SAMPLE_A[Math.floor(k / NX)] < skip) { valid[k] = 0; continue; }
      const qx = pts[k * 3] - bx, qy = pts[k * 3 + 1] - by, qz = pts[k * 3 + 2] - bz;
      const ao = qx * o.dir.x + qy * o.dir.y + qz * o.dir.z;
      if (ao <= skip * o.len || ao >= o.len) { valid[k] = 0; continue; }
      const xo = qx * o.wv.x + qy * o.wv.y + qz * o.wv.z - bendAt(o, ao);
      if (Math.abs(xo) > halfWAt(o, ao, xo)) { valid[k] = 0; continue; }
      const g = qx * o.n0.x + qy * o.n0.y + qz * o.n0.z - heightAt(o, ao, xo);
      if (Math.abs(g) < gap) return true;
      valid[k] = 1; heights[k] = g;
    }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NX; j++) {
      const k = i * NX + j; if (!valid[k]) continue;
      if (j + 1 < NX && valid[k + 1] && Math.sign(heights[k + 1]) !== Math.sign(heights[k])) return true;
      if (i + 1 < NA && valid[k + NX] && Math.sign(heights[k + NX]) !== Math.sign(heights[k])) return true;
    }
    return false;
  };
  /** Leaves already placed near `p` (within `reach` plus their own size). */
  const leavesNear = (p: THREE.Vector3, reach: number) => {
    const [gx, gy, gz] = cellOf(p), out: LeafCard[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const o of leafGrid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) if (o.centre.distanceTo(p) <= o.radius + reach) out.push(o);
    return out;
  };
  const clashesWithLeaves = (c: LeafCard, near: LeafCard[]) => {
    for (const o of near) {
      if (o.centre.distanceTo(c.centre) > o.radius + c.radius) continue;
      const skip = c.base.distanceTo(o.base) < 0.3 * Math.min(c.len, o.len) ? 0.2 : 0;
      if (leafClash(c, o, skip) || leafClash(o, c, skip)) return true;
    }
    return false;
  };
  // Pairs only lie higher, tilt or turn a little, and at most shrink to 85 %, so leaf sizes stay even.
  // (all turn about the leaf's base, so leaves always stay joined to their stem)
  // [tilt up (rad), turn (rad), size, raise (in stem radii: the base stays on the stem's surface)]
  const PAIR_VARIANTS: [number, number, number, number][] = [[0, 0, 1, 0], [0, 0, 1, 0.8], [0.1, 0, 1, 0.8], [0.1, 0, 1, 0], [0.2, 0, 1, 0.8], [-0.1, 0, 1, 0.8],
    [0.3, 0, 1, 0.8], [0, 0.12, 1, 0.8], [0, -0.12, 1, 0.8], [0.15, 0.12, 1, 0.8], [0.15, -0.12, 1, 0.8], [0.1, 0, 0.85, 0.8], [0.25, 0, 0.85, 0.8],
    [0.2, 0.2, 0.85, 0.8], [0.2, -0.2, 0.85, 0.8]];
  /** One tiny painted leaf: its stalk end at `base`, pointing along `dir`, face toward `face`.
   *  It is a 3 × 3 card, cupped upward and curling down a little toward its tip. It is only
   *  added where it clears the rock and every leaf already placed. */
  let leafStemR = 0.002;   // radius of the stem the current leaves grow from
  type LeafAsk = { base: THREE.Vector3; dir: THREE.Vector3; face: THREE.Vector3; len: number; side: number; piece: LeafletPiece; colour: THREE.Color; sway: number; toward?: THREE.Vector3; stagger?: number };
  /** Place a pair of opposite leaves (or one tip leaf) together: both get the same change, so the
   *  two sides stay the same size and shape; if no change fits both, neither is added. */
  const addLeafGroup = (group: LeafAsk[]) => {
    const near = leavesNear(group[0].base, Math.max(...group.map(g => g.len)) * 1.25 + 0.004);
    for (const [up, turn, scale, raise] of PAIR_VARIANTS) {
      const cards = group.map(g => {
        const d = g.dir.clone();
        if (turn) d.applyAxisAngle(g.face, turn * g.side);          // mirrored on the two sides
        const tilt = up + (g.stagger ?? 0);
        if (tilt) {
          const fp = g.face.clone().addScaledVector(d, -g.face.dot(d)).normalize();
          d.multiplyScalar(Math.cos(tilt)).addScaledVector(fp, Math.sin(tilt)).normalize();
        }
        // The leaf's base sits on the stem, tucked in a little so it reads as joined.
        // Every leaf's base sits on its stem (tucked in a little), raised at most a stem radius,
        // so no leaf floats; leaves make room only by turning or tilting about that base.
        const base = g.base.clone().addScaledVector(d, TINY_STALK * g.len * scale);
        if (raise) base.addScaledVector(g.face, raise * leafStemR);
        return leafCard(base, d, g.face, g.len * scale, g.piece, g.toward);
      });
      // Clear of the rock at the tip, along the midrib and at both edges (where a crease lifts or drops them).
      const touchesRock = (c: LeafCard) => [[0.95, 0], [0.5, 0], [0.25, 0], [0.5, -0.9], [0.5, 0.9], [0.75, -0.8], [0.75, 0.8], [0.3, -0.8], [0.3, 0.8]]
        .some(([af, xf]) => { const a = af * c.len; return insideRock(pointOn(c, a, xf * halfWAt(c, a, xf)), 0.004); });
      if (cards.some(touchesRock)) continue;
      if (cards.some(c => clashesWithLeaves(c, near))) continue;
      if (cards.length === 2 && (leafClash(cards[0], cards[1], 0.2) || leafClash(cards[1], cards[0], 0.2))) continue;
      cards.forEach((c, i) => {
        writeLeaf(c, group[i].piece, group[i].colour, group[i].sway);
        const key = cellOf(c.centre).join(",");
        (leafGrid.get(key) ?? leafGrid.set(key, []).get(key)!).push(c);
      });
      return true;
    }
    return false;
  };
  const writeLeaf = (c: LeafCard, piece: LeafletPiece, colour: THREE.Color, swayBase: number) => {
    const leafletMesh = piece.id.startsWith("sprig") ? sprigMesh : leafMeshMain;
    const [ru, rv, rw, rh] = piece.atlasRect, offset = leafletMesh.pos.length / 3;
    // Columns at the edges and on the midrib (the stalk line), so the crease runs down the leaf's
    // centre; big single leaves get more rows for a smooth curve.
    const ROWS = once() ? 4 : 3, US = [0, piece.baseUv[0], 1];
    for (let row = 0; row <= ROWS; row++) for (let col = 0; col <= 2; col++) {
      const v = row / ROWS, u = US[col], dv = v - piece.baseUv[1], du = u - piece.baseUv[0], side = col === 1 ? 0 : Math.sign(du);
      const p = pointOn(c, dv * c.size, du * c.width);
      leafletMesh.pos.push(p.x, p.y, p.z);
      // Each half gets its own tilt, so a creased leaf shows a lighter and a darker half.
      const n = c.n0.clone().multiplyScalar(0.96).addScaledVector(c.wv, -side * Math.max(once() ? 0.45 : 0.15, c.cup * 1.5)).lerp(p.clone().sub(dome).normalize(), 0.3).normalize().addScaledVector(UP, 0.25).normalize();
      leafletMesh.nrm.push(n.x, n.y, n.z);
      leafletMesh.uv.push(ru + (piece.mirrored ? 1 - u : u) * rw, rv + v * rh);
      leafletMesh.col.push(colour.r, colour.g, colour.b);
      leafletMesh.sway.push(swayBase + Math.max(0, dv * c.size) * 2.5);
    }
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < 2; col++) {
      const a = offset + row * 3 + col, b = a + 3;
      leafletMesh.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    leafletCount++;
  };
  const insideRock = (p: THREE.Vector3, pad: number) => { const h = surface.nearest(p, pad * 3); return !!h && h.signed < pad; };
  /** Build a compound frond along `frames`: rachis, leaflet stems, tiny leaves. */
  const buildLeafletFrond = (frames: Frame[], length: number, age: number, key: number) => {
    const ROWS = frames.length - 1, line = frames.map(f => f.p);
    const along = line.map(() => 0); for (let i = 1; i <= ROWS; i++) along[i] = along[i - 1] + line[i].distanceTo(line[i - 1]);
    const rachisR = Math.max(0.0016, length * 0.0045);   // thin, as in the references
    leafStemR = once() ? rachisR : rachisR * 0.3;
    // Sprig fern: sprigs are only kept apart from sprigs on the same stem; different fronds may cross.
    if (sprig) leafGrid.clear();
    addTube(line, rachisR, 6, 0.22, stemColour, d => d * 2.5);
    // Frond colour: a green picked by age (as for painted fronds), tinted per leaf piece.
    const spread = (r(key, 8) - 0.5) * byLight.length * 0.4;
    const shade = byLight[Math.min(byLight.length - 1, Math.max(0, Math.round((1 - age) * (byLight.length - 1) + spread)))];
    const shadeIdx = Math.min(byLight.length - 1, Math.max(0, Math.round((1 - age) * (byLight.length - 1) + spread)));
    /** A leaf's colour: the frond's green (by age), tinted from the leaf's own paint, darker toward the
     *  crown. With Leaf variation, each leaf (`k2`) also shifts to a neighbouring green and lighter or darker. */
    const leafColour = (piece: LeafletPiece, v: number, k2: number) => {
      const avg = new THREE.Color(piece.avgColour), V = s.leafVariation;
      const jitter = Math.round((r(k2, 11) - 0.5) * V * byLight.length * 0.9);
      // Sprig fern: a clear gradient along each stem, from the darkest greens at its base to the
      // lightest at its tip (the green steps through the palette and the tone brightens).
      const grad = sprig ? Math.round((THREE.MathUtils.clamp(v, 0, 1) - 0.5) * (byLight.length - 1) * 1.4) : 0;
      const sh = byLight[Math.min(byLight.length - 1, Math.max(0, (sprig ? Math.round((byLight.length - 1) / 2) : shadeIdx) + grad + jitter))];
      const c = new THREE.Color(1, 1, 1).lerp(new THREE.Color(sh.r / Math.max(avg.r, 1e-3), sh.g / Math.max(avg.g, 1e-3), sh.b / Math.max(avg.b, 1e-3)), s.paintTint);
      const tone = sprig ? 0.6 + 0.62 * THREE.MathUtils.smoothstep(v, 0, 1) : 0.74 + 0.3 * THREE.MathUtils.smoothstep(v, 0, 0.7);
      return c.multiplyScalar(PAINT_SCALE * (0.9 + 0.16 * r(k2, 5)) * (1 + (r(k2, 12) - 0.5) * 0.5 * V) * tone);
    };
    /** Size factor for a leaf (`k2`) from Leaf variation: up to ±25 % at full variation. */
    const sizeJitter = (k2: number) => 1 + (r(k2, 13) - 0.5) * 0.5 * s.leafVariation;
    const mirror = s.mirrorPairs;
    const frameAt = (v: number) => {
      const x = v * ROWS, i0 = Math.min(ROWS - 1, Math.floor(x)), f = x - i0, a = frames[i0], b = frames[i0 + 1];
      return { p: a.p.clone().lerp(b.p, f), T: a.T.clone().lerp(b.T, f).normalize(), W: a.W.clone().lerp(b.W, f).normalize(), F: a.F.clone().lerp(b.F, f).normalize(), d: along[i0] + (along[i0 + 1] - along[i0]) * f };
    };
    const P = Math.round(s.pinnae), L = sprig ? 0 : Math.round(s.leaflets), lp = length * PINNA_LEN;
    const pinnaGap = length * 0.85 / P;                    // distance between leaflet pairs along the frond
    // Size of the largest tiny leaves (at the base of the longest leaflets); every leaf scales from it,
    // so leaves shrink toward the frond's tip with their leaflets, and toward each leaflet's tip.
    const leafBase = lp * 0.45 * s.leafSize + 0 * pinnaGap * TINY_REACH;   // largest tiny leaf: 45 % of the longest leaflet stem (× Leaf size)
    // One leaf shape per frond for single leaves (both sides and all pairs match), as in the references.
    const frondPiece = sprig ? SPRIG_PIECE : NARROW_LEAVES[Math.floor(r(key, 17) * NARROW_LEAVES.length) % NARROW_LEAVES.length];
    for (let i = 0; i < P; i++) {
      // Opposite pairs: both sides share one position, length, leaf shape and colour.
      const v = once() ? Math.min(0.95, 0.08 + 0.86 * i / Math.max(1, P - 0.5)) : Math.min(0.97, 0.12 + 0.85 * i / P), k2 = key * 1000 + i;
      let pl = (once() ? length * ONCE_LEN * s.leafSize : lp) * frondOutline(v) * (0.95 + 0.1 * r(k2, 1));
      if (pl < length * 0.02) continue;
      const fr = frameAt(v), ang = pinnaAngle(v), lift = once() ? leafLift() : pinnaLift();
      const piece = L === 0 ? frondPiece : BROAD_LEAVES[Math.floor(r(k2, 7) * BROAD_LEAVES.length) % BROAD_LEAVES.length];
      const colour = (u: number) => leafColour(piece, v + 0.15 * u, k2);
      const swayBase = fr.d * 2.5;
      const dirs = [-1, 1].map(side => fr.W.clone().multiplyScalar(side * Math.sin(ang)).addScaledVector(fr.T, Math.cos(ang))
        .multiplyScalar(Math.cos(lift)).addScaledVector(fr.F, Math.sin(lift)).normalize());
      if (L === 0) {
        // Once-divided: one leaf per side, straight on the rachis.
        // Mirrored pairs share size and colour; otherwise each side varies on its own (same leaf, not flipped).
        addLeafGroup([-1, 1].map((side, n) => {
          const kk = mirror ? k2 : k2 * 2 + n;
          // Creased leaves alternate a little higher and lower pair by pair, so they overlap like shingles
          // while their bases stay on the stem.
          // Sprigs are set like louvres: each turned about its own axis toward the frond tip, so
          // neighbouring sprigs on a stem lie over one another without crossing.
          const face = sprig ? fr.F.clone().multiplyScalar(Math.cos(SPRIG_ROLL)).addScaledVector(fr.T, Math.sin(SPRIG_ROLL)).normalize() : fr.F;
          return { base: fr.p, dir: dirs[n], face, len: pl * sizeJitter(kk), side, piece: n || !mirror ? piece : mirrorPiece(piece), colour: leafColour(piece, v, kk), sway: swayBase, toward: fr.T, stagger: 0 };
        }));
        continue;
      }
      // The leaflet stems curl down a little and sweep toward the frond tip; both stop where
      // either would enter the rock, so the pair stays even.
      const STEPS = 4, stems = dirs.map(dir => { const pts = [fr.p.clone()], d = dir.clone();
        for (let j = 1; j <= STEPS; j++) { d.addScaledVector(fr.F, -0.035).addScaledVector(fr.T, 0.05).normalize(); pts.push(pts[j - 1].clone().addScaledVector(d, pl / STEPS)); }
        return pts; });
      let keep = STEPS;
      for (const pts of stems) for (let j = 1; j <= STEPS; j++) if (insideRock(pts[j], 0.006)) { keep = Math.min(keep, j - 1); break; }
      if (keep < 2) continue;
      stems.forEach(pts => pts.length = keep + 1);
      pl *= keep / STEPS;
      const stemC = stemColour(v * 0.6 + 0.3);
      const at = stems.map(pts => {
        addTube(pts, rachisR * 0.3 * (1 - 0.4 * v), 4, 0.35, () => stemC, dd => swayBase + dd * 2.5);
        const pAlong = pts.map(() => 0); for (let j = 1; j < pts.length; j++) pAlong[j] = pAlong[j - 1] + pts[j].distanceTo(pts[j - 1]);
        return (u: number) => {
          const x = u * (pts.length - 1), j0 = Math.min(pts.length - 2, Math.floor(x)), f = x - j0;
          return { p: pts[j0].clone().lerp(pts[j0 + 1], f), t: pts[j0 + 1].clone().sub(pts[j0]).normalize(), d: pAlong[j0] + (pAlong[j0 + 1] - pAlong[j0]) * f };
        };
      });
      const la = THREE.MathUtils.degToRad(TINY_ANGLE);
      for (const n of [0, 1]) {
        const pointAt = at[n];
        // Opposite pairs of tiny leaves, the same size on both sides: largest at the leaflet's base,
        // about half that size at its tip, and smaller on the shorter leaflets toward the frond tip.
        for (let j = 0; j < L; j++) {
          const u = 0.16 + 0.78 * j / L, a = pointAt(u), pw = new THREE.Vector3().crossVectors(fr.F, a.t).normalize();
          const ll = leafBase * frondOutline(v) * (1.15 - 0.6 * u);
          addLeafGroup([-1, 1].map(side2 => {
            const ldir = pw.clone().multiplyScalar(side2 * Math.sin(la)).addScaledVector(a.t, Math.cos(la)).normalize();
            ldir.multiplyScalar(Math.cos(leafLift())).addScaledVector(fr.F, Math.sin(leafLift())).normalize();   // rising in a V
            const kk = mirror ? k2 * 64 + n * 16 + j : k2 * 64 + n * 16 + j * 2 + (side2 > 0 ? 1 : 0) + 5000;
            return { base: a.p, dir: ldir, face: fr.F, len: ll * sizeJitter(kk), side: side2 * (n ? 1 : -1), piece: side2 > 0 || !mirror ? piece : mirrorPiece(piece), colour: leafColour(piece, v + 0.15 * u, kk), sway: swayBase + a.d * 2.5 };
          }));
        }
        const tip = pointAt(1);
        addLeafGroup([{ base: tip.p, dir: tip.t, face: fr.F, len: leafBase * frondOutline(v) * 0.55, side: 1, piece, colour: colour(1), sway: swayBase + tip.d * 2.5 }]);
      }
    }
    if (L === 0) {
      // One leaf on the very tip of the frond.
      const end = frames[ROWS];
      addLeafGroup([{ base: end.p, dir: end.T, face: end.F, len: length * ONCE_LEN * s.leafSize * 0.3, side: 1, piece: frondPiece, colour: leafColour(frondPiece, 1, key * 1000 + 999), sway: along[ROWS] * 2.5 }]);
    }
  };

  /** Centre line of a frond: rises from the crown along `dir`, then droops toward the tip. */
  const frondLine = (dir0: THREE.Vector3, length: number, droop: number, steps: number) => {
    const ds = length / steps, pts = [crown.clone()], d = dir0.clone();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      d.addScaledVector(DOWN, droop * 3.2 * ds / length * (0.35 + t)).normalize();
      pts.push(pts[i - 1].clone().addScaledVector(d, ds));
    }
    return pts;
  };
  /** Index of the first point that hits the rock or an obstacle, or -1 when the line is clear. */
  const firstBlocked = (pts: THREE.Vector3[], pad: number) => pts.findIndex((p, i) => {
    if (i < 2) return false;
    const h = surface.nearest(p, pad * 3);
    if (h && h.signed < pad) return true;
    return avoid.some(o => pointHitsObstacle(p, o, pad));
  });
  const lineBlocked = (pts: THREE.Vector3[], pad: number) => firstBlocked(pts, pad) >= 0;

  const n = Math.round(s.fronds), phase = r(0, 1) * Math.PI * 2;
  const gap = 0.012 * Math.max(0.5, s.length / 0.45);
  /** Bend a frond out of the crack: returns a line clear of the rock and other plants, or null. */
  const fitToRock = (elev0: number, h0: THREE.Vector3, length0: number, droop: number) => {
    let elev = elev0, length = length0, droopNow = droop; const h = h0.clone();
    for (let attempt = 0; attempt < 8; attempt++) {
      const dir = axis.clone().multiplyScalar(Math.cos(elev)).addScaledVector(h, Math.sin(elev)).normalize();
      const pts = frondLine(dir, length, droopNow, 12);
      const hit = firstBlocked(pts, 0.012);
      if (hit < 0) return { line: pts, length };
      if (hit >= 7 && attempt >= 3) { length *= (hit - 1) / 12; continue; }   // tight spot: a shorter frond
      if (attempt % 3 === 0) elev *= 0.72;                                     // stand up more, out of the crack
      else if (attempt % 3 === 1) { h.lerp(openT, 0.5).normalize(); droopNow *= 0.6; }   // turn toward open air, droop less
      else { h.applyAxisAngle(normal, 0.6).normalize(); length *= 0.85; }    // turn and shorten
    }
    return null;
  };
  // Small changes of angle (degrees) and turn (radians) tried, in order, when a frond would pass
  // through one already placed: fronds settle into layers instead of slicing through each other.
  // Outer fronds are placed first (they lie lowest and are hardest to fit); younger ones then
  // find a layer above them, standing up more if they must. Last resorts are shorter fronds.
  const NUDGES: [number, number, number][] = [];
  for (const len of [1, 0.8]) for (const dE of [0, -10, 10, -20, 20, -32]) for (const dA of [0, 0.25, -0.25, 0.5, -0.5]) NUDGES.push([dE, dA, len]);
  for (let k = n - 1; k >= 0; k--) {
    const t = n > 1 ? k / (n - 1) : 0.5;                          // 0 = young inner frond, 1 = old outer frond
    const leafy = s.variety !== "painted";
    const piece = frondPool[Math.floor(r(k, 7) * frondPool.length) % frondPool.length];
    const length0 = s.length * (0.65 + 0.45 * t) * (1 + (r(k, 2) - 0.5) * 2 * s.lengthVar) * (leafy ? 1 : Math.sqrt(piece.scale));
    const shapeOf = (len: number) => leafy ? leafletShape(len) : paintedShape(piece, len);
    const elev0 = s.spread * (0.35 + 1.0 * t) + (r(k, 3) - 0.5) * 12;
    const az = phase + k * GOLDEN;
    const droop = s.droop * (0.55 + 0.7 * t) * (0.85 + 0.3 * r(k, 4));
    const roll = (r(k, 6) - 0.5) * 2 * s.twist * 1.2;
    for (const [dElev, dAz, lenScale] of options.quick ? NUDGES.slice(0, 15) : NUDGES) {
      const h = axA.clone().multiplyScalar(Math.cos(az + dAz)).addScaledVector(axB, Math.sin(az + dAz));
      const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elev0 + dElev, 3, 88));
      // Against the rock, a frond can also droop less or untwist so its edges clear the stone.
      let fit: { line: THREE.Vector3[]; length: number } | null = null, frames: Frame[] | null = null;
      for (const [droopScale, rollScale] of options.quick ? [[1, 1], [0.4, 0]] : [[1, 1], [0.55, 0], [0.2, 0]]) {
        const f = fitToRock(elev, h, length0 * lenScale, droop * droopScale);
        if (!f) continue;
        const fr = framesOf(f.line, roll * rollScale);
        // Leaflet fronds are see-through; their single leaves also check the rock, so test less of their width.
        if (cardHitsRock(fr, leafy ? { ...shapeOf(f.length), reach: v => shapeOf(f.length).reach(v) * 0.7 } : shapeOf(f.length), s.fold, 0.008)) continue;
        fit = f; frames = fr; break;
      }
      if (!fit || !frames) continue;
      const shape = shapeOf(fit.length);
      if (!sprig && collidesWithClump(frames, shape, s.fold, gap)) continue;   // sprig fronds may cross each other
      if (!options.quick) { if (leafy) buildLeafletFrond(frames, fit.length, t, k); else addCard(piece, frames, fit.length, t, k, s.fold); }
      placed.push({ frames, shape, fold: s.fold, bound: boundOf(frames, shape.half) });
      for (let i = 3; i < fit.line.length; i += 3) obstacles.push({ centre: fit.line[i].clone(), radius: shape.half * 0.7 });
      frondCount++;
      break;
    }
  }
  // Croziers: young coiled fronds, upright in the middle, two crossed cards each.
  for (let c = 0; c < Math.round(s.croziers) && crozierPool.length; c++) {
    const key = 1000 + c, piece = crozierPool[Math.floor(r(key, 7) * crozierPool.length) % crozierPool.length];
    const length = s.length * (0.22 + 0.1 * r(key, 2)) * (s.variety !== "painted" ? 0.6 : 1);   // small beside long leaflet fronds
    for (const [, dAz] of NUDGES) {
      const az = phase + 0.7 + c * 2.3 + dAz;
      const h = tanA.clone().multiplyScalar(Math.cos(az)).addScaledVector(tanB, Math.sin(az));
      const dir = normal.clone().multiplyScalar(0.92).addScaledVector(h, 0.3).addScaledVector(UP, 0.4).normalize();
      const line = frondLine(dir, length, 0.05, 6);
      if (lineBlocked(line, 0.01)) continue;
      const a = framesOf(line, 0), b = framesOf(line, 0).map(f => ({ ...f, W: f.F.clone(), F: f.W.clone().negate() }));
      const shape = paintedShape(piece, length);
      if (cardHitsRock(a, shape, 0, 0.003) || cardHitsRock(b, shape, 0, 0.003)) continue;
      if (collidesWithClump(a, shape, 0, gap * 0.5) || collidesWithClump(b, shape, 0, gap * 0.5)) continue;
      if (options.quick) break;
      addCard(piece, a, length, 0, key, 0);
      addCard(piece, b, length, 0, key, 0);
      break;
    }
  }

  const group = new THREE.Group(); group.name = "Fern clump";
  group.userData.fern = JSON.parse(JSON.stringify(recipe));
  /** Painted foliage material: alpha-tested, lit the same on both sides, with light through it. */
  const foliageMaterial = (name: string, map?: THREE.Texture) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true });
    mat.alphaToCoverage = true; mat.name = name; mat.userData.fernLeaf = true;
    if (map) mat.map = map;
    // Light both sides of a frond the same (no darker undersides), as painted foliage is.
    // Light through the fronds: when the sun is behind a frond (seen from the camera), or shines
    // on its other side, some of it comes through, warmer and yellower, as in thin leaves.
    mat.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>",
        THREE.ShaderChunk.normal_fragment_begin.replace("float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;", "float faceDirection = 1.0;"))
        .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
        {
          vec3 toEye = normalize(vViewPosition), toSun = directionalLights[0].direction;
          float through = 0.55 * pow(max(0.0, dot(-toEye, toSun)), 2.0) + 0.35 * max(0.0, -dot(normal, toSun));
          reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.0, 1.12, 0.55) * directionalLights[0].color * through * ${FERN_TRANSLUCENCY.toFixed(2)};
        }
#endif`);
    };
    mat.customProgramCacheKey = () => "fern-two-sided-glow";
    return mat;
  };
  const cardMesh = (m: typeof mesh, name: string, matName: string, map?: THREE.Texture) => {
    if (!m.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(m.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(m.uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(m.col, 3));
    geo.setAttribute("sway", new THREE.Float32BufferAttribute(m.sway, 1));
    geo.setIndex(m.idx);
    const out = new THREE.Mesh(geo, foliageMaterial(matName, map));
    out.name = name; out.castShadow = true; out.receiveShadow = true; group.add(out);
  };
  cardMesh(mesh, "Fern fronds", "Painted fern fronds", options.texture);
  cardMesh(leafMeshMain, "Fern leaflets", "Painted fern leaflets", options.leafletTexture);
  cardMesh(sprigMesh, "Fern sprigs", "Painted fern sprigs", options.sprigTexture);
  if (tubes.length) {
    const geo = mergeGeometries(tubes); tubes.forEach(t => t.dispose());
    const stems = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true, name: "Fern stems" }));
    stems.name = "Fern stems"; stems.castShadow = true; stems.receiveShadow = true; group.add(stems);
  }
  // A dark knot at the crown hides where the fronds meet the rock.
  const knotGeo = new THREE.IcosahedronGeometry(Math.max(0.008, s.length * (s.variety !== "painted" ? 0.03 : 0.055)), 1);
  knotGeo.scale(1, 1, 0.55);
  knotGeo.lookAt(normal);   // flattened along the rock normal
  knotGeo.translate(crown.x, crown.y, crown.z);
  knotGeo.setAttribute("sway", new THREE.Float32BufferAttribute(new Float32Array(knotGeo.getAttribute("position").count), 1));
  const knot = new THREE.Mesh(knotGeo, new THREE.MeshStandardMaterial({ color: 0x3e3324, roughness: 1, name: "Fern crown" }));
  knot.name = "Fern crown"; knot.castShadow = true; group.add(knot);
  obstacles.push({ centre: crown.clone(), radius: s.length * 0.1 });
  return { group, frondCount, leafletCount, obstacles };
}

export function disposeFern(group: THREE.Group): void {
  group.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());   // the shared atlas texture is not disposed
  });
}
