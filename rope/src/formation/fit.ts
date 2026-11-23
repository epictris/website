// "Fit collision to geometry" (docs/formations.md): the collision refitted to
// the rock that was generated, where it meets the play plane.
//
// The rock's section at the play plane is in the store (`meta.json`
// `section`, written from the finished mesh by formation_export.py). Here it
// becomes polygons the editor writes as `poly` pieces:
//
// 1. The closed loops are read even-odd as regions; each region keeps only its
//    outer boundary (a piece cannot have a hole, and a cavity in the rock at
//    the plane is filled), and a region whose area is under MIN_AREA_FACTOR
//    accuracies squared is dropped (the generator's crumbs where a stone grazes
//    the plane).
// 2. Where the body's pieces differ in their properties (a hook-proof piece and
//    a muddy one), each class of alike pieces takes the part of the section
//    nearest its own pieces: the classes grow out together in PARTITION_STEPS
//    equal steps, each taking the section its grown pieces reach that no class
//    took a step earlier. Where they are alike the section is one class.
// 3. Each polygon is simplified within the ACCURACY: no point of the result is
//    further than that from the section's boundary (Ramer-Douglas-Peucker on
//    the closed ring, split at its two most distant points). A result that
//    would cross itself is simplified again at half the tolerance, down to
//    MIN_TOLERANCE_SHARE of the asked accuracy, then left at full detail.
//
// Everything is in the formation's frame (metres, y down), as the section is.

import { manifold } from "./manifold";
import { signedArea, type Pt } from "./outline";
import type { SectionLoop } from "./store";

const MIN_AREA_FACTOR = 4;
const PARTITION_STEPS = 12;
// How far the classes grow before what is left goes to the nearest anyway.
const PARTITION_REACH = 1.5;
const MIN_TOLERANCE_SHARE = 1 / 16;

export interface FitResult {
  // Per class, in the order the classes were given: its polygons.
  polygons: Pt[][][];
  vertices: number;
  // Regions dropped for their size, and loops the section left open.
  dropped: number;
  open: number;
}

type Ring = [number, number][];
const toRing = (p: readonly Pt[]): Ring => p.map((q) => [q.x, q.y]);
const fromRing = (r: readonly [number, number][]): Pt[] => r.map(([x, y]) => ({ x, y }));

// The section as regions: outer boundaries only, crumbs dropped.
export function sectionRegions(section: readonly SectionLoop[], accuracy: number): { regions: Pt[][]; dropped: number; open: number } {
  const closed = section.filter((l) => l.closed && l.points.length >= 3);
  const open = section.length - closed.length;
  if (!closed.length) return { regions: [], dropped: 0, open };
  const cs = manifold.CrossSection.ofPolygons(closed.map((l) => toRing(l.points)), "EvenOdd");
  const parts = cs.decompose();
  cs.delete();
  const minArea = MIN_AREA_FACTOR * accuracy * accuracy;
  const regions: Pt[][] = [];
  let dropped = 0;
  for (const part of parts) {
    const contours = part.toPolygons().map(fromRing);
    part.delete();
    if (!contours.length) continue;
    const outer = contours.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
    if (Math.abs(signedArea(outer)) < minArea) dropped++;
    else regions.push(outer);
  }
  return { regions, dropped, open };
}

