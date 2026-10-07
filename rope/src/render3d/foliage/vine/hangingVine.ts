import * as THREE from "three";
import { HANGING_LEAF_PROFILES, LEAF_SHADES, type HangingLeafProfile } from "./hangingLeafProfiles";

/** The leaves available to the generator: the built-in sheet plus any imported ones. */
let leafLibrary: HangingLeafProfile[] = HANGING_LEAF_PROFILES;
export function setLeafLibrary(list: HangingLeafProfile[]): void { if (list.length) leafLibrary = list; }
export function getLeafLibrary(): HangingLeafProfile[] { return leafLibrary; }

/** Decorative, baked vines. All coordinates and lengths are in metres, Y up. */
export interface HangingVineSettings {
  length: number; radius: number; cling: number; bend: number;
  leafSpacing: number; leafSize: number; leafAngle: number; variation: number;
  seed: number; leafStyle: string;
  /** Which LEAF_SHADES to use, as their ids joined by "+" ("" or missing = all). */
  shades?: string;
  /** Natural leaves (default on): gravity droop, curved blades, colour and size by age. */
  natural?: boolean;
  /** 0..1: how far painted (own-colour) leaves are tinted toward the chosen greens (default 0). */
  paintTint?: number;
}
export const DEFAULT_HANGING_VINE_SETTINGS: HangingVineSettings = {
  length: 3.4, radius: 0.008, cling: 0.40, bend: 0.55,
  leafSpacing: 0.15, leafSize: 0.24, leafAngle: 58, variation: 0.35,
  seed: 1701, leafStyle: "mixed",
};
export interface HangingVineRecipe {
  version: 1;
  start: [number, number, number]; normal: [number, number, number];
  direction: [number, number, number]; settings: HangingVineSettings;
}
export interface HangingVineResult {
  group: THREE.Group; points: THREE.Vector3[]; normals: THREE.Vector3[];
  supported: boolean[]; length: number; leafCount: number; releaseIndex: number;
  /** this vine's leaves and stem, for other vines to avoid */
  obstacles: VineObstacle[];
}
type Face = { triangle: THREE.Triangle; normal: THREE.Vector3; box: THREE.Box3; centre: THREE.Vector3 };
type Node = { box: THREE.Box3; left?: Node; right?: Node; faces?: Face[] };
type Contact = { point: THREE.Vector3; normal: THREE.Vector3; distance: number; signed: number };
const WHITE = new THREE.Color(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/** Small static BVH shared by path generation and foliage clearance. */
export class VineSurface {
  private root: Node;
  constructor(positions: Float32Array | number[]) {
    if (positions.length < 9 || positions.length % 9 || positions.length > 900_000 ||
        Array.from(positions).some(n => !Number.isFinite(n))) throw new Error("The rock surface is invalid or too large.");
    const faces: Face[] = [];
    for (let i = 0; i < positions.length; i += 9) {
      const triangle = new THREE.Triangle(new THREE.Vector3().fromArray(positions, i),
        new THREE.Vector3().fromArray(positions, i + 3), new THREE.Vector3().fromArray(positions, i + 6));
      if (triangle.getArea() < 1e-12) continue;
      faces.push({ triangle, normal: triangle.getNormal(new THREE.Vector3()),
        box: new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]),
        centre: triangle.getMidpoint(new THREE.Vector3()) });
    }
    if (!faces.length) throw new Error("The selected rock has no usable faces.");
    const build = (items: Face[]): Node => {
      const box = new THREE.Box3(); items.forEach(f => box.union(f.box));
      if (items.length <= 10) return { box, faces: items };
      const size = box.getSize(new THREE.Vector3());
      const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
      items.sort((a, b) => a.centre[axis] - b.centre[axis]);
      const mid = items.length >> 1;
      return { box, left: build(items.slice(0, mid)), right: build(items.slice(mid)) };
    };
    this.root = build(faces);
  }
  nearest(p: THREE.Vector3, max = Infinity): Contact | null {
    let best = max, found: Face | null = null;
    const nearest = new THREE.Vector3(), temp = new THREE.Vector3();
    const visit = (node: Node): void => {
      if (node.box.distanceToPoint(p) > best) return;
      if (node.faces) {
        for (const face of node.faces) {
          face.triangle.closestPointToPoint(p, temp);
          const distance = p.distanceTo(temp);
          if (distance < best) { best = distance; found = face; nearest.copy(temp); }
        }
      } else {
        const a = node.left!, b = node.right!;
        if (a.box.distanceToPoint(p) < b.box.distanceToPoint(p)) { visit(a); visit(b); }
        else { visit(b); visit(a); }
      }
    };
    visit(this.root);
    if (!found) return null;
    const face = found as Face;
    const delta = p.clone().sub(nearest);
    const side = delta.dot(face.normal);
    // At convex corners use the separating vector; flat faces keep their normal.
    const normal = side >= 0 && best > 1e-8 ? delta.clone().divideScalar(best) : face.normal.clone();
    return { point: nearest, normal, distance: best, signed: side < -1e-7 ? -best : best };
  }
  project(p: THREE.Vector3, clearance: number): THREE.Vector3 {
    for (let k = 0; k < 4; k++) {
      const hit = this.nearest(p);
      if (!hit || hit.signed >= clearance - 1e-7) break;
      p.copy(hit.point).addScaledVector(hit.normal, clearance);
    }
    return p;
  }
  clear(a: THREE.Vector3, b: THREE.Vector3, clearance: number): boolean {
    const count = Math.max(2, Math.ceil(a.distanceTo(b) / Math.max(clearance * 1.5, 0.008)));
    const p = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      p.lerpVectors(a, b, i / count);
      const contact = this.nearest(p, clearance * 3);
      if (contact && contact.signed < clearance * 0.82) return false;
    }
    return true;
  }
}

