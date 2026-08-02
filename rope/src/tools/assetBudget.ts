// The binary asset directories - props and authored textures - held to what the
// repo can afford to carry.
//
// Binary assets are the one thing here that gets worse silently. A level renders
// identically whether its props are 40 KB or 6 MB, every test stays green, and
// what changes is how long rope.tris.sh takes to show its first frame and how
// much of the Git LFS bandwidth quota a month of CI spends - neither of which
// anybody reads off a build. So the bar is asserted rather than advised, in the
// suite, next to every other claim this project makes about itself.
//
// Five separate failures, because they have five different fixes:
//
//   MISSING    - a manifest key whose file is not on disk. Usually just an
//                unfetched clone (`bun run assets:fetch`), but it is also what a
//                deleted release asset looks like. In game it draws the grey
//                placeholder box, which is deliberate (never a hole in the
//                level) and therefore easy to ship without noticing.
//   STALE      - a file whose bytes are not the `sha256` its entry names. The
//                release asset was replaced, or the download truncated; either
//                way this tree is not the one that was tested.
//   COLLISION  - two entries whose files share a basename. They are one flat
//                namespace in the release, so the second would overwrite the
//                first on publish and both would fetch the same bytes.
//   ORPHAN     - a file on disk no manifest entry names. Bytes in the budget
//                that nothing can draw; a `.glb` is self-contained, so there is
//                no sidecar that would legitimately be unreferenced.
//   PROVENANCE - an entry with no `source`/`license`. See `MeshAsset`.
//
// Then the budget itself.

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MESH_ASSETS, TEXTURE_ASSETS } from "../render3d/assets";
import { storedAssets } from "../../scripts/assetStore";
import { CREDITS_PATH, renderCredits } from "../../scripts/credits";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = join(ROOT, "public");
// Both directories are build output, gitignored and written only by
// `assets:fetch` / `assets:optimize*`. One walk over both, since the budget is
// on the bytes the Docker image carries rather than on any one kind of them.
const ASSET_DIRS = [join(PUBLIC_DIR, "meshes"), join(PUBLIC_DIR, "textures")];

