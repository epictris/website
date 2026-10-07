import * as THREE from "three";
import { HANGING_LEAF_PROFILES } from "./hangingLeafProfiles";

/** Decorative, baked vines. All coordinates and lengths are in metres, Y up. */
export interface HangingVineSettings {
  length: number; radius: number; cling: number; bend: number;
  leafSpacing: number; leafSize: number; leafAngle: number; variation: number;
  seed: number; leafStyle: string;
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
}
type Face = { triangle: THREE.Triangle; normal: THREE.Vector3; box: THREE.Box3; centre: THREE.Vector3 };
type Node = { box: THREE.Box3; left?: Node; right?: Node; faces?: Face[] };
type Contact = { point: THREE.Vector3; normal: THREE.Vector3; distance: number; signed: number };
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
  if (!Number.isInteger(s.seed) || typeof s.leafStyle !== "string" || !/^[a-z0-9_-]{1,50}$/.test(s.leafStyle))
    throw new Error("Invalid seed or leaf style.");
}
const rand = (seed: number, i: number, salt = 0): number => {
  let n = (seed ^ Math.imul(i + 1, 374761393) ^ Math.imul(salt + 1, 668265263)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const tangentOn = (direction: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 => {
  const tangent = direction.clone().addScaledVector(normal, -direction.dot(normal));
  if (tangent.lengthSq() < 1e-8) tangent.crossVectors(normal, Math.abs(normal.z) < 0.9 ? FORWARD : UP);
  return tangent.normalize();
};

/** Bounded incremental growth; exact centreline length, independent of mesh tessellation. */
export function generateHangingVine(positions: Float32Array | number[], recipe: HangingVineRecipe): HangingVineResult {
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
  const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x506237, roughness: 0.88 });
  const stem = new THREE.Mesh(tubeGeometry(points, s.radius), stemMaterial);
  stem.name = "Tapered stem"; stem.castShadow = true; stem.receiveShadow = true; group.add(stem);
  const leafCount = addLeaves(group, points, normals, supported, surface, s, stemMaterial);
  return { group, points, normals, supported, length, leafCount, releaseIndex };
}

/** Parallel transported rings keep tube and leaf orientation stable at near-vertical bends. */
function tubeGeometry(path: THREE.Vector3[], radius: number): THREE.BufferGeometry {
  const vertices: number[] = [], uvs: number[] = [], indices: number[] = [];
  const sides = 8;
  let frame = new THREE.Vector3(1, 0, 0), distance = 0;
  const total = path.reduce((d, p, i) => d + (i ? p.distanceTo(path[i - 1]) : 0), 0);
  for (let i = 0; i < path.length; i++) {
    const tangent = path[Math.min(i + 1, path.length - 1)].clone().sub(path[Math.max(0, i - 1)]).normalize();
    frame = tangentOn(frame, tangent);
    const binormal = new THREE.Vector3().crossVectors(tangent, frame).normalize();
    if (i) distance += path[i].distanceTo(path[i - 1]);
    const taper = 0.30 + 0.70 * Math.pow(1 - distance / Math.max(total, 1e-6), 0.4);
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

// Texture names are resolved from the supplied leaf manifest at texture-load time.
function addLeaves(group: THREE.Group, points: THREE.Vector3[], normals: THREE.Vector3[], supported: boolean[],
  surface: VineSurface, s: HangingVineSettings, stemMaterial: THREE.Material): number {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = distances[distances.length - 1];
  const materials = [0, 1, 2].map(index => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.35 });
    m.name = `SVG leaf ${index + 1}`; m.userData.hangingLeaf = { index, style: s.leafStyle }; return m;
  });
  const petioleParts: THREE.Vector3[][] = [];
  const batches = [0, 1, 2].map(() => ({ vertices: [] as number[], uvs: [] as number[], colors: [] as number[], indices: [] as number[] }));
  let count = 0, segment = 1;
  for (let node = 0, target = s.leafSpacing * 0.55; target < total - 0.045; node++) {
    const variant = node % 3;
    const profile = HANGING_LEAF_PROFILES.find(p => p.shape === s.leafStyle) ?? HANGING_LEAF_PROFILES[variant];
    while (segment < distances.length - 1 && distances[segment] < target) segment++;
    const t = (target - distances[segment - 1]) / (distances[segment] - distances[segment - 1]);
    const root = points[segment - 1].clone().lerp(points[segment], t);
    const tangent = points[segment].clone().sub(points[segment - 1]).normalize();
    const outward = tangentOn(normals[segment - 1].clone().lerp(normals[segment], t), tangent);
    const side = new THREE.Vector3().crossVectors(tangent, outward).normalize().multiplyScalar(node % 2 ? -1 : 1);
    const random = (salt: number) => rand(s.seed, node, salt);
    const angle = THREE.MathUtils.degToRad(s.leafAngle + (random(1) - 0.5) * 28 * s.variation);
    let axis = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
    // Supported leaves lift clear of the surface. Hanging leaves turn gently
    // around the stem, with actual 3D variation rather than camera billboarding.
    axis.addScaledVector(outward, supported[segment] ? 0.55 : 0.18 + (random(2) - 0.5) * s.variation).normalize();
    let face = outward.clone().addScaledVector(side, (random(3) - 0.5) * 0.7 * s.variation);
    let size = s.leafSize * (0.80 + random(4) * 0.35 * s.variation) * (0.5 + 0.5 * Math.min(1, (total - target) / 0.5));
    let base = root.clone(), widthAxis = new THREE.Vector3(), vertices: THREE.Vector3[] = [];
    let clear = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      face = tangentOn(face, axis); widthAxis.crossVectors(axis, face).normalize();
      base = root.clone().addScaledVector(axis, size * 0.16).addScaledVector(outward, s.radius);
      // Two panels with a raised central vein; UV base .5,0 and tip .5,1.
      vertices = [];
      for (let row = 0; row <= 4; row++) {
        const v = row / 4;
        for (let col = 0; col <= 2; col++) {
          const u = col / 2;
          vertices.push(base.clone().addScaledVector(axis, (v - profile.baseUv[1]) * size)
            .addScaledVector(widthAxis, (u - profile.baseUv[0]) * size * profile.geometryAspect)
            .addScaledVector(face, (col === 1 ? 0.045 : 0) * size * Math.sin(v * Math.PI)));
        }
      }
      clear = vertices.every(p => { const h = surface.nearest(p, size); return !h || h.signed >= 0.002; }) &&
        surface.clear(root, base, s.radius * 0.2);
      if (clear) break;
      axis.addScaledVector(outward, 0.55).normalize(); size *= 0.86;
    }
    if (clear) {
      const batch = batches[variant], offset = batch.vertices.length / 3;
      const tone = 0.88 + random(5) * 0.12;
      vertices.forEach((p, i) => { batch.vertices.push(p.x, p.y, p.z); batch.uvs.push((i % 3) / 2, Math.floor(i / 3) / 4); batch.colors.push(tone, tone, tone); });
      for (let row = 0; row < 4; row++) for (let col = 0; col < 2; col++) {
        const a = offset + row * 3 + col; batch.indices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      }
      petioleParts.push([root, root.clone().lerp(base, 0.5), base]); count++;
    }
    target += s.leafSpacing * (1 + (random(6) - 0.5) * 0.5 * s.variation);
  }
  batches.forEach((batch, index) => {
    if (!batch.vertices.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(batch.vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batch.uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(batch.colors, 3));
    geometry.setIndex(batch.indices); geometry.computeVertexNormals();
    materials[index].vertexColors = true;
    const mesh = new THREE.Mesh(geometry, materials[index]);
    mesh.name = `Leaf cards ${index + 1}`; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  });
  // One merged petiole mesh, not a draw call for every leaf.
  if (petioleParts.length) {
    const vertices: number[] = [], indices: number[] = [];
    for (const part of petioleParts) {
      const g = tubeGeometry(part, s.radius * 0.36), attr = g.getAttribute("position"), offset = vertices.length / 3;
      vertices.push(...Array.from(attr.array)); indices.push(...Array.from(g.index!.array).map(i => i + offset)); g.dispose();
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices); geo.computeVertexNormals();
    const stalks = new THREE.Mesh(geo, stemMaterial); stalks.name = "Leaf stalks"; stalks.castShadow = true; group.add(stalks);
  }
  return count;
}

