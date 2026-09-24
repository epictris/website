// ROCK FILE CHECKS (bun half of `cli rocks-check`, and what `bun run
// assets:rocks` runs on its own output): read a generated rock GLB as bytes and
// say, per body, whether it is what the runtime material and the staleness
// check assume - without starting Blender. The geometric half (back faces,
// coincident faces, dark caps) is `tools/blender/check.py`; the build's own
// counts are the `<level>.rocks.json` report `rocks.py` writes beside the file.
// See docs/rocks.md, "Diagnosing".
//
// Every check here was a failure that shipped once: TEXCOORD_0 collapsed to
// 0..1 when the level build's unwrap ran over the previous body, the AO atlas
// 2 % covered, masks raised to 2.2 by a byte colour layer, a body left on its
// extrusion by a stale hash nobody noticed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIXELS_PER_METER } from "../engine/units";
import { scaleLevelData, type RawLevelData } from "../level/levelFormat";
import { rockBodies, rockFileId } from "../render3d/rocks";

// ---------------------------------------------------------------------------
// GLB reading: the JSON chunk, the BIN chunk and typed accessors.

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  normalized?: boolean;
  type: string;
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}
export interface Gltf {
  asset: unknown;
  scene?: number;
  scenes?: { name?: string; nodes?: number[]; extras?: Record<string, unknown> }[];
  nodes: { name?: string; mesh?: number; extras?: Record<string, unknown>; children?: number[] }[];
  meshes: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: { name?: string; occlusionTexture?: { index: number; texCoord?: number } }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { bufferView?: number; name?: string }[];
  accessors: GltfAccessor[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

export interface Glb {
  json: Gltf;
  bin: Uint8Array;
  bytes: number;
  id: string;
}

export function readGlb(path: string): Glb {
  const bytes = new Uint8Array(readFileSync(path));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  let at = 12;
  let json: Gltf | null = null;
  let bin = new Uint8Array(0);
  while (at < bytes.byteLength) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as Gltf;
    else if (type === 0x004e4942) bin = body;
    at += 8 + len;
  }
  if (!json) throw new Error(`${path}: GLB without a JSON chunk`);
  return { json, bin, bytes: bytes.byteLength, id: rockFileId(bytes) };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

// An accessor as floats, `normalized` integers mapped to 0..1 (or -1..1) as a
// shader would read them.
export function readAccessor(glb: Glb, index: number): { data: Float64Array; size: number; count: number } {
  const acc = glb.json.accessors[index]!;
  const size = COMPONENTS[acc.type] ?? 1;
  const data = new Float64Array(acc.count * size);
  if (acc.bufferView === undefined) return { data, size, count: acc.count };
  const view = glb.json.bufferViews[acc.bufferView]!;
  const width = COMPONENT_BYTES[acc.componentType]!;
  const stride = view.byteStride ?? width * size;
  const base = glb.bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(glb.bin.buffer);
  const norm = acc.normalized === true;
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < size; k++) {
      const p = base + i * stride + k * width;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(p, true); break;
        case 5125: v = dv.getUint32(p, true); break;
        case 5123: v = dv.getUint16(p, true); if (norm) v /= 65535; break;
        case 5122: v = dv.getInt16(p, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5121: v = dv.getUint8(p); if (norm) v /= 255; break;
        default: v = dv.getInt8(p); if (norm) v = Math.max(v / 127, -1);
      }
      data[i * size + k] = v;
    }
  }
  return { data, size, count: acc.count };
}

function accessorBytes(glb: Glb, index: number): number {
  const acc = glb.json.accessors[index]!;
  return acc.count * (COMPONENTS[acc.type] ?? 1) * (COMPONENT_BYTES[acc.componentType] ?? 4);
}

// ---------------------------------------------------------------------------
// The file checks.

export interface RockBodyCheck {
  node: string;
  index: number;
  tris: number;
  bytes: number;
  attributes: string[];
  // "ok", "STALE", or "unchecked" when the file names no level on disk.
  hash: string;
  defects: string[];
  warnings: string[];
  lines: string[];
}