// The store itself imposes nothing worth budgeting against - a GitHub Release
// caps a single asset at 2 GiB and neither total size nor download bandwidth at
// all - so this bar is an engineering one and has to be argued rather than
// quoted. Two things pay for these bytes: the Docker image the VM pulls on every
// deploy (props are baked in at build, see the Dockerfile), and the time a level
// takes to dress itself once it is open. 100 MB is roughly where the image stops
// being a thing you can rebuild and redeploy without thinking about it, and at
// the ~1 MB a prop this game's art style implies it is a hundred-odd props,
// which is a lot more level than currently exists.
//
// It is deliberately NOT a quota, so raising it is allowed - but do it by
// deciding those two costs are worth paying, not because the number was in the
// way.
export const TOTAL_BUDGET_BYTES = 100 * 1024 * 1024;
// A single prop this big has not been through `gltf-transform`. The style this
// game is drawn in (see CLAUDE.md) puts a textured prop at well under 1 MB, so
// 8 MB is not a target to author up to - it is the bar that catches a raw
// Blender export with 2k PNGs in it before that becomes the habit.
export const FILE_BUDGET_BYTES = 8 * 1024 * 1024;
// Report the total as a warning well before it fails, so the budget is something
// that gets discussed while there is still room rather than the day it blocks.
const WARN_FRACTION = 0.8;

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

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function runAssetChecks(): AssetCheck[] {
  const files = ASSET_DIRS.flatMap(walk).sort();
  const checks: AssetCheck[] = [];

  // Props and texture maps in one list (`storedAssets`), so neither manifest can
  // be checked while the other quietly is not.
  //
  // A `file` is a URL path under `public/` ("/meshes/rock.glb"), so it is
  // resolved against `public/` rather than against a directory chosen here - the
  // manifest is what says where a file lives, and a key naming something outside
  // `public/` could never be served at all.
  const stored = storedAssets();
  const wanted = new Map<string, string>(); // absolute path -> sha256
  const referenced = new Map<string, string>(); // absolute path -> manifest key
  for (const asset of stored) {
    const path = join(PUBLIC_DIR, asset.file.replace(/^\//, ""));
    referenced.set(path, asset.key);
    wanted.set(path, asset.sha256);
  }

  const missing = [...referenced].filter(([path]) => !files.includes(path));
  checks.push({
    name: "assets: every manifest key has a file",
    pass: missing.length === 0,
    detail: missing.length
      ? `run \`bun run assets:fetch\` (or the asset was deleted from the release): ` +
        missing.map(([path, key]) => `${key} -> ${relative(ROOT, path)}`).join(", ")
      : `${referenced.size} manifest entr(ies) resolved`,
  });

  // The bytes on disk are the bytes the manifest names. A release asset can be
  // replaced in place, so without this a tree can quietly be running a different
  // model from the one its revision was written against.
  const stale: string[] = [];
  for (const [path, key] of referenced) {
    if (!files.includes(path)) continue;
    const want = wanted.get(path)!;
    const got = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (got !== want) stale.push(`${key}: manifest ${want.slice(0, 12)}…, disk ${got.slice(0, 12)}…`);
  }
  checks.push({
    name: "assets: on-disk bytes match the manifest sha256",
    pass: stale.length === 0,
    detail: stale.length ? stale.join("; ") : `${referenced.size - missing.length} verified`,
  });

  // One flat namespace in the release, keyed by basename - so two entries whose
  // files differ only by directory would overwrite each other on publish and
  // then both fetch the same bytes, which is a level quietly wearing the wrong
  // prop rather than any kind of error.
  const byName = new Map<string, string[]>();
  for (const asset of stored) {
    const name = basename(asset.file);
    byName.set(name, [...(byName.get(name) ?? []), asset.key]);
  }
  const collisions = [...byName].filter(([, keys]) => keys.length > 1);
  checks.push({
    name: "assets: no two entries share a filename",
    pass: collisions.length === 0,
    detail: collisions.length
      ? collisions.map(([name, keys]) => `${name} <- ${keys.join(", ")}`).join("; ")
      : `${byName.size} distinct filename(s)`,
  });

  const orphans = files.filter((f) => !referenced.has(f));
  checks.push({
    name: "assets: no unreferenced files",
    pass: orphans.length === 0,
    detail: orphans.length
      ? `named by no manifest: ${orphans.map((f) => relative(ROOT, f)).join(", ")}`
      : "every file on disk is named by a manifest",
  });

  // Provenance is per ENTRY rather than per file: a texture set is credited as
  // one surface however many of its five maps it ships (see `TextureAsset`).
  const provenance: Array<[string, { source: string; author: string; license: string }]> = [
    ...Object.entries(MESH_ASSETS),
    ...Object.entries(TEXTURE_ASSETS),
  ];
  const unsourced = provenance
    .filter(([, a]) => !a.source?.trim() || !a.license?.trim() || !a.author?.trim())
    .map(([key]) => key)
    // A pinned sha256 is the other half of an entry being complete, and it is
    // per file.
    .concat(stored.filter((a) => !a.sha256?.trim()).map((a) => a.key));
  checks.push({
    name: "assets: every entry records its source, author, licence and sha256",
    pass: unsourced.length === 0,
    detail: unsourced.length
      ? `incomplete: ${unsourced.join(", ")}`
      : `${provenance.length} entr(ies) recorded`,
  });

  // Attribution is a licence obligation for anything under CC-BY, and a credits
  // file kept by hand is one that is forgotten on exactly the day an asset is
  // added. Generated from the manifest, and checked here so it cannot drift.
  const wantCredits = renderCredits();
  const haveCredits = existsSync(CREDITS_PATH) ? readFileSync(CREDITS_PATH, "utf8") : "";
  checks.push({
    name: "assets: CREDITS.md matches the manifest",
    pass: haveCredits === wantCredits,
    detail:
      haveCredits === wantCredits
        ? "up to date"
        : "out of date - run `bun run assets:credits`",
  });

  const sizes = files.map((f) => ({ file: relative(ROOT, f), bytes: statSync(f).size }));
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