export function validateHangingVineRecipe(recipe: HangingVineRecipe): void {
  if (!recipe || recipe.version !== 1 || !recipe.settings) throw new Error("Invalid hanging vine recipe.");
  for (const key of ["start", "normal", "direction"] as const) {
    const v = recipe[key];
    if (!Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 10_000))
      throw new Error(`Invalid vine ${key}.`);
  }
  if (new THREE.Vector3(...recipe.normal).length() < 0.1 || new THREE.Vector3(...recipe.direction).length() < 0.01)
    throw new Error("Choose a starting point and a distinct growth direction.");
  const s = recipe.settings;
  const ranges: [keyof HangingVineSettings, number, number][] = [
    ["length", 0.05, 30], ["radius", 0.001, 0.06], ["cling", 0, 1], ["bend", 0, 1],
    ["leafSpacing", 0.04, 2], ["leafSize", 0.03, 1], ["leafAngle", 5, 85], ["variation", 0, 1],
    ["seed", 0, 2147483647],
  ];
  for (const [key, min, max] of ranges) {
    const value = s[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (s.natural !== undefined && typeof s.natural !== "boolean") throw new Error("Invalid natural flag.");
  if (s.paintTint !== undefined && (typeof s.paintTint !== "number" || !(s.paintTint >= 0 && s.paintTint <= 1))) throw new Error("paintTint must be between 0 and 1.");
  if (s.shades !== undefined && (typeof s.shades !== "string" || !/^[a-z+]{0,80}$/.test(s.shades)))
    throw new Error("Invalid leaf shades.");
  if (!Number.isInteger(s.seed) || typeof s.leafStyle !== "string" || !/^[a-z0-9_+-]{1,4000}$/.test(s.leafStyle))
    throw new Error("Invalid seed or leaf style.");
}
export const rand = (seed: number, i: number, salt = 0): number => {
  let n = (seed ^ Math.imul(i + 1, 374761393) ^ Math.imul(salt + 1, 668265263)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
export const tangentOn = (direction: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 => {
  const tangent = direction.clone().addScaledVector(normal, -direction.dot(normal));
  if (tangent.lengthSq() < 1e-8) tangent.crossVectors(normal, Math.abs(normal.z) < 0.9 ? FORWARD : UP);
  return tangent.normalize();
};

/** Bounded incremental growth; exact centreline length, independent of mesh tessellation. */
export function generateHangingVine(positions: Float32Array | number[], recipe: HangingVineRecipe,
  options: { avoid?: VineObstacle[] } = {}): HangingVineResult {
  validateHangingVineRecipe(recipe);
  const surface = new VineSurface(positions), s = recipe.settings;
  const clearance = s.radius + 0.002;
  const step = Math.min(0.035, Math.max(0.012, s.radius * 2));
  const start = new THREE.Vector3(...recipe.start);
  const anchor = surface.nearest(start);
  if (!anchor || anchor.distance > Math.max(0.1, s.radius * 4)) throw new Error("The vine's root is no longer on this rock. Place it again.");
  let normal = new THREE.Vector3(...recipe.normal).normalize();
  // Use the picked normal to disambiguate an anchor exactly on an edge.
  if (normal.dot(anchor.normal) < -0.1) normal.copy(anchor.normal);
  let current = anchor.point.clone().addScaledVector(normal, clearance);
  surface.project(current, clearance);
  let direction = tangentOn(new THREE.Vector3(...recipe.direction).normalize(), normal);
  const points = [current.clone()], normals = [normal.clone()], supported = [true];
  let hanging = false, length = 0, releaseIndex = -1;
  const phase = rand(s.seed, 0, 91) * Math.PI * 2;
  const maxSteps = Math.ceil(s.length / step) * 5 + 100;
  for (let i = 0; length < s.length - 1e-7 && i < maxSteps; i++) {
    const ds = Math.min(step, s.length - length);
    let contactSupport = false;
    if (!hanging) {
      const downhill = tangentOn(DOWN, normal);
      const slope = Math.sqrt(Math.max(0, 1 - normal.y * normal.y));
      const side = direction.clone().cross(normal).normalize();
      const wander = Math.sin(length * 3.7 + phase) * 0.10 * s.variation;
      direction.addScaledVector(downhill, ds * slope * 1.4).addScaledVector(side, ds * wander);
      direction.copy(tangentOn(direction, normal));
    } else {
      const soft = 0.06 + s.bend * 0.24;
      direction.lerp(DOWN, Math.min(0.35, ds / soft));
      direction.x += Math.sin(length * 2.4 + phase) * ds * 0.07 * s.variation;
      direction.z += Math.sin(length * 3.1 + phase * 0.7) * ds * 0.05 * s.variation;
      direction.normalize();
    }
    let next = current.clone().addScaledVector(direction, ds);
    const hit = surface.nearest(next, clearance + ds * 1.5);
    if (!hanging && hit && hit.normal.y >= -0.65 * s.cling &&
        hit.normal.dot(normal) > -0.35 && hit.distance < clearance + ds * (0.5 + s.cling)) {
      // Follow a local connected surface. A side or undercut releases at low cling.
      const releaseSlope = 0.30 - s.cling * 0.75;
      if (hit.normal.y < releaseSlope && direction.y < -0.2) {
        hanging = true;
      } else {
        normal.copy(hit.normal);
        next.copy(hit.point).addScaledVector(normal, clearance);
        contactSupport = true;
      }
    } else if (!hanging) hanging = true;
    if (hanging && releaseIndex < 0) releaseIndex = points.length;
    surface.project(next, clearance);
    // Collision and distance projections also round a sharp lip. Test the entire
    // segment, since endpoints alone miss thin ledges and corner penetrations.
    for (let pass = 0; pass < 5; pass++) {
      const mid = current.clone().lerp(next, 0.5);
      const projected = surface.project(mid.clone(), clearance);
      if (projected.distanceToSquared(mid) < 1e-12) break;
      next.add(projected.sub(mid).multiplyScalar(2));
      surface.project(next, clearance);
    }
    if (!surface.clear(current, next, clearance * 0.95)) {
      // A difficult concavity is handled by smaller forward growth, never by
      // teleporting the stem through the rock or switching to its other side.
      next.copy(current).addScaledVector(direction, ds * 0.25);
      surface.project(next, clearance * 1.08);
      if (!surface.clear(current, next, clearance * 0.9)) throw new Error("The vine is trapped in a narrow crevice. Move its root or direction slightly.");
    }
    let advance = current.distanceTo(next);
    if (advance < ds * 0.03) {
      hanging = true;
      direction.addScaledVector(normal, 0.3).normalize();
      continue;
    }
    if (advance > s.length - length) {
      next.lerpVectors(current, next, (s.length - length) / advance);
      advance = s.length - length;
    }
    const actualDirection = next.clone().sub(current).normalize();
    direction.lerp(actualDirection, 0.65).normalize();
    const near = surface.nearest(next, clearance * 1.5);
    if (near) {
      normal.copy(near.normal);
      contactSupport ||= near.signed < clearance * 1.3;
    } else {
      // Transport the previous outward orientation without introducing flips.
      normal = tangentOn(normal, direction);
    }
    points.push(next.clone()); normals.push(normal.clone()); supported.push(contactSupport);
    current = next; length += advance;
  }
  if (length < s.length - 0.001) throw new Error("The vine could not reach its requested length on this surface.");
  const group = new THREE.Group(); group.name = "Hanging vine";
  group.userData.hangingVine = JSON.parse(JSON.stringify(recipe));
  const natural = s.natural !== false;
  // Sway weight per path point: metres of free hang below the release point (0 on the rock).
  // Exported as a vertex attribute so a game shader can animate wind; the editor previews it.
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + points[i].distanceTo(points[i - 1]));
  const sway = points.map((_, i) => releaseIndex >= 0 && i >= releaseIndex ? along[i] - along[releaseIndex] : 0);
  const stemMaterial = new THREE.MeshStandardMaterial({ color: natural ? 0xffffff : 0x506237, roughness: 0.88, vertexColors: natural });
  stemMaterial.name = "Vine stem";
  const stemGeometry = tubeGeometry(points, s.radius);
  setRingAttribute(stemGeometry, "sway", points.map((_, i) => [sway[i]]));
  if (natural) {
    // Woody brown at the root, ripening to green, fresh green at the growing tip.
    const wood = new THREE.Color("#5b4a33"), green = new THREE.Color("#4b6a30"), fresh = new THREE.Color("#6f9440");
    setRingAttribute(stemGeometry, "color", points.map((_, i) => {
      const f = along[i] / Math.max(length, 1e-6), c = new THREE.Color();
      if (f < 0.45) c.lerpColors(wood, green, f / 0.45); else c.lerpColors(green, fresh, (f - 0.45) / 0.55);
      return [c.r, c.g, c.b];
    }));
  }
  const stem = new THREE.Mesh(stemGeometry, stemMaterial);
  stem.name = "Tapered stem"; stem.castShadow = true; stem.receiveShadow = true; group.add(stem);
  const obstacles: VineObstacle[] = [];
  // The stem as a chain of spheres (every ~6 cm) so neighbouring vines keep their leaves off it.
  for (let i = 0, last = -1; i < points.length; i++) {
    if (last >= 0 && along[i] - along[last] < 0.06) continue;
    obstacles.push({ centre: points[i].clone(), radius: s.radius * 1.8 + 0.01 }); last = i;
  }
  const leafCount = addLeaves(group, points, normals, supported, surface, s, stemMaterial, sway, options.avoid ?? [], obstacles);
  return { group, points, normals, supported, length, leafCount, releaseIndex, obstacles };
}

/** Parallel transported rings keep tube and leaf orientation stable at near-vertical bends. */
export function tubeGeometry(path: THREE.Vector3[], radius: number, sides = 8, tipRadius = 0.3): THREE.BufferGeometry {
  const vertices: number[] = [], uvs: number[] = [], indices: number[] = [];
  let frame = new THREE.Vector3(1, 0, 0), distance = 0;
  const total = path.reduce((d, p, i) => d + (i ? p.distanceTo(path[i - 1]) : 0), 0);
  for (let i = 0; i < path.length; i++) {
    const tangent = path[Math.min(i + 1, path.length - 1)].clone().sub(path[Math.max(0, i - 1)]).normalize();
    frame = tangentOn(frame, tangent);
    const binormal = new THREE.Vector3().crossVectors(tangent, frame).normalize();
    if (i) distance += path[i].distanceTo(path[i - 1]);
    const taper = tipRadius + (1 - tipRadius) * Math.pow(1 - distance / Math.max(total, 1e-6), 0.4);
    for (let j = 0; j <= sides; j++) {
      const angle = j / sides * Math.PI * 2;
      const p = path[i].clone().addScaledVector(frame, Math.cos(angle) * radius * taper)
        .addScaledVector(binormal, Math.sin(angle) * radius * taper);
      vertices.push(p.x, p.y, p.z); uvs.push(j / sides, distance);
      if (i && j < sides) {
        const a = (i - 1) * (sides + 1) + j, b = i * (sides + 1) + j;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  // Close both cut ends.
  for (let j = 1; j < sides - 1; j++) {
    indices.push(0, j + 1, j);
    const end = (path.length - 1) * (sides + 1); indices.push(end, end + j, end + j + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

/** Fill a per-ring attribute on a tubeGeometry (n sides => n + 1 vertices per path point). */
export function setRingAttribute(geometry: THREE.BufferGeometry, name: string, perPoint: number[][]): void {
  const size = perPoint[0].length, ring = geometry.getAttribute("position").count / perPoint.length, out = new Float32Array(perPoint.length * ring * size);
  perPoint.forEach((v, i) => { for (let j = 0; j < ring; j++) out.set(v, (i * ring + j) * size); });
  geometry.setAttribute(name, new THREE.BufferAttribute(out, size));
}


/**
 * Something a leaf must not pass through: a stem sphere, or a placed leaf (bounding sphere
 * plus its card frame, used for an exact-enough "is this point inside that leaf's blade" test).
 */
export type VineObstacle = {
  centre: THREE.Vector3; radius: number;
  leaf?: { cardCentre: THREE.Vector3; axis: THREE.Vector3; width: THREE.Vector3; face: THREE.Vector3; halfLength: number; halfWidth: number; points: THREE.Vector3[] };
};
type CardFrame = NonNullable<VineObstacle["leaf"]>;
/** True when point `p` (padded by `pad`) lies inside an obstacle: a stem sphere or a leaf blade. */
export function pointHitsObstacle(p: THREE.Vector3, o: VineObstacle, pad: number): boolean {
  if (p.distanceTo(o.centre) > o.radius + pad) return false;
  if (!o.leaf) return true;
  return insideBlade([p], o.leaf, Math.max(pad, o.leaf.halfLength * 0.26)) > 0;
}
/** Points of `pts` that sit inside the blade of `card` (within its outline and close to its surface). */
function insideBlade(pts: THREE.Vector3[], card: CardFrame, thickness: number): number {
  let n = 0; const rel = new THREE.Vector3();
  for (const p of pts) {
    rel.subVectors(p, card.cardCentre);
    const x = rel.dot(card.width) / card.halfWidth, y = rel.dot(card.axis) / card.halfLength;
    if (x * x + y * y < 0.8 && Math.abs(rel.dot(card.face)) < thickness) n++;
  }
  return n;
}
function makeObstacle(vertices: THREE.Vector3[], base: THREE.Vector3, axis: THREE.Vector3, width: THREE.Vector3,
  face: THREE.Vector3, size: number, profile: { baseUv: [number, number]; geometryAspect: number }): VineObstacle {
  const cardCentre = base.clone().addScaledVector(axis, (0.5 - profile.baseUv[1]) * size)
    .addScaledVector(width, (0.5 - profile.baseUv[0]) * size * profile.geometryAspect);
  const halfLength = size / 2, halfWidth = size * profile.geometryAspect / 2;
  return { centre: cardCentre, radius: Math.hypot(halfLength, halfWidth) * 1.05,
    leaf: { cardCentre, axis: axis.clone(), width: width.clone(), face: face.clone(), halfLength, halfWidth, points: vertices } };
}
/** Does a candidate leaf collide with an obstacle? */
function collides(cand: VineObstacle, other: VineObstacle, size: number): boolean {
  if (cand.centre.distanceTo(other.centre) > cand.radius + other.radius) return false;
  if (!other.leaf) {
    // Stem sphere: any blade point inside it.
    return cand.leaf!.points.some(p => p.distanceTo(other.centre) < other.radius);
  }
  // Leaf vs leaf: either blade has points lying in the other's blade.
  const thick = Math.max(size, other.leaf.halfLength * 2) * 0.13;
  return insideBlade(cand.leaf!.points, other.leaf, thick) >= 2 || insideBlade(other.leaf.points, cand.leaf!, thick) >= 2;
}

function addLeaves(group: THREE.Group, points: THREE.Vector3[], normals: THREE.Vector3[], supported: boolean[],
  surface: VineSurface, s: HangingVineSettings, stemMaterial: THREE.Material, sway: number[],
  avoid: VineObstacle[], obstacles: VineObstacle[]): number {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = distances[distances.length - 1];
  // One atlas material for every leaf: one draw call per vine for all leaf cards.
  const leafMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.5 });
  leafMaterial.alphaToCoverage = true;
  // The scene lights (and ACES exposure) are tuned for the rock, so leaf albedo is scaled down
  // in the vertex colours: tinted greens to 62 %, painted leaves (already shaded) to 60 %.
  const TINT_SCALE = 0.62, PAINT_SCALE = 0.6;
  leafMaterial.name = "Painted leaves"; leafMaterial.userData.hangingLeaf = { atlas: true };
  // leafStyle: "mixed" (every leaf) or leaf ids joined by "+". Unknown ids are ignored.
  const chosen = s.leafStyle === "mixed" ? [] : s.leafStyle.split("+");
  let pool = leafLibrary.filter(p => chosen.includes(p.id));
  if (!pool.length) pool = leafLibrary;
  // The atlas is a white mask: each leaf takes one of the chosen greens as its vertex colour.
  const wanted = (s.shades ?? "").split("+").filter(Boolean);
  const shades = (wanted.length ? LEAF_SHADES.filter(x => wanted.includes(x.id)) : LEAF_SHADES)
    .map(x => new THREE.Color(x.hex));   // converted to linear by three's colour management
  if (!shades.length) shades.push(new THREE.Color(LEAF_SHADES[3].hex));
  const natural = s.natural !== false;
  // Shades sorted dark -> light by luminance, so "age" can walk along them.
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const byLight = [...shades].sort((a, b) => lum(a) - lum(b));
  const COLS = natural ? 4 : 2, ROWS = natural ? 5 : 4;   // grid cells across / along the blade
  const stalkColour = new THREE.Color("#5f8a3a");
  const stalks: { path: THREE.Vector3[]; sway: number }[] = [];
  const placed: VineObstacle[] = [];
  const batch = { vertices: [] as number[], uvs: [] as number[], colors: [] as number[], sway: [] as number[], indices: [] as number[] };
  let count = 0, segment = 1;

  /** Build one leaf at arc length `target`. Returns true when it was placed. */
  const buildLeaf = (key: number, target: number, sideSign: number, sizeMul: number): boolean => {
    const random = (salt: number) => rand(s.seed, key, salt);
    // "mixed" (or any style this sheet doesn't have) picks a leaf per node from the seed.
    const profile = pool[Math.floor(random(7) * pool.length) % pool.length];
    while (segment < distances.length - 1 && distances[segment] < target) segment++;
    const t = (target - distances[segment - 1]) / (distances[segment] - distances[segment - 1]);
    const root = points[segment - 1].clone().lerp(points[segment], t);
    const nodeSway = THREE.MathUtils.lerp(sway[segment - 1], sway[segment], t);
    const tangent = points[segment].clone().sub(points[segment - 1]).normalize();
    const outward = tangentOn(normals[segment - 1].clone().lerp(normals[segment], t), tangent);
    const side = new THREE.Vector3().crossVectors(tangent, outward).normalize().multiplyScalar(sideSign);
    const age = Math.min(1, target / Math.max(total, 1e-6));          // 0 at the root, 1 at the tip
    const hanging = !supported[segment];
    const angle = THREE.MathUtils.degToRad(s.leafAngle + (random(1) - 0.5) * 28 * s.variation);
    let axis: THREE.Vector3, face: THREE.Vector3, stalkOut: THREE.Vector3, petiole: number;
    let size = sizeMul * s.leafSize * profile.scale * (0.80 + random(4) * 0.35 * s.variation) * (0.5 + 0.5 * Math.min(1, (total - target) / 0.5));
    if (natural) {
      // Older leaves near the root are larger; young ones toward the growing tip are smaller.
      size *= 1.15 - 0.45 * Math.pow(age, 1.2);
      // Stalks leave the stem sideways and a little outward, away from the rock, at varied lengths.
      stalkOut = side.clone().multiplyScalar(Math.sin(angle)).addScaledVector(outward, 0.55 + 0.25 * random(2)).normalize();
      petiole = size * (0.25 + 0.30 * random(9) * (0.5 + s.variation));
      if (hanging) {
        // Gravity: the blade droops, tip down, face turned outward toward the light.
        const droop = 0.62 + (random(10) - 0.5) * 0.35 * s.variation;
        axis = stalkOut.clone().lerp(DOWN, droop).normalize();
        face = tangentOn(outward.clone().addScaledVector(stalkOut, 0.4).addScaledVector(side, (random(3) - 0.5) * 0.6 * s.variation), axis);
      } else {
        // On the rock the blade lies close to the surface, leaning a little downhill.
        axis = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
        axis.addScaledVector(tangentOn(DOWN, outward), 0.25).addScaledVector(outward, 0.12).normalize();
        face = tangentOn(outward.clone().addScaledVector(side, (random(3) - 0.5) * 0.4 * s.variation), axis);
      }
    } else {
      axis = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
      // Supported leaves lift clear of the surface. Hanging leaves turn gently around the stem.
      axis.addScaledVector(outward, supported[segment] ? 0.55 : 0.18 + (random(2) - 0.5) * s.variation).normalize();
      face = outward.clone().addScaledVector(side, (random(3) - 0.5) * 0.7 * s.variation);
      stalkOut = axis.clone(); petiole = size * 0.16;
    }
    // Blade curvature (natural): cupped across the midrib, arched along it, tip curling back.
    const cup = natural ? (0.10 + 0.08 * random(11) * s.variation) : 0;
    const arch = natural ? (0.05 + 0.05 * random(12)) : 0;
    const curl = natural ? (0.08 + 0.10 * random(13) * (0.5 + s.variation)) : 0;
    let base = root.clone(), ctrl = root.clone(), widthAxis = new THREE.Vector3(), vertices: THREE.Vector3[] = [];
    let ok = false, cand: VineObstacle | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      face = tangentOn(face, axis); widthAxis.crossVectors(axis, face).normalize();
      base = root.clone().addScaledVector(stalkOut, petiole).addScaledVector(outward, s.radius);
      // The stalk arches: up and out before the blade falls (hanging), or up off the rock (crawling).
      ctrl = root.clone().addScaledVector(stalkOut, petiole * 0.45)
        .addScaledVector(natural ? (hanging ? UP : outward) : stalkOut, natural ? petiole * 0.35 : 0);
      if (natural && hanging) base.addScaledVector(UP, petiole * 0.15);
      vertices = [];
      for (let row = 0; row <= ROWS; row++) {
        const v = row / ROWS;
        for (let col = 0; col <= COLS; col++) {
          const u = col / COLS, across = 2 * u - 1;
          const lift = natural
            ? cup * across * across + arch * Math.sin(v * Math.PI) - curl * Math.pow(Math.max(0, v - 0.55) / 0.45, 2)
            : (col === 1 ? 0.045 : 0) * Math.sin(v * Math.PI);
          vertices.push(base.clone().addScaledVector(axis, (v - profile.baseUv[1]) * size)
            .addScaledVector(widthAxis, (u - profile.baseUv[0]) * size * profile.geometryAspect)
            .addScaledVector(face, lift * size));
        }
      }
      const rockClear = vertices.every(p => { const h = surface.nearest(p, size); return !h || h.signed >= 0.002; }) &&
        surface.clear(root, base, s.radius * 0.2);
      // Leaves must not pass through other leaves of this vine, nor other vines' leaves and stems.
      let leafClear = true;
      if (natural && rockClear) {
        cand = makeObstacle(vertices, base, axis, widthAxis, face, size, profile);
        for (const other of placed) if (collides(cand, other, size)) { leafClear = false; break; }
        if (leafClear) for (const other of avoid) if (collides(cand, other, size)) { leafClear = false; break; }
      }
      if (rockClear && leafClear) { ok = true; break; }
      if (!rockClear) { axis.addScaledVector(outward, 0.55).normalize(); size *= 0.86; }
      else {
        // Swing the leaf around the stem, alternating sides, and shrink it a little.
        axis.applyAxisAngle(tangent, (attempt % 2 ? -1 : 1) * 0.5 * (1 + attempt * 0.3)).normalize();
        stalkOut.applyAxisAngle(tangent, (attempt % 2 ? -1 : 1) * 0.35).normalize();
        size *= 0.92;
      }
    }
    if (!ok) return false;
    const offset = batch.vertices.length / 3;
    const [ru, rv, rw, rh] = profile.atlasRect;
    let shade: THREE.Color;
    if (natural) {
      // Colour by age: dark mature greens at the root, fresh light greens toward the tip, with some spread.
      const spread = (random(8) - 0.5) * byLight.length * 0.45 * (0.4 + s.variation);
      const k = Math.round(age * (byLight.length - 1) + spread);
      shade = byLight[Math.min(byLight.length - 1, Math.max(0, k))];
    } else shade = shades[Math.floor(random(8) * shades.length) % shades.length];
    let scale = TINT_SCALE;
    if (profile.keepColour) {
      // Painted leaf keeps its own colours; with natural leaves, older ones near the root are a little darker.
      // paintTint shifts its average colour toward the chosen green while keeping the painted light and dark.
      const tint = s.paintTint ?? 0;
      if (tint > 0) {
        const avg = new THREE.Color(profile.avgColour ?? "#7aa744");
        const ratio = new THREE.Color(shade.r / Math.max(avg.r, 1e-3), shade.g / Math.max(avg.g, 1e-3), shade.b / Math.max(avg.b, 1e-3));
        shade = WHITE.clone().lerp(ratio, tint);
      } else shade = WHITE;
      scale = PAINT_SCALE * (natural ? 0.9 + 0.16 * age : 1);
    }
    const tone = (0.92 + random(5) * 0.16 * (0.4 + s.variation)) * scale;
    vertices.forEach((p, i) => {
      const col = i % (COLS + 1), row = Math.floor(i / (COLS + 1));
      // Shading inside the leaf (natural): darker at the base, a lighter midrib, slightly darker rim.
      let f = 1;
      if (natural) {
        const v = row / ROWS, across = Math.abs(2 * col / COLS - 1);
        f = (0.86 + 0.20 * THREE.MathUtils.smoothstep(v, 0, 0.6)) * (col === COLS / 2 ? 1.08 : 1) * (1 - 0.07 * across * across);
      }
      batch.vertices.push(p.x, p.y, p.z);
      batch.uvs.push(ru + col / COLS * rw, rv + row / ROWS * rh);
      batch.colors.push(shade.r * tone * f, shade.g * tone * f, shade.b * tone * f);
      batch.sway.push(nodeSway);
    });
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
      const a = offset + row * (COLS + 1) + col, b = a + COLS + 1;
      batch.indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
    // Stalk as a short quadratic curve root -> ctrl -> base.
    const path: THREE.Vector3[] = [];
    for (let k = 0; k <= 4; k++) {
      const q = k / 4;
      path.push(root.clone().multiplyScalar((1 - q) * (1 - q)).addScaledVector(ctrl, 2 * q * (1 - q)).addScaledVector(base, q * q));
    }
    stalks.push({ path, sway: nodeSway });
    const ob = cand ?? makeObstacle(vertices, base, axis, widthAxis, face, size, profile);
    placed.push(ob); obstacles.push(ob);
    count++;
    return true;
  };

  for (let node = 0, target = s.leafSpacing * 0.55; target < total - 0.045; node++) {
    const r = (salt: number) => rand(s.seed, node, salt);
    const sideSign = node % 2 ? -1 : 1;
    if (natural) {
      // Uneven rhythm: an occasional missing leaf, an occasional pair at one node.
      const missing = r(20) < 0.08 + 0.08 * s.variation;
      if (!missing) {
        buildLeaf(node, target, sideSign, 1);
        if (r(21) < 0.10 + 0.12 * s.variation) buildLeaf(node + 1_000_000, target, -sideSign, 0.78);
      }
      const gap = r(22) < 0.07 ? 1.7 : 1;
      target += s.leafSpacing * gap * (1 + (r(6) - 0.5) * 0.9 * s.variation);
    } else {
      buildLeaf(node, target, sideSign, 1);
      target += s.leafSpacing * (1 + (r(6) - 0.5) * 0.5 * s.variation);
    }
  }
  if (batch.vertices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(batch.vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batch.uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(batch.colors, 3));
    geometry.setAttribute("sway", new THREE.Float32BufferAttribute(batch.sway, 1));
    geometry.setIndex(batch.indices); geometry.computeVertexNormals();
    leafMaterial.vertexColors = true;
    const mesh = new THREE.Mesh(geometry, leafMaterial);
    mesh.name = "Leaf cards 1"; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  }
  // One merged stalk mesh, not a draw call for every leaf.
  if (stalks.length) {
    const vertices: number[] = [], colors: number[] = [], swayOut: number[] = [], indices: number[] = [];
    for (const part of stalks) {
      const g = tubeGeometry(part.path, s.radius * (natural ? 0.32 : 0.36)), attr = g.getAttribute("position"), offset = vertices.length / 3;
      vertices.push(...Array.from(attr.array)); indices.push(...Array.from(g.index!.array).map(i => i + offset));
      for (let i = 0; i < attr.count; i++) { colors.push(stalkColour.r, stalkColour.g, stalkColour.b); swayOut.push(part.sway); }
      g.dispose();
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("sway", new THREE.Float32BufferAttribute(swayOut, 1));
    geo.setIndex(indices); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, stemMaterial); mesh.name = "Leaf stalks"; mesh.castShadow = true; group.add(mesh);
  }
  return count;
}

const atlasCache = new Map<string, THREE.Texture>();
/** Call before showing/exporting. Loads the leaf atlas onto every leaf material; a missing texture is surfaced, never silently replaced. */
export async function applyHangingVineLeafTextures(group: THREE.Group, options: { atlasUrl?: string; texture?: THREE.Texture }): Promise<void> {
  const materials = new Set<THREE.MeshStandardMaterial>();
  group.traverse(object => {
    if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material.userData.hangingLeaf) materials.add(material as THREE.MeshStandardMaterial);
  });
  if (!materials.size) return;
  let texture = options.texture ?? atlasCache.get(options.atlasUrl ?? "");
  if (!texture) {
    if (!options.atlasUrl) throw new Error("No leaf texture was given.");
    try { texture = await new THREE.TextureLoader().loadAsync(options.atlasUrl); }
    catch { throw new Error("The leaf textures could not be loaded."); }
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.userData.shared = true;
    atlasCache.set(options.atlasUrl, texture);
  }
  for (const material of materials) { material.map = texture; material.needsUpdate = true; }
}

export function disposeHangingVine(group: THREE.Group): void {
  const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  group.traverse(o => { if (o instanceof THREE.Mesh) {
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      materials.add(m); const map = (m as THREE.MeshStandardMaterial).map; if (map && !map.userData.shared) textures.add(map);
    }
  } });
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
}
