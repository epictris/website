import * as THREE from "three";
import { VineSurface, rand } from "./foliage/vine/hangingVine";

/** Bend the Blender atlas cards, retaining their UVs and painted colours.
 * glTF flips Blender's V coordinate: the stalk is at the high-V end.
 * Connected rock underlays, constant-UV stems and segmented hanging strands
 * are retained. Only isolated, rectangular two-triangle cards are rebuilt. */
export function curveIvyGeometry(source: THREE.BufferGeometry, world: THREE.Matrix4, rock?: VineSurface): THREE.BufferGeometry {
  if (source.userData.curvedIvy) return source;
  const position = source.getAttribute("position"), uv = source.getAttribute("uv");
  if (!position || !uv || !source.index) return source;
  const index = source.index, parent = new Int32Array(position.count);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let i = 0; i < index.count; i += 3) {
    const a = find(index.getX(i)); parent[find(index.getX(i + 1))] = a; parent[find(index.getX(i + 2))] = a;
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < position.count; i++) {
    const root = find(i); let list = components.get(root);
    if (!list) components.set(root, list = []); list.push(i);
  }
  const inverse = world.clone().invert(), normalMatrix = new THREE.Matrix3().getNormalMatrix(world);
  const values: Record<string, number[]> = {};
  for (const key of Object.keys(source.attributes)) values[key] = [];
  const triangles: number[] = [], replaced = new Set<number>();
  let count = 0;
  const get = (id: number) => new THREE.Vector3().fromBufferAttribute(position, id).applyMatrix4(world);
  for (const ids of components.values()) {
    if (ids.length !== 4) continue;
    const us = ids.map(i => uv.getX(i)), vs = ids.map(i => uv.getY(i));
    const loU = Math.min(...us), hiU = Math.max(...us), loV = Math.min(...vs), hiV = Math.max(...vs);
    const du = hiU - loU, dv = hiV - loV;
    if (du < .02 || dv < .02 || dv / du > 1.6 || du / dv > 1.6) continue;
    // Quantized exports need a tolerance at their UV corners.
    const corner = (u: number, v: number) => ids.find(i => Math.abs(uv.getX(i) - u) < .0002 && Math.abs(uv.getY(i) - v) < .0002);
    const corners = [corner(loU, hiV), corner(hiU, hiV), corner(loU, loV), corner(hiU, loV)];
    if (corners.some(i => i === undefined) || new Set(corners).size !== 4) continue;
    const [a, b, c, d] = corners as number[];
    const points = [get(a!), get(b!), get(c!), get(d!)];
    const bottom = points[0]!.clone().lerp(points[1]!, .5), top = points[2]!.clone().lerp(points[3]!, .5);
    const height = bottom.distanceTo(top), width = points[0]!.distanceTo(points[1]!);
    if (height < .005 || height > 1.5) continue;
    const n = source.getAttribute("normal");
    const normal = n ? new THREE.Vector3().fromBufferAttribute(n, a!).applyMatrix3(normalMatrix).normalize()
      : points[1]!.clone().sub(points[0]!).cross(top.clone().sub(bottom)).normalize();
    const base = du > .195 ? .16 : .09;
    const anchor = bottom.clone().lerp(top, base), pull = new THREE.Vector3();
    const hit = rock?.nearest(anchor, Math.max(.25, height * .8));
    if (hit && hit.normal.dot(normal) > -.2) {
      const target = hit.point.clone().addScaledVector(hit.normal, .009);
      pull.subVectors(target, anchor).clampLength(0, Math.min(.08, height * .45));
    }
    const curl = .09 + .07 * rand(2401, a!, 1), fold = .07 + .06 * rand(2401, a!, 2);
    const rows = [0, base, .4, .7, 1], offset = count;
    for (const s of rows) for (const u of [0, .5, 1]) {
      const weights = [(1 - u) * (1 - s), u * (1 - s), (1 - u) * s, u * s];
      const p = new THREE.Vector3(); points.forEach((point, k) => p.addScaledVector(point, weights[k]!));
      const t = Math.max(0, (s - base) / (1 - base));
      p.add(pull).addScaledVector(normal, height * (.08 * Math.sin(Math.PI * t) - curl * t * t)
        + width * fold * (2 * u - 1) ** 2 * Math.sin(Math.PI * t));
      // The same surface projection used by vines prevents curling into stone.
      rock?.project(p, .005);
      p.applyMatrix4(inverse);
      for (const [name, output] of Object.entries(values)) {
        const attr = source.getAttribute(name);
        for (let k = 0; k < attr.itemSize; k++) {
          if (name === "position") output.push(p.getComponent(k));
          else output.push(corners.reduce<number>((sum, id, j) => sum + attr.getComponent(id!, k) * weights[j]!, 0));
        }
      }
      count++;
    }
    const geometric = points[1]!.clone().sub(points[0]!).cross(top.clone().sub(bottom));
    const reverse = geometric.dot(normal) * Math.sign(world.determinant()) < 0;
    for (let r = 0; r < rows.length - 1; r++) for (let col = 0; col < 2; col++) {
      const i = offset + r * 3 + col;
      const face = [i, i + 1, i + 4, i, i + 4, i + 3];
      if (reverse) for (let j = 0; j < face.length; j += 3) [face[j + 1], face[j + 2]] = [face[j + 2]!, face[j + 1]!];
      triangles.push(...face);
    }
    ids.forEach(i => replaced.add(i));
  }
  if (!replaced.size) return source;
  const preserved = new Map<number, number>();
  for (let i = 0; i < index.count; i++) {
    const id = index.getX(i); if (replaced.has(id)) continue;
    let at = preserved.get(id);
    if (at === undefined) {
      at = count++; preserved.set(id, at);
      for (const [name, output] of Object.entries(values)) {
        const attr = source.getAttribute(name);
        for (let k = 0; k < attr.itemSize; k++) output.push(attr.getComponent(id, k));
      }
    }
    triangles.push(at);
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, output] of Object.entries(values)) geometry.setAttribute(name, new THREE.Float32BufferAttribute(output, source.getAttribute(name).itemSize));
  geometry.setIndex(triangles); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.curvedIvy = true;
  return geometry;
}

/** Read the nearest opaque host into the vine generator's surface structure. */
export function ivyHostSurface(mesh: THREE.Mesh): VineSurface | undefined {
  let host = mesh.parent;
  const ivyName = (o: THREE.Object3D) => /\.(ivy|moss)(\.shadow)?$/.test(String(o.userData.name ?? o.name));
  while (host && ivyName(host)) host = host.parent;
  if (!host) return;
  const soup: number[] = [];
  host.traverse(node => {
    if (!(node instanceof THREE.Mesh) || node === mesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    if (mats.some(m => m.alphaTest > 0 || m.transparent)) return;
    const attr = node.geometry.getAttribute("position"), index = node.geometry.index;
    if (!attr) return;
    const winding = node.matrixWorld.determinant() < 0 ? [0, 2, 1] : [0, 1, 2];
    const p = new THREE.Vector3();
    for (let i = 0; i < (index?.count ?? attr.count); i += 3) for (const j of winding) {
      p.fromBufferAttribute(attr, index ? index.getX(i + j) : i + j).applyMatrix4(node.matrixWorld);
      soup.push(p.x, p.y, p.z);
    }
  });
  return soup.length ? new VineSurface(new Float32Array(soup)) : undefined;
}