/** Call before showing/exporting. A missing SVG asset is surfaced, never silently replaced. */
export async function applyHangingVineLeafTextures(group: THREE.Group): Promise<void> {
  const response = await fetch("/hanging-vines/leaves/manifest.json");
  if (!response.ok) throw new Error("The supplied leaf textures could not be loaded.");
  const manifest = await response.json() as { variants: { id: string; shape: string; color: string; png?: string; svg: string }[] };
  if (!manifest.variants?.length) throw new Error("No leaf shapes are available.");
  const variants = manifest.variants;
  const shapes = [...new Set(variants.map(v => v.shape))];
  const materials = new Set<THREE.MeshStandardMaterial>();
  group.traverse(object => {
    if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material.userData.hangingLeaf) materials.add(material as THREE.MeshStandardMaterial);
  });
  await Promise.all([...materials].map(async material => {
    const { index, style } = material.userData.hangingLeaf;
    const shape = shapes.includes(style) ? style : shapes[index % shapes.length];
    const choices = variants.filter(v => v.shape === shape);
    const variant = choices.find(v => v.color === ["leaf", "forest", "leaf"][index % 3]) ?? choices[0];
    const path = variant.png ?? variant.svg;
    const url = path.startsWith("/") ? path : `/hanging-vines/leaves/${path}`;
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    material.map = texture; material.needsUpdate = true;
  }));
}

export function disposeHangingVine(group: THREE.Group): void {
  const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  group.traverse(o => { if (o instanceof THREE.Mesh) {
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      materials.add(m); if ((m as THREE.MeshStandardMaterial).map) textures.add((m as THREE.MeshStandardMaterial).map!);
    }
  } });
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
}
