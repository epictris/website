// ROCK DEBUG VIEWS AND PICKING (`?rockdebug=<view>`, docs/rocks.md
// "Diagnosing"). Each view swaps every mounted rock body's material for one
// that shows ONE thing, in colours nothing else in the scene uses, so a
// screenshot of it is evidence without interpretation:
//
//   backfaces   the rock as it is, front faces only, and every BACK face in
//               flat magenta: any magenta pixel is a hole or an inside-out face
//   shards      a flat hue per _SHARD id under a fixed hemisphere light
//   provenance  a flat colour per _PROVENANCE step, with a legend
//   ao          the AO atlas alone, grey, unlit
//   normals     the world normal as a colour
//   wire        the rock as it is with its triangles drawn over it
//
// The views carry no lighting, fog, tone mapping or paint, on purpose. A view
// is a material on the mesh (the original is kept on the mesh's userData and
// put back) or an overlay mesh sharing the geometry; the only change to the
// rock material itself is `backfaces`/`wire` drawing it front faces only, and
// that is put back too, so turning a view off is the whole of its teardown.
//
// With a view on, `pickRock` answers what is under a point: body, shard,
// provenance, triangle, where, which way it faces and the AO it reads - the
// line `cli rocks-check --face` and the stage dumps take up.

import * as THREE from "three";
import { ROCK_INDEX_KEY } from "./rocks";

export const ROCK_DEBUG_VIEWS = ["backfaces", "shards", "provenance", "ao", "normals", "wire"] as const;
export type RockDebugView = (typeof ROCK_DEBUG_VIEWS)[number];

export function parseRockDebug(raw: string | null): RockDebugView | null {
  if (raw === null) return null;
  if ((ROCK_DEBUG_VIEWS as readonly string[]).includes(raw)) return raw as RockDebugView;
  console.error(`rockdebug=${raw} is not one of ${ROCK_DEBUG_VIEWS.join(", ")}; off`);
  return null;
}

// rocks.py's PROV_* values, their names and the view's colours (sRGB, written
// straight to the framebuffer).
export const PROVENANCE: Record<number, { name: string; color: string }> = {
  1: { name: "template", color: "#8a8a8a" },
  2: { name: "float clip", color: "#2f6fff" },
  3: { name: "exact clip", color: "#ff8c1a" },
  4: { name: "hole fill", color: "#ff2020" },
  5: { name: "backing", color: "#20c040" },
  6: { name: "rim inset", color: "#f0e020" },
  7: { name: "planar dissolve", color: "#a040ff" },
};
const MAGENTA = 0xff00ff;

const ORIGINAL = "rockDebugOriginal";
const SIDE = "rockDebugSide";
const OVERLAY = "rockDebugOverlay";

// A float per vertex, as the view shaders read it. The exporter writes _SHARD
// and _PROVENANCE as float accessors already; a missing one reads 0, which
// the provenance legend has no colour for (black) and the shard view hashes
// like any other id.
function ensureAttribute(geometry: THREE.BufferGeometry, name: string): void {
  if (geometry.getAttribute(name)) return;
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n), 1));
}

const VERT = /* glsl */ `
  attribute float _shard;
  attribute float _provenance;
  varying float vShard;
  varying float vProvenance;
  varying vec3 vNormal;
  varying vec2 vUv1;
  #ifdef HAS_UV1
  attribute vec2 uv1;
  #endif
  void main() {
    vShard = _shard;
    vProvenance = _provenance;
    vNormal = normalize(mat3(modelMatrix) * normal);
    #ifdef HAS_UV1
    vUv1 = uv1;
    #else
    vUv1 = vec2(0.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The fixed hemisphere the shard view is lit by: enough to tell a top from a
// side, nothing that varies over the scene.
const HEMI = /* glsl */ `
  float hemi(vec3 n) { return 0.55 + 0.45 * (0.5 + 0.5 * n.y) * (0.6 + 0.4 * n.z); }