// Distance from p to the segment ab.
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(points: readonly Pt[], tol: number): Pt[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(points[k]!, points[i]!, points[j]!);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at >= 0 && worst > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

// A closed ring simplified within `tol`: split at its two most distant points
// (the first vertex and the one furthest from it, then the furthest from that),
// each half by RDP.
export function simplifyRing(ring: readonly Pt[], tol: number): Pt[] {
  if (ring.length <= 3) return [...ring];
  const far = (from: number): number => {
    let best = 0;
    let at = from;
    ring.forEach((p, k) => {
      const d = Math.hypot(p.x - ring[from]!.x, p.y - ring[from]!.y);
      if (d > best) {
        best = d;
        at = k;
      }
    });
    return at;
  };
  const a = far(0);
  const b = far(a);
  const [i, j] = a < b ? [a, b] : [b, a];
  const first = rdp(ring.slice(i, j + 1), tol);
  const second = rdp([...ring.slice(j), ...ring.slice(0, i + 1)], tol);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : [...ring];
}

// Whether a closed ring crosses or touches itself anywhere but at neighbouring
// edges' shared corners.
export function isSimple(ring: readonly Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hit = (p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean => {
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]!;
    const a2 = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (hit(a1, a2, ring[j]!, ring[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

// Simplified within the accuracy and still simple, or as near as it can be.
export function fitRing(ring: readonly Pt[], accuracy: number): Pt[] {
  for (let tol = accuracy; tol >= accuracy * MIN_TOLERANCE_SHARE; tol /= 2) {
    const out = simplifyRing(ring, tol);
    if (out.length >= 3 && isSimple(out)) return out;
  }
  return [...ring];
}

// The section split among `classes` (each a list of its pieces' polygons):
// each class gets the part nearest its own pieces (see the top of this file).
export function partition(regions: readonly Pt[][], classes: readonly Pt[][][]): Pt[][][] {
  if (classes.length <= 1) return [regions.map((r) => [...r])];
  const section = manifold.CrossSection.ofPolygons(regions.map(toRing), "NonZero");
  const grown = classes.map((pieces) => manifold.CrossSection.ofPolygons(pieces.map(toRing), "NonZero"));
  // An empty section is `compose([])`: `ofPolygons([])` throws.
  const owned = classes.map(() => manifold.CrossSection.compose([]));
  let taken = manifold.CrossSection.compose([]);
  try {
    for (let s = 0; s <= PARTITION_STEPS; s++) {
      const d = s === PARTITION_STEPS ? 1e3 : (PARTITION_REACH * s) / PARTITION_STEPS;
      const reach = grown.map((g) => (d > 0 ? g.offset(d, "Round", 2, 24) : g.translate([0, 0])));
      const claims = reach.map((r) => {
        const inside = section.intersect(r);
        const fresh = inside.subtract(taken);
        inside.delete();
        return fresh;
      });
      // Within one step a piece of section two classes both reach goes to the
      // earlier class.
      let stepTaken = manifold.CrossSection.compose([]);
      claims.forEach((claim, c) => {
        const mine = claim.subtract(stepTaken);
        const nextOwned = owned[c]!.add(mine);
        owned[c]!.delete();
        owned[c] = nextOwned;
        const nextStep = stepTaken.add(mine);
        stepTaken.delete();
        stepTaken = nextStep;
        mine.delete();
        claim.delete();
      });
      const nextTaken = taken.add(stepTaken);
      taken.delete();
      stepTaken.delete();
      taken = nextTaken;
      for (const r of reach) r.delete();
    }
    return owned.map((o) =>
      o.decompose().map((part) => {
        const contours = part.toPolygons().map(fromRing);
        part.delete();
        return contours.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a), [] as Pt[]);
      }).filter((p) => p.length >= 3),
    );
  } finally {
    section.delete();
    taken.delete();
    for (const g of grown) g.delete();
    for (const o of owned) o.delete();
  }
}

// The whole fit: the section's regions, split among the classes, each
// simplified within `accuracy` (metres).
export function fitSection(section: readonly SectionLoop[], accuracy: number, classes: readonly Pt[][][]): FitResult {
  const { regions, dropped, open } = sectionRegions(section, accuracy);
  const parts = partition(regions, classes);
  const minArea = MIN_AREA_FACTOR * accuracy * accuracy;
  const polygons = parts.map((polys) =>
    polys.filter((p) => Math.abs(signedArea(p)) >= minArea).map((p) => fitRing(p, accuracy)),
  );
  return { polygons, vertices: polygons.flat().reduce((n, p) => n + p.length, 0), dropped, open };
}
