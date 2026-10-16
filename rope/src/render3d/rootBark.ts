// Painted woody root bark, generated once and shared by the whole level.
// Grain runs along V (arc length), around U. All fields are periodic, including
// their domain warp, so neither the wrap nor the longitudinal repeat has a seam.
import * as THREE from "three";
import { DEFAULT_ROOT_COLOR } from "../level/levelFormat";
import { loadMaps, rootSurfaceFor, TEXTURE_ASSETS, trackPending } from "./assets";
import { rootBarkVariant, type RootBarkVariant } from "../level/rootAppearance";

const WIDTH = 512, HEIGHT = 1024;
const TAU = Math.PI * 2;
const clamp = (x: number): number => Math.max(0, Math.min(1, x));
function band(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function noise(u: number, v: number, nx: number, ny: number, seed: number): number {
  const x = u * nx, y = v * ny, ix = Math.floor(x), iy = Math.floor(y);
  const sx = band(0, 1, x - ix), sy = band(0, 1, y - iy);
  const at = (a: number, b: number): number => hash((a % nx + nx) % nx, (b % ny + ny) % ny, seed);
  const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

interface BarkMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
}
let maps: BarkMaps | undefined;
const materials = new Map<string, THREE.MeshStandardMaterial>();
const paintedMaps = new Map<RootBarkVariant, Promise<{ map: THREE.Texture; normalMap: THREE.DataTexture } | undefined>>();

export function rootBarkMaterial(color: string, bark?: RootBarkVariant): THREE.MeshStandardMaterial {
  const variant = rootBarkVariant(bark), key = `${variant}:${color}`;
  const cached = materials.get(key);
  if (cached) return cached;
  maps ??= buildMaps();
  // The maps already contain the default bark palette. Apply only the change
  // from that colour, rather than multiplying brown over brown into black.
  const reference = new THREE.Color(DEFAULT_ROOT_COLOR);
  const tint = new THREE.Color(color);
  tint.setRGB(tint.r / reference.r, tint.g / reference.g, tint.b / reference.b);
  const material = new THREE.MeshStandardMaterial({
    name: `painted-root-bark-${variant}`, color: tint, vertexColors: true,
    ...maps, normalScale: new THREE.Vector2(0.72, 0.72), roughness: 1, metalness: 0,
  });
  // Thin growing ends have finer, smoother skin than established woody roots.
  // This is surface shading only: all shadow passes use the same actual mesh.
  material.customProgramCacheKey = () => "painted-root-bark-v3";
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float rootAge;\nattribute float rootJoin;\nvarying float vRootAge;\nvarying float vRootJoin;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRootAge = rootAge;\nvRootJoin = rootJoin;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vRootAge;\nvarying float vRootJoin;")
      .replace("#include <map_fragment>", `
        #include <map_fragment>
        // Low-contrast young skin; mature bark keeps the painted fissures.
        vec3 youngBark = vec3(0.28, 0.164, 0.084) * diffuse;
        diffuseColor.rgb = mix(youngBark, diffuseColor.rgb, mix(0.38, 1.0, vRootAge));
      `)
      .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps
        .replace("mapN.xy *= normalScale;", "mapN.xy *= normalScale * mix(0.22, 1.0, vRootAge) * mix(1.0, 0.45, vRootJoin);"))
      .replace("#include <roughnessmap_fragment>", `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(0.82, roughnessFactor, vRootAge);
      `);
  };
  materials.set(key, material);
  if (typeof document !== "undefined") {
    let pending = paintedMaps.get(variant);
    if (!pending) { pending = loadPaintedMaps(variant); paintedMaps.set(variant, pending); }
    void trackPending(pending.then(painted => {
      if (!painted) return;
      material.map = painted.map;
      material.normalMap = painted.normalMap;
      material.normalScale.setScalar(variant === "original" ? 0.85 : 0.45);
      // Quiet matte paint: the detailed fallback's roughness grain would add
      // unrelated fine marks back over the broad, irregular painted plates.
      if (variant !== "original") {
        material.roughnessMap = null;
        material.roughness = 0.91;
      }
      // The reference's light paint is brought into the game's earthy range;
      // actual lighting and the author's relative tint still shape the result.
      material.color.multiplyScalar(0.58);
      material.needsUpdate = true;
    }), "painted root bark");
  }
  return material;
}

