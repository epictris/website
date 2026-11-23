// Formation bundles in the asset release (src/formation/bundle.ts,
// docs/formations.md "Publishing"): packed and uploaded by
// `bun run assets:publish-formations` (part of `just publish`), fetched and
// unpacked into the loose store by `bun run assets:fetch`.
//
// A region's bundle is rebuilt only when what it holds changes: its pin
// records the hashes in it, and a region whose hashes are the pin's and whose
// release asset is there is left alone.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PX } from "../src/engine/units";
import { bundleReleaseName, levelFormations, packBundle, unpackBundle, type FormationBundles } from "../src/formation/bundle";
import { meshFiles } from "../src/formation/solid";
import { FORMATION_HASH, meshFileName, MESHES } from "../src/formation/store";
import { scaleLevelData } from "../src/level/levelFormat";
import { LEVELS } from "../src/level/registry";
import { ASSET_REPO, ASSET_TAG, sha256 } from "./assetStore";

const ROOT = join(import.meta.dirname, "..");
const STORE = join(ROOT, "public", "generated");
export const FORMATION_MANIFEST = join(ROOT, "src", "render3d", "formationAssets.json");
const TAG = "[formations]";

export function pinnedBundles(): FormationBundles {
  return existsSync(FORMATION_MANIFEST) ? (JSON.parse(readFileSync(FORMATION_MANIFEST, "utf8")) as FormationBundles) : {};
}

// Every registered level's built formations, by level and region: the hashes,
// and the imported meshes their guides use (kept in the region's bundle too,
// as `meshes/<name>.json`, so a solid guide can be generated again).
export function levelRegions(): Map<string, Map<number, { hashes: Set<string>; meshes: Set<string> }>> {
  const out = new Map<string, Map<number, { hashes: Set<string>; meshes: Set<string> }>>();
  for (const [id, spec] of Object.entries(LEVELS)) {
    const data = scaleLevelData(spec.data, PX);
    for (const { formation, region } of levelFormations(data)) {
      const regions = out.get(id) ?? new Map();
      const r = regions.get(region) ?? { hashes: new Set<string>(), meshes: new Set<string>() };
      r.hashes.add(formation.built!.hash);
      if (formation.guide.kind === "solid") for (const m of meshFiles(formation.guide.tree)) r.meshes.add(m);
      regions.set(region, r);
      out.set(id, regions);
    }
  }
  return out;
}

function releaseAssets(): Set<string> {
  const r = spawnSync("gh", ["release", "view", ASSET_TAG, "--repo", ASSET_REPO, "--json", "assets", "--jq", ".assets[].name"], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`${TAG} cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${r.stderr}`);
    process.exit(1);
  }
  return new Set(r.stdout.split("\n").filter(Boolean));
}

// Pack and upload every region whose bundle is not current; write the pins.
// Returns whether every region is in the store.
export function publishFormations(): boolean {
  const pinned = pinnedBundles();
  const regions = levelRegions();
  const next: FormationBundles = {};
  const failures: string[] = [];
  let uploaded = 0;
  let current = 0;
  const inRelease = regions.size ? releaseAssets() : new Set<string>();
  for (const [level, byRegion] of [...regions].sort()) {
    next[level] = {};
    for (const [region, { hashes, meshes }] of [...byRegion].sort((a, b) => a[0] - b[0])) {
      const name = bundleReleaseName(level.toLowerCase(), region);
      const sorted = [...hashes].sort();
      const pin = pinned[level]?.[String(region)];
      if (pin && JSON.stringify(pin.hashes) === JSON.stringify(sorted) && inRelease.has(name)) {
        next[level]![String(region)] = pin;
        current++;
        continue;
      }
      const files: { name: string; bytes: Uint8Array }[] = [];
      const missing: string[] = [];
      for (const hash of sorted) {
        const dir = join(STORE, hash);
        if (!existsSync(join(dir, "meta.json"))) {
          missing.push(hash.slice(0, 12));
          continue;
        }
        for (const f of readdirSync(dir)) files.push({ name: `${hash}/${f}`, bytes: readFileSync(join(dir, f)) });
      }
      for (const m of meshes) {
        const path = join(STORE, MESHES, meshFileName(m));
        if (existsSync(path)) files.push({ name: `${MESHES}/${meshFileName(m)}`, bytes: readFileSync(path) });
        else missing.push(`mesh ${m.slice(0, 12)}`);
      }
      if (missing.length) {
        failures.push(`${level} region ${region}: not in the local store: ${missing.join(", ")} (generate them in the editor, or \`bun run assets:fetch\`)`);
        if (pin) next[level]![String(region)] = pin;
        continue;
      }
      const bundle = packBundle(files);
      const staging = mkdtempSync(join(tmpdir(), "formations-"));
      const staged = join(staging, name);
      writeFileSync(staged, bundle);
      const up = spawnSync("gh", ["release", "upload", ASSET_TAG, staged, "--repo", ASSET_REPO, "--clobber"], { stdio: "inherit" });
      rmSync(staging, { recursive: true, force: true });
      if (up.status !== 0) {
        failures.push(`${level} region ${region}: upload failed`);
        if (pin) next[level]![String(region)] = pin;
        continue;
      }
      next[level]![String(region)] = { sha256: sha256(bundle), bytes: bundle.length, hashes: sorted };
      uploaded++;
      console.log(`${TAG} uploaded ${name} (${(bundle.length / 1024 / 1024).toFixed(1)} MB, ${sorted.length} formations)`);
    }
  }
  const text = JSON.stringify(next, null, 2) + "\n";
  const changed = text !== (existsSync(FORMATION_MANIFEST) ? readFileSync(FORMATION_MANIFEST, "utf8") : "");
  if (changed) writeFileSync(FORMATION_MANIFEST, text);
  console.log(
    `${TAG} ${uploaded} uploaded, ${current} already current, ${failures.length} failed` +
      (changed ? ` - commit ${relative(ROOT, FORMATION_MANIFEST)} with the levels` : ""),
  );
  for (const f of failures) console.error(`  FAIL  ${f}`);
  return failures.length === 0;
}

// Fetch every pinned bundle whose files the loose store lacks, and unpack it.
export async function fetchFormations(): Promise<{ fetched: number; current: number; failures: string[] }> {
  const failures: string[] = [];
  let fetched = 0;
  let current = 0;
  for (const [level, regions] of Object.entries(pinnedBundles())) {
    for (const [region, pin] of Object.entries(regions)) {
      if (pin.hashes.every((h) => FORMATION_HASH.test(h) && existsSync(join(STORE, h, "meta.json")))) {
        current++;
        continue;
      }
      const name = bundleReleaseName(level.toLowerCase(), Number(region));
      const url = `https://github.com/${ASSET_REPO}/releases/download/${ASSET_TAG}/${name}`;
      try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
          failures.push(`${name}: ${res.status} ${res.statusText} <- ${url}`);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (sha256(bytes) !== pin.sha256) {
          failures.push(`${name}: sha256 mismatch (the release asset was replaced, or the download truncated)`);
          continue;
        }
        for (const f of unpackBundle(bytes)) {
          const dest = join(STORE, f.name);
          if (existsSync(dest)) continue; // content-addressed: what is there is the same
          mkdirSync(join(dest, ".."), { recursive: true });
          writeFileSync(dest, f.bytes);
        }
        fetched++;
        console.log(`[assets] fetched and unpacked ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
      } catch (e) {
        failures.push(`${name}: ${String(e)} <- ${url}`);
      }
    }
  }
  return { fetched, current, failures };
}