export interface RockFileCheck {
  path: string;
  bytes: number;
  id: string;
  level: string;
  flags: Record<string, unknown> | null;
  bodies: RockBodyCheck[];
  // Anything a body cannot carry: a level that does not load, no bodies.
  defects: string[];
}

const REQUIRED = ["POSITION", "NORMAL", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"];
// Soft budgets per body, printed as warnings, never failures.
export const BODY_TRIS_BUDGET = 60_000;
export const BODY_BYTES_BUDGET = 4 * 1024 * 1024;

// The level's current rock hashes by body index, or null when the level is not
// on disk (a `--out` file, a renamed level).
function levelHashes(root: string, level: string): Map<number, string> | null {
  const path = join(root, "levels", `${level}.json`);
  if (level === "" || !existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawLevelData;
  const data = scaleLevelData(raw, 1 / PIXELS_PER_METER);
  return new Map(rockBodies(data).map((b) => [b.index, b.hash]));
}

export function checkRockFile(path: string, root: string, only?: Set<number>): RockFileCheck {
  const glb = readGlb(path);
  const g = glb.json;
  const extras = g.scenes?.[g.scene ?? 0]?.extras ?? {};
  const level = typeof extras["rockLevel"] === "string" ? extras["rockLevel"] : "";
  const flags = typeof extras["rockFlags"] === "string" ? (JSON.parse(extras["rockFlags"]) as Record<string, unknown>) : null;
  const out: RockFileCheck = { path, bytes: glb.bytes, id: glb.id, level, flags, bodies: [], defects: [] };
  const hashes = levelHashes(root, level);
  const flat = flags?.["flat"] === true;

  for (const node of g.nodes) {
    const index = node.extras?.["rockIndex"];
    if (node.mesh === undefined || !/^body-\d+$/.test(node.name ?? "")) continue;
    const body: RockBodyCheck = {
      node: node.name!,
      index: typeof index === "number" ? index : -1,
      tris: 0,
      bytes: 0,
      attributes: [],
      hash: "unchecked",
      defects: [],
      warnings: [],
      lines: [],
    };
    if (only && !only.has(body.index)) continue;
    out.bodies.push(body);
    const hash = node.extras?.["rockHash"];
    if (typeof index !== "number") body.defects.push("no rockIndex extra");
    if (typeof hash !== "string") body.defects.push("no rockHash extra");
    if (hashes && typeof hash === "string") {
      const now = hashes.get(body.index);
      body.hash = now === undefined ? "STALE (no such rock body now)" : now === hash ? "ok" : `STALE (built ${hash}, level now ${now})`;
    }

    const images = new Set<number>();
    for (const prim of g.meshes[node.mesh]!.primitives) {
      const attrs = Object.keys(prim.attributes).sort();
      body.attributes = [...new Set([...body.attributes, ...attrs])];
      for (const a of REQUIRED) {
        if (a === "TEXCOORD_1" && flat) continue;
        if (!(a in prim.attributes)) body.defects.push(`no ${a}`);
      }
      for (const a of Object.values(prim.attributes)) body.bytes += accessorBytes(glb, a);
      if (prim.indices !== undefined) {
        body.bytes += accessorBytes(glb, prim.indices);
        body.tris += g.accessors[prim.indices]!.count / 3;
      }
      const mat = prim.material !== undefined ? g.materials?.[prim.material] : undefined;
      const occ = mat?.occlusionTexture;
      if (!flat) {
        if (!occ) body.defects.push("material has no occlusionTexture");
        else if ((occ.texCoord ?? 0) !== 1) body.defects.push(`occlusionTexture on texCoord ${occ.texCoord ?? 0}, not 1`);
      }
      if (occ) {
        const tex = g.textures?.[occ.index];
        const src = tex?.source ?? tex?.extensions?.["EXT_texture_webp"]?.source;
        if (src !== undefined) images.add(src);
      }

      // TEXCOORD_0 is world metres: a body spans more than one unit of it.
      if ("TEXCOORD_0" in prim.attributes) {
        const { data } = readAccessor(glb, prim.attributes["TEXCOORD_0"]!);
        const span = Math.max(spanOf(data, 2, 0), spanOf(data, 2, 1));
        body.lines.push(`uv0 span ${span.toFixed(2)} m`);
        if (span <= 1) body.defects.push(`TEXCOORD_0 spans ${span.toFixed(3)}: collapsed to one tile (not world metres)`);
      }
      // TEXCOORD_1 is the AO atlas: inside 0..1.
      if ("TEXCOORD_1" in prim.attributes) {
        const { data } = readAccessor(glb, prim.attributes["TEXCOORD_1"]!);
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of data) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        body.lines.push(`uv1 ${lo.toFixed(3)}..${hi.toFixed(3)}`);
        if (lo < -1e-3 || hi > 1 + 1e-3) body.defects.push(`TEXCOORD_1 leaves 0..1 (${lo.toFixed(3)}..${hi.toFixed(3)})`);
      }
      // COLOR_0 is masks: r is cavity, 1 on open surface, so values near 1
      // exist and values near 0 do not dominate.
      if ("COLOR_0" in prim.attributes) {
        const { data, size, count } = readAccessor(glb, prim.attributes["COLOR_0"]!);
        let open = 0;
        let deep = 0;
        for (let i = 0; i < count; i++) {
          const r = data[i * size]!;
          if (r > 0.9) open++;
          if (r < 0.1) deep++;
        }
        body.lines.push(`cavity open ${pct(open, count)}, deep ${pct(deep, count)}`);
        if (open === 0) body.defects.push("COLOR_0.r never near 1: the cavity mask has no open surface");
        if (deep > count / 2) body.defects.push(`COLOR_0.r near 0 on ${pct(deep, count)} of vertices: masks read as colour?`);
      }
    }
    for (const i of images) {
      const bv = g.images?.[i]?.bufferView;
      if (bv !== undefined) body.bytes += g.bufferViews[bv]!.byteLength;
    }
    if (body.tris > BODY_TRIS_BUDGET) body.warnings.push(`${body.tris} tris over the ${BODY_TRIS_BUDGET} budget`);
    if (body.bytes > BODY_BYTES_BUDGET) body.warnings.push(`${mb(body.bytes)} over the ${mb(BODY_BYTES_BUDGET)} budget`);
  }
  if (out.bodies.length === 0) out.defects.push(only ? `no body ${[...only].join(",")} in the file` : "no body-<i> nodes");
  return out;
}

function spanOf(data: Float64Array, size: number, k: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = k; i < data.length; i += size) {
    lo = Math.min(lo, data[i]!);
    hi = Math.max(hi, data[i]!);
  }
  return hi - lo;
}