async function loadPaintedMaps(variant: RootBarkVariant): Promise<{ map: THREE.Texture; normalMap: THREE.DataTexture } | undefined> {
  const surface = rootSurfaceFor(variant);
  const loaded = await loadMaps(surface, TEXTURE_ASSETS[surface]!);
  if (!loaded.base) return undefined;
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.drawImage(loaded.base.image as CanvasImageSource, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const height = (x: number, y: number): number => {
    const at = (((y + size) % size) * size + (x + size) % size) * 4;
    return (pixels[at]! * 0.3 + pixels[at + 1]! * 0.6 + pixels[at + 2]! * 0.1) / 255;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Two scales: broad raised plates and the smaller dry-brush ridges.
    const dx = (height(x + 3, y) - height(x - 3, y)) * 3.5 + (height(x + 1, y) - height(x - 1, y)) * 1.5;
    const dy = (height(x, y + 3) - height(x, y - 3)) * 3.5 + (height(x, y + 1) - height(x, y - 1)) * 1.5;
    const length = Math.hypot(dx, dy, 1), at = (y * size + x) * 4;
    data[at] = Math.round(127.5 * (1 - dx / length));
    data[at + 1] = Math.round(127.5 * (1 + dy / length));
    data[at + 2] = Math.round(127.5 * (1 + 1 / length));
    data[at + 3] = 255;
  }
  const normalMap = new THREE.DataTexture(data, size, size);
  normalMap.flipY = true;
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.generateMipmaps = true;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.magFilter = THREE.LinearFilter;
  normalMap.anisotropy = 4;
  normalMap.needsUpdate = true;
  return { map: loaded.base, normalMap };
}

function buildMaps(): BarkMaps {
  const heights = new Float32Array(WIDTH * HEIGHT);
  const albedo = new Uint8Array(WIDTH * HEIGHT * 4);
  const normals = new Uint8Array(albedo.length);
  const roughness = new Uint8Array(albedo.length);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const u = x / WIDTH, v = y / HEIGHT;
    // Long fibres bend around broad grain islands. No regular crosswise bands
    // or spiral stripes: those read as a rope or a vine wrapped round a stick.
    const warp = (noise(u, v, 4, 3, 2) - 0.5) * 0.13
      + Math.sin(v * TAU) * 0.014;
    const w = u + warp;
    const plate = noise(w, v, 11, 5, 4);
    const stroke = noise(w, v, 29, 9, 5);
    const fibres = noise(w, v, 73, 13, 9);
    const wash = noise(u, v, 4, 4, 13);
    const dry = band(0.40, 0.72, stroke) * band(0.28, 0.60, plate);
    // Sparse, broken longitudinal fissures, with a warm exposed edge beside
    // them; broad pigment shapes remain readable after mipmapping at play size.
    const channel = noise(w, v, 17, 3, 7);
    const crack = (1 - band(0.20, 0.36, channel)) * band(0.15, 0.38, noise(w, v, 11, 5, 8));
    const lip = band(0.20, 0.32, channel) * (1 - band(0.32, 0.44, channel)) * 0.30;
    const split = (1 - band(0.20, 0.30, noise(w, v, 53, 7, 31))) * band(0.20, 0.50, plate);
    const grain = (fibres - 0.5) * 0.045;
    const height = 0.46 + (plate - 0.5) * 0.22 + dry * 0.055 - crack * 0.14 - split * 0.07 + lip * 0.055 + grain;
    heights[y * WIDTH + x] = height;
    // Umber crevices, clay midtones, desaturated taupe dry-brush. Deliberately
    // coloured paint rather than a grayscale bump multiplied by flat brown.
    const tone = clamp(0.43 + (plate - 0.5) * 0.32 + (wash - 0.5) * 0.18 + dry * 0.18 - crack * 0.21 - split * 0.12 + lip * 0.10);
    const cool = band(0.40, 0.70, wash) * 0.34;
    const i = (y * WIDTH + x) * 4;
    albedo[i] = Math.round(57 + 106 * tone - cool * 12 + grain * 105);
    albedo[i + 1] = Math.round(41 + 94 * tone + cool * 8 + grain * 90);
    albedo[i + 2] = Math.round(31 + 79 * tone + cool * 16 + grain * 70);
    albedo[i + 3] = 255;
    const rough = Math.round(255 * clamp(0.88 + crack * 0.09 - dry * 0.055));
    roughness[i] = roughness[i + 1] = roughness[i + 2] = rough;
    roughness[i + 3] = 255;
  }
  const at = (x: number, y: number): number => heights[((y + HEIGHT) % HEIGHT) * WIDTH + (x + WIDTH) % WIDTH]!;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 3.4;
    const dy = (at(x, y + 1) - at(x, y - 1)) * 3.4;
    const length = Math.hypot(dx, dy, 1), i = (y * WIDTH + x) * 4;
    normals[i] = Math.round(255 * (0.5 - dx * 0.5 / length));
    normals[i + 1] = Math.round(255 * (0.5 - dy * 0.5 / length));
    normals[i + 2] = Math.round(255 * (0.5 + 0.5 / length));
    normals[i + 3] = 255;
  }
  const texture = (data: Uint8Array, color = false): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: texture(albedo, true), normalMap: texture(normals), roughnessMap: texture(roughness) };
}
