// The prop directory, held to what the repo can afford to carry.
//
// Binary assets are the one thing here that gets worse silently. A level renders
// identically whether its props are 40 KB or 6 MB, every test stays green, and
// what changes is how long rope.tris.sh takes to show its first frame and how
// much of the Git LFS bandwidth quota a month of CI spends - neither of which
// anybody reads off a build. So the bar is asserted rather than advised, in the
// suite, next to every other claim this project makes about itself.
//
// Four separate failures, because they have four different fixes:
//
//   POINTER    - a `.glb` that is really a 130-byte Git LFS pointer, which is
//                what a clone without git-lfs installed gets. GLTFLoader fails
//                on it as a parse error deep in a dynamic import, so it is
//                named here instead. `git lfs install && git lfs pull`.
//   MISSING    - a manifest key whose file is not on disk at all. Draws the grey
//                placeholder box in game, which is deliberate (never a hole in
//                the level) and therefore easy to ship without noticing.
//   ORPHAN     - a file on disk no manifest entry names. Bytes in the budget
//                that nothing can draw; a `.glb` is self-contained, so there is
//                no sidecar that would legitimately be unreferenced.
//   PROVENANCE - an entry with no `source`/`license`. See `MeshAsset`.
//
// Then the budget itself.

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MESH_ASSETS } from "../render3d/assets";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = join(ROOT, "public");
const MESH_DIR = join(PUBLIC_DIR, "meshes");

// The total is set by Git LFS bandwidth rather than by disk: the free quota is
// 10 GiB/month and every CI checkout that pulls LFS objects spends the whole
// directory again, so the ceiling is roughly quota / builds-per-month. 100 MB at
// ~50 builds a month is 5 GiB, half the quota, which leaves room for the month
// where a lot is landing. It is not a disk limit and raising it is a real
// decision about that quota, not a formality.
export const TOTAL_BUDGET_BYTES = 100 * 1024 * 1024;
// A single prop this big has not been through `gltf-transform`. The style this
// game is drawn in (see CLAUDE.md) puts a textured prop at well under 1 MB, so
// 8 MB is not a target to author up to - it is the bar that catches a raw
// Blender export with 2k PNGs in it before that becomes the habit.
export const FILE_BUDGET_BYTES = 8 * 1024 * 1024;
// Report the total as a warning well before it fails, so the budget is something
// that gets discussed while there is still room rather than the day it blocks.
const WARN_FRACTION = 0.8;

// Git LFS pointers are small text files with a fixed first line.
const LFS_MAGIC = "version https://git-lfs.github.com/spec/v1";

export interface AssetCheck {
  name: string;
  pass: boolean;
  detail: string;
}

function walk(dir: string): string[] {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no prop directory yet, which is the state the repo ships in
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    // Anything that is not a real file (a dangling symlink, a socket) is not an
    // asset and must not be silently counted as zero bytes.
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}

// A pointer is text and tiny, so this reads at most the magic line and never
// pulls a real model into memory.
function isLfsPointer(path: string): boolean {
  if (statSync(path).size > 1024) return false;
  try {
    return readFileSync(path, "utf8").startsWith(LFS_MAGIC);
  } catch {
    return false; // unreadable as UTF-8 means it is the binary, which is the point
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function runAssetChecks(): AssetCheck[] {
  const files = walk(MESH_DIR);
  const checks: AssetCheck[] = [];

  // `MeshAsset.file` is a URL path under `public/` ("/meshes/rock.glb"), so it
  // is resolved against `public/` rather than against the mesh directory - the
  // manifest is what says where a file lives, and a key naming something outside
  // `public/` could never be served at all.
  const referenced = new Map<string, string>(); // absolute path -> manifest key
  for (const [key, asset] of Object.entries(MESH_ASSETS)) {
    referenced.set(join(PUBLIC_DIR, asset.file.replace(/^\//, "")), key);
  }

  const pointers = files.filter(isLfsPointer);
  checks.push({
    name: "assets: no unfetched Git LFS pointers",
    pass: pointers.length === 0,
    detail: pointers.length
      ? `${pointers.length} pointer file(s), run \`git lfs install && git lfs pull\`: ` +
        pointers.map((f) => relative(ROOT, f)).join(", ")
      : `${files.length} file(s), all real`,
  });

  const missing = [...referenced].filter(([path]) => !files.includes(path));
  checks.push({
    name: "assets: every manifest key has a file",
    pass: missing.length === 0,
    detail: missing.length
      ? missing.map(([path, key]) => `${key} -> ${relative(ROOT, path)}`).join(", ")
      : `${referenced.size} manifest entr(ies) resolved`,
  });

  const orphans = files.filter((f) => !referenced.has(f));
  checks.push({
    name: "assets: no unreferenced files",
    pass: orphans.length === 0,
    detail: orphans.length
      ? `not named by MESH_ASSETS: ${orphans.map((f) => relative(ROOT, f)).join(", ")}`
      : "every file on disk is named by the manifest",
  });

  const unsourced = Object.entries(MESH_ASSETS)
    .filter(([, a]) => !a.source?.trim() || !a.license?.trim())
    .map(([key]) => key);
  checks.push({
    name: "assets: every entry records its source and licence",
    pass: unsourced.length === 0,
    detail: unsourced.length ? `missing source/license: ${unsourced.join(", ")}` : "all recorded",
  });

  // Pointers are excluded from the byte count: a pointer weighs 130 bytes and
  // would report a directory of them as costing nothing, which is the opposite
  // of the truth. The pointer check above is what fails in that case.
  const real = files.filter((f) => !pointers.includes(f));
  const sizes = real.map((f) => ({ file: relative(ROOT, f), bytes: statSync(f).size }));
  const total = sizes.reduce((a, s) => a + s.bytes, 0);

  const oversized = sizes.filter((s) => s.bytes > FILE_BUDGET_BYTES);
  checks.push({
    name: `assets: no single file over ${mb(FILE_BUDGET_BYTES)}`,
    pass: oversized.length === 0,
    detail: oversized.length
      ? `run \`bun run assets:optimize\`: ` +
        oversized.map((s) => `${s.file} (${mb(s.bytes)})`).join(", ")
      : sizes.length
        ? `largest ${mb(Math.max(...sizes.map((s) => s.bytes)))}`
        : "no assets",
  });

  const pct = total / TOTAL_BUDGET_BYTES;
  checks.push({
    name: `assets: total under ${mb(TOTAL_BUDGET_BYTES)}`,
    pass: total <= TOTAL_BUDGET_BYTES,
    detail:
      `${mb(total)} across ${sizes.length} file(s), ${(pct * 100).toFixed(1)}% of budget` +
      (pct >= WARN_FRACTION && total <= TOTAL_BUDGET_BYTES ? " - WARNING, near the bar" : ""),
  });

  return checks;
}