const pct = (n: number, of: number): string => `${of === 0 ? 0 : Math.round((100 * n) / of)}%`;
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;

export function printRockFileCheck(c: RockFileCheck): void {
  console.log(`[rocks-check] ${c.path}: ${c.bytes} bytes, id ${c.id}, level ${c.level || "(unnamed)"}`);
  if (c.flags) console.log(`[rocks-check] built with ${JSON.stringify(c.flags)}`);
  for (const b of c.bodies) {
    const verdict = b.defects.length > 0 ? "DEFECT" : "ok";
    console.log(
      `  ${b.node}: ${verdict}, ${b.tris} tris, ${mb(b.bytes)}, hash ${b.hash}, ${b.lines.join(", ")}`,
    );
    console.log(`    attributes ${b.attributes.join(" ")}`);
    for (const d of b.defects) console.log(`    DEFECT ${d}`);
    for (const w of b.warnings) console.log(`    warning ${w}`);
  }
  for (const d of c.defects) console.log(`  DEFECT ${d}`);
}

export function rockFileDefects(c: RockFileCheck): number {
  return c.defects.length + c.bodies.reduce((n, b) => n + b.defects.length, 0);
}

// ---------------------------------------------------------------------------
// The build report (`<level>.rocks.json`, written by rocks.py).

