// Formation bundles: how a level's built formations are kept in the asset
// release (docs/formations.md, "Publishing").
//
// A level's formations are split into REGIONS by where their bodies stand
// (bands REGION_WIDTH wide along x), and each region's files go into one
// bundle: every file of every hash it holds (meta.json, geometry.glb,
// rock.blend, the tiers), each under its store name `<hash>/<file>`, so a
// bundle unpacks straight back into `public/generated/` and editing carries
// on. A region is re-published when one of its formations changes; the rest
// stay as they are.
//
// The release is where bundles are KEPT; the game never downloads one. Each is
// unpacked into the loose store (`assets:fetch`), and the build keeps of each
// formation only the file the game loads (`formationServedFile`).
//
// The container: "RFB1", a little-endian u32 length, that many bytes of JSON
// `{files: [{name, offset, length}]}` (offsets from the end of the JSON),
// then the files in name order. Deterministic, so the same files make the
// same bytes and the same pin.

import type { FormationData, LevelData } from "../level/levelFormat";
import { chosenTierOf } from "./tiers";
import { geometryFile, tierFile } from "./store";

export const REGION_WIDTH = 30;
export const BUNDLE_MAGIC = "RFB1";

// The release asset a bundle is kept as.
export function bundleReleaseName(level: string, region: number): string {
  return `formations-${level}-r${region}.bin`;
}

// What the manifest (`src/render3d/formationAssets.json`) pins, per level, per
// region: the bundle's bytes and the hashes in it.
export interface FormationBundlePin {
  sha256: string;
  bytes: number;
  hashes: string[];
}
export type FormationBundles = Record<string, Record<string, FormationBundlePin>>;

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

export function packBundle(files: readonly BundleFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let offset = 0;
  const index = sorted.map((f) => {
    const entry = { name: f.name, offset, length: f.bytes.length };
    offset += f.bytes.length;
    return entry;
  });
  const json = new TextEncoder().encode(JSON.stringify({ files: index }));
  const out = new Uint8Array(8 + json.length + offset);
  out.set(new TextEncoder().encode(BUNDLE_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  let at = 8 + json.length;
  for (const f of sorted) {
    out.set(f.bytes, at);
    at += f.bytes.length;
  }
  return out;
}

export function unpackBundle(bytes: Uint8Array): BundleFile[] {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== BUNDLE_MAGIC) throw new Error("not a formation bundle");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as { files: { name: string; offset: number; length: number }[] };
  const base = 8 + length;
  return index.files.map((f) => ({ name: f.name, bytes: bytes.subarray(base + f.offset, base + f.offset + f.length) }));
}

// The region a body stands in.
export function regionOf(x: number): number {
  return Math.floor(x / REGION_WIDTH);
}

// Every built formation of a level (metres), with its body's region.
export function levelFormations(data: LevelData): { formation: FormationData; region: number }[] {
  return data.bodies.flatMap((b) => (b.formation?.built ? [{ formation: b.formation, region: regionOf(b.x) }] : []));
}

// The one file of a built formation the game loads, as a store path: the tier
// it draws, or the iteration mesh when it is not baked.
export function formationServedFile(f: FormationData): { path: string; bytes: number } | null {
  if (!f.built) return null;
  const tier = chosenTierOf(f);
  return tier === null
    ? { path: geometryFile(f.built.hash), bytes: 0 }
    : { path: tierFile(f.built.hash, tier), bytes: f.built.tiers[tier]!.bytes };
}
