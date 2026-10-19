import * as THREE from "three";
import { VineSurface, type VineObstacle } from "./vine/hangingVine";

export interface CrystalDimensions { height: number; width: number }
export interface CrystalSettings {
  /** Optional for recipes saved before individual crystal editing existed. */
  width?: number; shapeVariation?: number; crystals?: Record<string, Partial<CrystalDimensions>>;
  shards: number; height: number; radius: number; variation: number;
  lean: number; glow: number; palette: "azure" | "violet" | "mint"; seed: number;
}
export interface CrystalRecipe {
  version: 1; kind: "crystal";
  root: [number, number, number]; normal: [number, number, number];
  settings: CrystalSettings;
}
export const DEFAULT_CRYSTAL_SETTINGS: CrystalSettings = {
  shards: 11, height: .65, radius: .32, variation: .55, lean: .35,
  width: 1, shapeVariation: .65, glow: .8, palette: "azure", seed: 4242,
};
export function validateCrystalRecipe(r: CrystalRecipe): void {
  if (!r || r.version !== 1 || r.kind !== "crystal" || !r.settings) throw new Error("Invalid crystal recipe.");
  for (const key of ["root", "normal"] as const) {
    if (!Array.isArray(r[key]) || r[key].length !== 3 || r[key].some(n => !Number.isFinite(n) || Math.abs(n) > 10000))
      throw new Error(`Invalid crystal ${key}.`);
  }
  if (Math.hypot(...r.normal) < .1) throw new Error("Choose a valid crystal surface normal.");
  const ranges: [keyof CrystalSettings, number, number][] = [
    ["shards", 1, 40], ["height", .05, 3], ["radius", .03, 2], ["variation", 0, 1],
    ["lean", 0, 1], ["glow", 0, 3], ["seed", 0, 2147483647],
  ];
  for (const [key, lo, hi] of ranges) {
    const v = r.settings[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`Crystal ${key} must be between ${lo} and ${hi}.`);
  }
  if (!Number.isInteger(r.settings.seed) || !Number.isInteger(r.settings.shards)) throw new Error("Crystal seed and shard count must be integers.");
  for (const [key, fallback, low, high] of [["width", 1, .2, 3], ["shapeVariation", .65, 0, 1]] as const) {
    const value = r.settings[key] ?? fallback;
    if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid crystal ${key}.`);
  }
  if (r.settings.crystals !== undefined) {
    if (!r.settings.crystals || typeof r.settings.crystals !== "object" || Array.isArray(r.settings.crystals) || Object.keys(r.settings.crystals).length > 40) throw new Error("Invalid individual crystals.");
    for (const [index, dimensions] of Object.entries(r.settings.crystals)) {
      if (!/^(?:[0-9]|[1-3][0-9])$/.test(index) || !dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) throw new Error("Invalid crystal index.");
      for (const key of Object.keys(dimensions)) if (key !== "height" && key !== "width") throw new Error("Invalid crystal dimension.");
      for (const key of ["height", "width"] as const) {
        const value = dimensions[key];
        if (value !== undefined && (!Number.isFinite(value) || value < .01 || value > 3)) throw new Error(`Crystal ${key} must be between .01 and 3 metres.`);
      }
    }
  }
  if (!["azure", "violet", "mint"].includes(r.settings.palette)) throw new Error("Invalid crystal palette.");
}
function random(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Stable dimensions by crystal index; a width edit never changes its height or neighbours. */
export function crystalDimensions(settings: CrystalSettings, index: number): CrystalDimensions {
  const rnd = random((settings.seed + Math.imul(index + 1, 104729)) >>> 0);
  const height = settings.height * (index === 0 ? 1 : .3 + .55 * (1 - index / settings.shards)) * (1 - settings.variation * rnd() * .45);
  const width = height * (.115 + rnd() * .055) * 2 * (settings.width ?? 1);
  const override = settings.crystals?.[String(index)];
  return { height: override?.height ?? height, width: override?.width ?? width };
}

/** Broad translucent-looking painted washes, exported as a real texture, without glass/refraction.
 * Each prism face has its own UV island and face tint; the tiny edge accents stay subordinate. */
function paint(settings: CrystalSettings): THREE.DataTexture {
  const palettes = {
    azure: [[62, 44, 124], [70, 138, 221], [148, 224, 246]],
    violet: [[65, 35, 113], [130, 103, 207], [205, 188, 247]],
    mint: [[29, 71, 110], [55, 163, 173], [161, 236, 218]],
  };
  const colors = palettes[settings.palette], width = 768, height = 128;
  const pixels = new Uint8Array(width * height * 4), rnd = random(settings.seed);
  // Large overlapping pigment clouds, deliberately wider than a facet. No fine
  // bristles, narrow dabs or bright vertical edge lines that read as streaks.
  const paintings = Array.from({ length: 12 }, () => Array.from({ length: 8 }, () => ({
    x: rnd(), y: rnd(), w: .5 + rnd() * .5, h: .18 + rnd() * .25,
    amount: (rnd() - .5) * .20, hue: rnd() - .5,
  })));
  const colour = new THREE.Color();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const tile = Math.floor(x / 64), variant = Math.floor(tile / 3), u = (x % 64) / 63, v = y / (height - 1);
    const t = Math.min(1, v * .88 + .16 * Math.exp(-(((v - .52) / .26) ** 2)));
    const index = t < .55 ? 0 : 1, blend = index === 0 ? t / .55 : (t - .55) / .45;
    let wash = .92, pigment = 0;
    for (const stroke of paintings[tile]) {
      const dx = (u - stroke.x) / stroke.w, dy = (v - stroke.y) / stroke.h;
      const dab = Math.exp(-dx * dx - dy * dy);
      wash += stroke.amount * dab;
      pigment += stroke.hue * dab * .022;
    }
    const edge = 0;
    const rgb = colors[index].map((c, channel) => Math.min(1, (c * (1 - blend) * wash + colors[index + 1][channel] * blend * wash + 255 * edge) / 255));
    colour.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    // Distinct cyan, blue and lilac minerals, plus a gentle hue shift within each painted face.
    colour.offsetHSL((variant - 1.5) * .045 + pigment + .016 * Math.sin(v * Math.PI * 2 + u * 2), -.055, 0);
    colour.convertLinearToSRGB();
    pixels.set([Math.round(colour.r * 255), Math.round(colour.g * 255), Math.round(colour.b * 255), 255], (y * width + x) * 4);
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
  texture.name = `Crystal painted ${settings.palette}`;
  return texture;
}

type ShardGlow = { centre: THREE.Vector3; axis: THREE.Vector3; radius: number; height: number; variant: number };

/** glTF-compatible unlit, alpha-blended crossed veils: visible glow without a global bloom pass.
 * Depth testing keeps the halo behind nearer rocks, and no depth writes obscure other props. */
function crystalHalo(shards: ShardGlow[], settings: CrystalSettings): THREE.Mesh {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  const tint = settings.palette === "azure" ? [101, 173, 242] : settings.palette === "violet" ? [169, 131, 236] : [99, 211, 204];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r2 = ((x / (size - 1) - .5) * 2) ** 2 + ((y / (size - 1) - .5) * 2) ** 2;
    const falloff = Math.max(0, Math.exp(-3.8 * r2) - Math.exp(-3.8)) / (1 - Math.exp(-3.8));
    const at = (y * size + x) * 4;
    pixels.set([255, 255, 255], at); pixels[at + 3] = Math.round(255 * falloff * Math.min(.44, settings.glow * .34));
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
  texture.name = "Crystal diffuse halo";
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [];
  for (const shard of shards) {
    const normal = shard.axis;
    const tangent = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const colour = new THREE.Color().setRGB(tint[0] / 255, tint[1] / 255, tint[2] / 255, THREE.SRGBColorSpace).offsetHSL((shard.variant - 1.5) * .052, 0, 0);
    const width = shard.radius * 5.4, height = shard.height * 1.35;
    for (let i = 0; i < 3; i++) {
      const across = tangent.clone().applyAxisAngle(normal, i * Math.PI / 3);
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
        const p = shard.centre.clone().addScaledVector(across, (u - .5) * width).addScaledVector(normal, (v - .5) * height);
        positions.push(p.x, p.y, p.z); uvs.push(u, v); colors.push(colour.r, colour.g, colour.b);
      }
    }
  }
  const haloGeometry = new THREE.BufferGeometry();
  haloGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  haloGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  haloGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); haloGeometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.name = "Soft crystal aura";
  const mesh = new THREE.Mesh(haloGeometry, material); mesh.name = "Crystal halo";
  return mesh;
}

/** One opaque mesh plus an exportable soft halo per patch. Y-up; every shard is anchored back to the host surface. */
export function generateCrystal(surface: VineSurface, recipe: CrystalRecipe, avoid: VineObstacle[] = []) {
  validateCrystalRecipe(recipe);
  const s = recipe.settings, root = new THREE.Vector3(...recipe.root);
  const normal = new THREE.Vector3(...recipe.normal).normalize();
  const tangent = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent);
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], obstacles: VineObstacle[] = [];
  const glows: ShardGlow[] = [];
  let shardCount = 0;
  for (let i = 0; i < s.shards; i++) {
    const rnd = random((s.seed + Math.imul(i + 1, 7919)) >>> 0);
    const shape = s.shapeVariation ?? .65;
    const angle = i * 2.399963229728653 + rnd() * .5;
    const distance = i === 0 ? 0 : s.radius * Math.sqrt(i / s.shards) * (.8 + rnd() * .2);
    const radial = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
    const sample = root.clone().addScaledVector(radial, distance).addScaledVector(normal, s.radius * .3);
    const hit = surface.nearest(sample, s.radius * .65 + .04);
    if (!hit || hit.normal.dot(normal) < .45) continue;
    const dimensions = crystalDimensions(s, i), h = dimensions.height, radius = dimensions.width / 2;
    const axis = normal.clone().addScaledVector(radial, s.lean * (i === 0 ? .18 : .9)).normalize();
    const base = hit.point.clone().addScaledVector(normal, -.012 * h);
    const centre = base.clone().addScaledVector(axis, h * .48);
    if (avoid.some(o => centre.distanceTo(o.centre) < radius + o.radius)) continue;
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    // Large mineral facets meet at staggered heights along the body. Keep the
    // six-sided outline coherent while breaking up the long, uniform prism faces.
    const habit = shape < .05 ? 0 : (i + s.seed) % 4;
    const sides = 6, phase = rnd() * Math.PI * 2;
    const rings: THREE.Vector3[][] = [[], [], []];
    const shoulder = (habit === 0 ? .76 : habit === 3 ? .84 : .82) + (rnd() - .5) * .05 * shape;
    const squash = 1 - rnd() * .10 * shape;
    const taper = .98 - rnd() * .05 * shape;
    const footprint = Array.from({ length: sides }, (_, j) => {
      const a = phase + j / sides * Math.PI * 2 + (rnd() - .5) * .24 * shape;
      const r = 1 + (rnd() - .5) * .22 * shape;
      return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r * squash);
    });
    const ringHeights: number[][] = [[], [], []];
    const bodyShift = new THREE.Vector2((rnd() - .5) * .36 * shape, (rnd() - .5) * .36 * shape);
    for (let j = 0; j < sides; j++) {
      const point = footprint[j];
      // One broad irregular belt of junctions, rather than repeated horizontal rings.
      const middle = .42 + (rnd() - .5) * .58 * shape;
      const upper = shoulder + (rnd() - .5) * .20 * shape;
      const widths = [.90 - .38 * shape, 1 + .22 * shape + (rnd() - .5) * .66 * shape, taper - rnd() * .40 * shape];
      for (let k = 0; k < 3; k++) {
        const r = radius * widths[k], y = [0, middle, upper][k];
        const shift = k === 1 ? 1 : k === 2 ? -.3 : 0;
        ringHeights[k].push(y);
        rings[k].push(new THREE.Vector3(point.x * r + bodyShift.x * radius * shift, h * y, point.y * r + bodyShift.y * radius * shift).applyQuaternion(rotation).add(base));
      }
    }
    const cap: THREE.Vector3[] = [];
    const capScale = (habit === 1 ? .38 : .48) + (rnd() - .5) * .14 * shape;
    const offsetX = radius * (rnd() - .5) * .48 * shape;
    const offsetZ = radius * (rnd() - .5) * .48 * shape;
    const slope = habit === 2 ? .025 + .025 * shape : .012 * shape;
    for (let j = 0; j < sides; j++) {
      const point = footprint[j];
      cap.push(new THREE.Vector3(point.x * radius * capScale + offsetX, h * (1 - slope + point.x * slope), point.y * radius * capScale + offsetZ).applyQuaternion(rotation).add(base));
    }
    const capCentre = new THREE.Vector3(offsetX, h * (1 - slope), offsetZ).applyQuaternion(rotation).add(base);
    const tip = new THREE.Vector3(radius * (rnd() - .5) * .52 * shape, h, radius * (rnd() - .5) * .52 * shape).applyQuaternion(rotation).add(base);
    // Reject shards which disappear into an overhang above the anchor.
    if ([centre, tip].some(p => { const near = surface.nearest(p, radius * 2); return near && near.signed < -.01; })) continue;
    const paintFace = (i + (s.seed % 4)) % 4;
    let paintSide = 0;
    const tri = (points: THREE.Vector3[], uv: number[], tone: number) => {
      uv = uv.map((v, i) => i % 2 === 0 ? ((paintFace * 3 + paintSide) * 64 + .5 + v * 63) / 768 : v);
      points.forEach(p => positions.push(p.x, p.y, p.z)); uvs.push(...uv);
      for (let n = 0; n < 3; n++) colors.push(tone, tone, tone);
    };
    for (let j = 0; j < sides; j++) {
      paintSide = j % 3;
      const next = (j + 1) % sides, tone = .82 + rnd() * .18;
      for (let k = 0; k < 2; k++) {
        const a = rings[k][j], b = rings[k + 1][j], c = rings[k][next], d = rings[k + 1][next];
        const ya = ringHeights[k][j], yb = ringHeights[k + 1][j], yc = ringHeights[k][next], yd = ringHeights[k + 1][next];
        // Alternate long diagonal cuts; the geometry, not painted lines, defines each facet.
        const facetTone = tone * (1 - shape * .24);
        if ((i + j + k) % 2 === 0) {
          tri([a, b, c], [0, ya, 0, yb, 1, yc], tone);
          tri([c, b, d], [1, yc, 0, yb, 1, yd], facetTone);
        } else {
          tri([a, b, d], [0, ya, 0, yb, 1, yd], facetTone);
          tri([a, d, c], [0, ya, 1, yd, 1, yc], tone);
        }
      }
      if (habit === 0 || habit === 3) {
        tri([rings[2][j], tip, rings[2][next]], [0, ringHeights[2][j], .45, 1, 1, ringHeights[2][next]], Math.min(1, tone + .04));
      } else {
        tri([rings[2][j], cap[j], rings[2][next]], [0, ringHeights[2][j], 0, 1, 1, ringHeights[2][next]], tone);
        tri([rings[2][next], cap[j], cap[next]], [1, ringHeights[2][next], 0, 1, 1, 1], tone);
        // One consistent colour and planar normal across the whole flat cut.
        tri([cap[j], capCentre, cap[next]], [.2, .9, .5, .95, .8, .9], .96);
      }
      tri([base, rings[0][j], rings[0][next]], [.5, 0, 0, 0, 1, 0], tone);
    }
    glows.push({ centre, axis, radius, height: h, variant: paintFace });
    obstacles.push({ centre, radius: h * .5 }); shardCount++;
  }
  const group = new THREE.Group(); group.name = "Painted crystal patch";
  if (shardCount) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const texture = paint(s);
    const material = new THREE.MeshStandardMaterial({ map: texture, vertexColors: true, roughness: .9, metalness: 0,
      emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: s.glow, flatShading: true });
    material.name = "Soft painted crystal glow";
    const mesh = new THREE.Mesh(geometry, material); mesh.name = "Crystal shards"; group.add(mesh);
    if (s.glow > 0) group.add(crystalHalo(glows, s));
  }
  return { group, shardCount, obstacles };
}

export function disposeCrystal(group: THREE.Group): void {
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      (material as THREE.MeshStandardMaterial).map?.dispose(); material.dispose();
    }
  });
}

/** Area-weighted seedable sampling, with full-patch spacing and no fern-specific trial growth. */
export function findCrystalSpots(soup: Float32Array, existing: THREE.Vector3[], count: number, spacing: number, settings: CrystalSettings) {
  const rnd = random(settings.seed), tri = new THREE.Triangle(), areas: number[] = [];
  let total = 0;
  for (let i = 0; i < soup.length; i += 9) {
    tri.a.fromArray(soup, i); tri.b.fromArray(soup, i + 3); tri.c.fromArray(soup, i + 6);
    total += tri.getArea(); areas.push(total);
  }
  const spots: { point: THREE.Vector3; normal: THREE.Vector3 }[] = [];
  if (!total) return spots;
  for (let attempt = 0; attempt < count * 80 && spots.length < count; attempt++) {
    const target = rnd() * total; let lo = 0, hi = areas.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (areas[mid] < target) lo = mid + 1; else hi = mid; }
    const i = lo * 9; tri.a.fromArray(soup, i); tri.b.fromArray(soup, i + 3); tri.c.fromArray(soup, i + 6);
    const normal = tri.getNormal(new THREE.Vector3()); if (normal.y < .2) continue;
    let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const point = tri.a.clone().addScaledVector(tri.b.clone().sub(tri.a), u).addScaledVector(tri.c.clone().sub(tri.a), v);
    if ([...existing, ...spots.map(p => p.point)].some(p => p.distanceTo(point) < Math.max(spacing, settings.radius * 2))) continue;
    spots.push({ point, normal });
  }
  return spots;
}