export interface PieceReport {
  piece: string;
  shards: number;
  ids: [number, number];
  clipped: number;
  slivers: number;
  exact: number;
  filled: number;
  rejected: number;
  dropped: number;
  rewound: number;
  open: number;
  openIds: number[];
  buried: number;
}
export interface BodyReport {
  index: number;
  hash: string;
  seed: number;
  pieces: PieceReport[];
  culled: number;
  faces?: number;
  tris?: number;
  aoSize?: number;
  aoCoverage?: number;
  aoMean?: number;
  seconds?: number;
}
export interface BuildReport {
  level: string;
  scale: number;
  flat: boolean;
  decimate: number | null;
  remesh: boolean;
  flags: Record<string, unknown>;
  bodies: BodyReport[];
}

export function reportPathOf(glb: string): string {
  return glb.replace(/\.glb$/, "") + ".rocks.json";
}

export function readBuildReport(glb: string): BuildReport | null {
  const path = reportPathOf(glb);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BuildReport) : null;
}

// One row per body: what the build did to its shards. A chunk still `open`
// after repair is a hole in the rock and fails the build.
export function printBuildReport(r: BuildReport, only?: Set<number>): number {
  const flags = Object.entries(r.flags).filter(([k, v]) => v !== false && v !== null && !(k === "debugAttributes" && v === true));
  console.log(
    `[rocks] build report: scale ${r.scale}${r.flat ? ", flat" : ""}${r.remesh ? ", remesh" : ""}` +
      `${r.decimate != null ? `, decimate ${r.decimate}` : ""}${flags.length ? `, ${flags.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}` : ""}`,
  );
  console.log("  body   shards clipped slivers exact filled reject drop rewound OPEN   buried  culled   faces    tris   AO");
  let open = 0;
  for (const b of r.bodies) {
    if (only && !only.has(b.index)) continue;
    const sum = (k: keyof PieceReport): number => b.pieces.reduce((n, p) => n + (p[k] as number), 0);
    open += sum("open");
    const ao = b.aoSize ? `${b.aoSize}px ${Math.round((b.aoCoverage ?? 0) * 100)}%` : "-";
    console.log(
      `  ${String(b.index).padStart(4)} ${[sum("shards"), sum("clipped"), sum("slivers"), sum("exact"), sum("filled"), sum("rejected"), sum("dropped"), sum("rewound"), sum("open")]
        .map((n, i) => String(n).padStart([8, 8, 8, 6, 7, 7, 5, 8, 5][i]!))
        .join("")} ${String(sum("buried")).padStart(8)} ${String(b.culled).padStart(7)} ${String(b.faces ?? "-").padStart(7)} ${String(b.tris ?? "-").padStart(7)}   ${ao}`,
    );
    for (const p of b.pieces) {
      if (p.open > 0) console.log(`         ${p.piece}: OPEN shards ${p.openIds.join(", ")} (ids ${p.ids[0]}..${p.ids[1] - 1}, backing ${p.ids[1]})`);
    }
  }
  return open;
}

// ---------------------------------------------------------------------------
// Stage dumps (`--dump-stages`): one shard's story through the build.