`;

const FRAG: Record<Exclude<RockDebugView, "backfaces" | "wire">, string> = {
  shards: /* glsl */ `
    varying float vShard;
    varying vec3 vNormal;
    ${HEMI}
    vec3 hue(float h) {
      return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    }
    void main() {
      float id = floor(vShard + 0.5);
      // Golden-ratio hues: neighbouring ids land far apart on the wheel.
      vec3 c = mix(vec3(1.0), hue(fract(id * 0.61803398875)), 0.8);
      gl_FragColor = vec4(c * hemi(normalize(vNormal)), 1.0);
    }
  `,
  provenance: /* glsl */ `
    varying float vProvenance;
    uniform vec3 palette[8];
    void main() {
      int p = int(floor(vProvenance + 0.5));
      vec3 c = vec3(0.0);
      for (int i = 0; i < 8; i++) if (i == p) c = palette[i];
      gl_FragColor = vec4(c, 1.0);
    }
  `,
  ao: /* glsl */ `
    varying vec2 vUv1;
    uniform sampler2D aoMap;
    uniform float hasAo;
    void main() {
      float ao = hasAo > 0.5 ? texture2D(aoMap, vUv1).r : 1.0;
      gl_FragColor = vec4(vec3(ao), 1.0);
    }
  `,
  normals: /* glsl */ `
    varying vec3 vNormal;
    void main() { gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0); }
  `,
};

function viewMaterial(view: keyof typeof FRAG, mesh: THREE.Mesh, original: THREE.Material): THREE.ShaderMaterial {
  const aoMap = (original as THREE.MeshStandardMaterial).aoMap ?? null;
  const hasUv1 = mesh.geometry.getAttribute("uv1") !== undefined;
  // The colours go to the framebuffer as written (no colour-space chunk), so
  // they are handed over as their sRGB components rather than linearised.
  const palette = Array.from({ length: 8 }, (_, i) => new THREE.Color().setStyle(PROVENANCE[i]?.color ?? "#000000", THREE.NoColorSpace));
  return new THREE.ShaderMaterial({
    name: `rock-debug-${view}`,
    vertexShader: VERT,
    fragmentShader: FRAG[view],
    defines: hasUv1 ? { HAS_UV1: "" } : {},
    uniforms: {
      palette: { value: palette },
      aoMap: { value: aoMap },
      hasAo: { value: aoMap ? 1 : 0 },
    },
    side: THREE.FrontSide,
    fog: false,
    lights: false,
  });
}

// Put every mesh under `group` into `view`, or back to its own material with
// null. Idempotent, and safe to call on a group already in another view.
export function setRockDebug(group: THREE.Object3D, view: RockDebugView | null): void {
  const meshes: THREE.Mesh[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.userData[OVERLAY] !== true) meshes.push(mesh);
  });
  for (const mesh of meshes) {
    // Back to plain first.
    for (const child of [...mesh.children]) {
      if (child.userData[OVERLAY] === true) {
        mesh.remove(child);
        ((child as THREE.Mesh).material as THREE.Material).dispose();
      }
    }
    const original = mesh.userData[ORIGINAL] as THREE.Material | undefined;
    if (original) {
      if (mesh.material !== original) (mesh.material as THREE.Material).dispose();
      mesh.material = original;
      delete mesh.userData[ORIGINAL];
    }
    const base = mesh.material as THREE.Material;
    const side = base.userData[SIDE] as THREE.Side | undefined;
    if (side !== undefined) {
      base.side = side;
      base.needsUpdate = true;
      delete base.userData[SIDE];
    }
    if (view === null) continue;
    mesh.userData[ORIGINAL] = base;
    ensureAttribute(mesh.geometry, "_shard");
    ensureAttribute(mesh.geometry, "_provenance");
    if (view === "backfaces" || view === "wire") {
      // The rock's own look, front faces only (the GLB's material is double
      // sided, so a hole would otherwise show the far wall's inside in rock
      // colours), with an overlay sharing the geometry. The material is the
      // body's shared one with its side flipped (and put back above): a clone
      // would lose the rock patch, which `Material.copy` does not carry.
      if (base.side !== THREE.FrontSide) {
        base.userData[SIDE] = base.side;
        base.side = THREE.FrontSide;
        base.needsUpdate = true;
      }
      const overlay = new THREE.Mesh(
        mesh.geometry,
        view === "backfaces"
          ? new THREE.MeshBasicMaterial({ color: MAGENTA, side: THREE.BackSide, fog: false, toneMapped: false })
          : new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, fog: false, toneMapped: false, transparent: true, opacity: 0.6 }),
      );
      overlay.userData[OVERLAY] = true;
      overlay.renderOrder = 1;
      mesh.add(overlay);
    } else {
      mesh.material = viewMaterial(view, mesh, base);
    }
  }
}

// The legend the provenance view needs, as a DOM overlay over the frame (the
// game's 2D canvas is redrawn every frame; a legend there would have to be
// drawn by every renderer). Removed when the view changes.
let legend: HTMLElement | null = null;
export function showRockDebugLegend(view: RockDebugView | null): void {
  legend?.remove();
  legend = null;
  if (view === null || typeof document === "undefined") return;
  const el = document.createElement("div");
  el.id = "rock-debug-legend";
  el.style.cssText =
    "position:fixed;left:8px;top:8px;z-index:50;padding:6px 8px;background:rgba(0,0,0,0.75);color:#fff;pointer-events:none;line-height:1.5";
  const title = document.createElement("div");
  title.textContent = `rockdebug=${view}`;
  el.append(title);
  if (view === "provenance") {
    for (const [value, p] of Object.entries(PROVENANCE)) {
      const row = document.createElement("div");
      const swatch = document.createElement("span");
      swatch.style.cssText = `display:inline-block;width:1em;height:1em;margin-right:6px;vertical-align:middle;background:${p.color}`;
      row.append(swatch, `${value} ${p.name}`);
      el.append(row);
    }
  }
  if (view === "backfaces") {
    const row = document.createElement("div");
    row.textContent = "magenta = a back face on screen";
    el.append(row);
  }
  document.body.append(el);
  legend = el;
}

export interface RockPick {
  body: number;
  shard: number;
  provenance: number;
  face: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  ao: number | null;
  // True when the ray met the back of the face: looking into a hole.
  back: boolean;
}

// The AO texel under a uv1, read from the texture's image through a canvas
// kept per image. glTF textures are not flipped, so uv (0, 0) is the image's
// top-left.
const aoPixels = new WeakMap<object, { data: Uint8ClampedArray; width: number; height: number }>();
function sampleAo(texture: THREE.Texture | null, uv: THREE.Vector2 | undefined): number | null {
  const image = texture?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image || !uv || typeof document === "undefined") return null;
  let px = aoPixels.get(image);
  if (!px) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    px = { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    aoPixels.set(image, px);
  }
  const x = Math.min(px.width - 1, Math.max(0, Math.floor(uv.x * px.width)));
  const y = Math.min(px.height - 1, Math.max(0, Math.floor(uv.y * px.height)));
  return px.data[(y * px.width + x) * 4]! / 255;
}

// The nearest rock face along a ray already set on `raycaster`.
// A hit on the backfaces view's magenta overlay is a hit on the back of the
// rock's own face (it shares the geometry, and the rock is drawn front faces
// only there), so it is reported as the rock's, marked as a back face.
export function pickRock(raycaster: THREE.Raycaster, group: THREE.Object3D): RockPick | null {
  const hit = raycaster.intersectObject(group, true).find((h) => {
    const m = (h.object as THREE.Mesh).material as THREE.MeshBasicMaterial;
    return h.object.userData[OVERLAY] !== true || m.wireframe !== true;
  });
  if (!hit || !hit.face || hit.faceIndex == null) return null;
  const onOverlay = hit.object.userData[OVERLAY] === true;
  const mesh = (onOverlay ? hit.object.parent : hit.object) as THREE.Mesh;
  let body = -1;
  for (let o: THREE.Object3D | null = mesh; o; o = o.parent) {
    const index = o.userData[ROCK_INDEX_KEY] as unknown;
    if (typeof index === "number") {
      body = index;
      break;
    }
  }
  const read = (name: string): number => {
    const attr = mesh.geometry.getAttribute(name);
    return attr ? attr.getX(hit.face!.a) : -1;
  };
  const material = (mesh.userData[ORIGINAL] ?? mesh.material) as THREE.MeshStandardMaterial;
  const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
  return {
    body,
    shard: read("_shard"),
    provenance: read("_provenance"),
    face: hit.faceIndex,
    point: hit.point.clone(),
    normal,
    ao: sampleAo(material.aoMap ?? null, (hit as { uv1?: THREE.Vector2 }).uv1),
    back: onOverlay || normal.dot(raycaster.ray.direction) > 0,
  };
}

// The pick as the one line the docs and `cli shot --pick` expect. Three's
// frame (x right, y up, z toward the camera) and the sim point `cli shot --at`
// takes.
export function pickLine(p: RockPick): string {
  const f = (v: number): string => v.toFixed(3);
  const prov = PROVENANCE[p.provenance]?.name ?? (p.provenance < 0 ? "no attribute" : `value ${p.provenance}`);
  return (
    `[rocks] pick body ${p.body} shard ${p.shard} provenance ${p.provenance} (${prov}) face ${p.face}` +
    ` at (${f(p.point.x)}, ${f(p.point.y)}, ${f(p.point.z)}) normal (${f(p.normal.x)}, ${f(p.normal.y)}, ${f(p.normal.z)})` +
    ` ao ${p.ao === null ? "-" : p.ao.toFixed(2)}${p.back ? " BACK FACE" : ""}` +
    ` - sim --at ${f(p.point.x)},${f(-p.point.y)}; cli rocks-check <file> --face ${p.body}:${p.face}`
  );
}
