// Bring the release store in line with the exports the registered levels name
// (their Blender scenes, the models their bodies carry), and write the
// manifest that pins them to match: the shared half of
// `scripts/publish-scenes.ts` and `scripts/publish-models.ts`.
//
// Unlike a generated mesh, an export is REPLACED IN PLACE: its release asset is
// re-uploaded whenever this machine's export differs from the pin, because a
// scene or a model is exported again and again while it is worked on, and a
// name per export would leave every draft in the release for ever. The pin
// (sha256 + bytes) is what says which export a commit meant; `assets:fetch`
// verifies it, so an older commit whose export was replaced fails its fetch
// loudly rather than drawing a different level - the store's stated trade
// (docs/asset-store.md).
//
// An entry no level names any more is dropped from the manifest and NOT
// deleted from the release, since an older commit may still pin it; the
// command to delete it is printed.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SceneCredit } from "../src/render3d/scenes";
import { ASSET_REPO, ASSET_TAG, sha256 } from "./assetStore";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");

interface PinnedExport {
  sha256: string;
  bytes: number;
  credits?: SceneCredit[];
}

export interface ExportKind {
  // `[scenes]`, `[models]`: the log's tag.
  tag: string;
  // What one is called in a message ("scene", "model").
  noun: string;
  // Every export the registered levels name, with the levels naming it.
  named: Map<string, string[]>;
  // The manifest as it stands, and where it is written.
  pinned: Readonly<Record<string, PinnedExport>>;
  manifest: string;
  // The served path of an export's mesh and meta, and its release name.
  file: (name: string) => string;
  metaFile: (name: string) => string;
  releaseName: (name: string) => string;
  // The recipe that exports one, for a message (`just scene <level>`).
  recipe: string;
}

function releaseNames(tag: string): Set<string> {
  if (spawnSync("which", ["gh"]).status !== 0) {
    console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
    process.exit(2);
  }
  const r = spawnSync(
    "gh",
    ["release", "view", ASSET_TAG, "--repo", ASSET_REPO, "--json", "assets", "--jq", ".assets[].name"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`${tag} cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${r.stderr}`);
    process.exit(1);
  }
  return new Set(r.stdout.split("\n").filter(Boolean));
}

// Publish what `kind` names; true when every export is in the store.
export function publishExports(kind: ExportKind): boolean {
  const named = kind.named;
  const manifest: Record<string, PinnedExport> = { ...kind.pinned };
  const dropped = Object.keys(manifest).filter((entry) => !named.has(entry));
  const failures: string[] = [];
  let uploaded = 0;
  let current = 0;
  if (named.size) {
    const inRelease = releaseNames(kind.tag);
    for (const [entry, levels] of [...named].sort()) {
      const name = kind.releaseName(entry);
      const path = join(PUBLIC_DIR, kind.file(entry).slice(1));
      const pinned = manifest[entry];
      if (!existsSync(path)) {
        // Nothing exported here. A pin the release honours is fine (a fresh
        // checkout publishing something else); anything less is an export the
        // deploy cannot draw.
        if (pinned && inRelease.has(name)) {
          current++;
          continue;
        }
        failures.push(`${entry} (${levels.join(", ")}): not exported on this machine (\`${kind.recipe}\`) and not in the release`);
        continue;
      }
      const bytes = readFileSync(path);
      const hash = sha256(bytes);
      // The credits of what is inside it ride along with the pin, from the
      // export's own meta - which must describe this very file.
      const metaPath = join(PUBLIC_DIR, kind.metaFile(entry).slice(1));
      const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as { sha256: string; credits?: SceneCredit[] }) : null;
      if (!meta || meta.sha256 !== hash) {
        failures.push(`${entry} (${levels.join(", ")}): meta.json does not describe this ${relative(PUBLIC_DIR, path)}; export it again (\`${kind.recipe}\`)`);
        continue;
      }
      const credits = meta.credits ?? [];
      if (pinned?.sha256 === hash && pinned.bytes === bytes.length && inRelease.has(name)) {
        if (JSON.stringify(pinned.credits ?? []) !== JSON.stringify(credits)) manifest[entry] = { ...pinned, credits };
        current++;
        continue;
      }
      // gh names a release asset after the file (a "#suffix" only sets its display label), so
      // upload a copy that already carries the release name.
      const staging = mkdtempSync(join(tmpdir(), `${kind.noun}-`));
      const staged = join(staging, name);
      copyFileSync(path, staged);
      const up = spawnSync("gh", ["release", "upload", ASSET_TAG, staged, "--repo", ASSET_REPO, "--clobber"], {
        stdio: "inherit",
      });
      rmSync(staging, { recursive: true, force: true });
      if (up.status !== 0) {
        failures.push(`${entry} (${levels.join(", ")}): upload failed`);
        continue;
      }
      manifest[entry] = { sha256: hash, bytes: bytes.length, credits };
      uploaded++;
      console.log(
        `${kind.tag} uploaded ${name} (${(bytes.length / 1024).toFixed(0)} KB)` +
          (pinned ? ` replacing ${pinned.sha256.slice(0, 12)}…` : ""),
      );
    }
  }

  for (const entry of dropped) {
    delete manifest[entry];
    console.log(
      `${kind.tag} dropped ${entry}, which no level names; still in the release for older commits ` +
        `(\`gh release delete-asset ${ASSET_TAG} ${kind.releaseName(entry)}\` to remove it)`,
    );
  }

  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((entry) => [entry, manifest[entry]!]));
  const text = JSON.stringify(sorted, null, 2) + "\n";
  const changed = text !== readFileSync(kind.manifest, "utf8");
  if (changed) writeFileSync(kind.manifest, text);

  console.log(
    `${kind.tag} ${named.size} named by the levels, ${uploaded} uploaded, ${current} already current, ` +
      `${dropped.length} dropped, ${failures.length} failed` +
      (changed ? ` - commit ${relative(ROOT, kind.manifest)} with the levels` : ""),
  );
  for (const f of failures) console.error(`  FAIL  ${f}`);
  return failures.length === 0;
}