// Per stage node of a dump GLB: the triangles whose _SHARD is `shard`, whether
// they close (every edge on two triangles, vertices welded by position since
// the exporter splits them), and their bounding box.
export function shardStages(path: string, shard: number): string[] {
  const glb = readGlb(path);
  const g = glb.json;
  const lines: string[] = [];
  // In the order the build ran them, not the order the exporter wrote them.
  const rank = (n: { name?: string }): number => {
    const i = STAGE_ORDER.indexOf((n.name ?? "").split("-body-")[0]!);
    return i < 0 ? STAGE_ORDER.length : i;
  };
  for (const node of [...g.nodes].sort((a, b) => rank(a) - rank(b))) {
    if (node.mesh === undefined) continue;
    let tris = 0;
    const edges = new Map<string, number>();
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const provs = new Map<number, number>();
    for (const prim of g.meshes[node.mesh]!.primitives) {
      if (prim.attributes["_SHARD"] === undefined || prim.indices === undefined) continue;
      const pos = readAccessor(glb, prim.attributes["POSITION"]!).data;
      const sid = readAccessor(glb, prim.attributes["_SHARD"]).data;
      const prov = prim.attributes["_PROVENANCE"] !== undefined ? readAccessor(glb, prim.attributes["_PROVENANCE"]).data : null;
      const idx = readAccessor(glb, prim.indices).data;
      const key = (i: number): string =>
        `${Math.round(pos[i * 3]! * 1e5)},${Math.round(pos[i * 3 + 1]! * 1e5)},${Math.round(pos[i * 3 + 2]! * 1e5)}`;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t]!;
        if (sid[a] !== shard) continue;
        tris++;
        if (prov) provs.set(prov[a]!, (provs.get(prov[a]!) ?? 0) + 1);
        const ks = [key(a), key(idx[t + 1]!), key(idx[t + 2]!)];
        for (let e = 0; e < 3; e++) {
          const [p, q] = [ks[e]!, ks[(e + 1) % 3]!];
          const ek = p < q ? `${p}|${q}` : `${q}|${p}`;
          edges.set(ek, (edges.get(ek) ?? 0) + 1);
        }
        for (const v of [a, idx[t + 1]!, idx[t + 2]!]) {
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, pos[v * 3 + k]!);
            hi[k] = Math.max(hi[k]!, pos[v * 3 + k]!);
          }
        }
      }
    }
    const open = [...edges.values()].filter((n) => n !== 2).length;
    const box = tris ? `box (${lo.map((v) => v.toFixed(3)).join(", ")})..(${hi.map((v) => v.toFixed(3)).join(", ")})` : "";
    const provNote = [...provs.entries()].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${PROVENANCE_NAMES[p] ?? p}:${n}`).join(" ");
    lines.push(
      `  ${(node.name ?? "?").padEnd(18)} ${String(tris).padStart(5)} tris  ${tris === 0 ? "ABSENT" : open === 0 ? "closed" : `${open} open edges`}  ${provNote}  ${box}`,
    );
  }
  return lines;
}

// The stages `rocks.py --dump-stages` writes (its STAGES), in build order.
export const STAGE_ORDER = ["scatter", "clipped", "buried", "sculpted", "culled", "final"];

// The generator's provenance values (rocks.py, PROV_*), in the order the
// debug view's legend shows them.
export const PROVENANCE_NAMES: Record<number, string> = {
  1: "template",
  2: "float clip",
  3: "exact clip",
  4: "hole fill",
  5: "backing",
  6: "rim inset",
  7: "planar dissolve",
};

// One triangle of a body, for `--face body:index` (the `face` a pick logs).
export function faceLines(path: string, body: number, face: number): string[] {
  const glb = readGlb(path);
  const g = glb.json;
  const node = g.nodes.find((n) => n.name === `body-${body}` || n.extras?.["rockIndex"] === body);
  if (!node || node.mesh === undefined) return [`no body ${body} in ${path}`];
  const prim = g.meshes[node.mesh]!.primitives[0]!;
  if (prim.indices === undefined) return ["primitive has no indices"];
  const idx = readAccessor(glb, prim.indices).data;
  if (face < 0 || face * 3 >= idx.length) return [`face ${face} out of range (0..${idx.length / 3 - 1})`];
  const out = [`body ${body} face ${face}:`];
  const attrs = Object.entries(prim.attributes).sort();
  const read = new Map(attrs.map(([name, a]) => [name, readAccessor(glb, a)]));
  for (let k = 0; k < 3; k++) {
    const v = idx[face * 3 + k]!;
    const parts = attrs.map(([name]) => {
      const { data, size } = read.get(name)!;
      const vals = Array.from(data.subarray(v * size, v * size + size)).map((x) => +x.toFixed(4));
      return `${name} ${vals.length === 1 ? vals[0] : `(${vals.join(", ")})`}`;
    });
    out.push(`  v${v}: ${parts.join("  ")}`);
  }
  return out;
}
