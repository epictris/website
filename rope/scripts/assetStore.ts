// Where the prop bytes live: a GitHub Release on this repo, used as a plain file
// store rather than as a version marker.
//
// WHY NOT GIT (LFS OR OTHERWISE). A binary in git history is permanent: an LFS
// object pushed to GitHub keeps consuming the quota after the file is removed,
// and the only supported purge is deleting the repository. A release asset can
// simply be deleted. That is the whole reason for this indirection - being able
// to change your mind about an asset is worth more here than any of what git
// gives you for it.
//
// THE TRADE, stated once so it is not rediscovered: an asset that is deleted is
// deleted for OLD COMMITS TOO. Their manifest entries name bytes that no longer
// exist, so a build of an old revision fails at the fetch rather than silently
// producing a different-looking game. That is the direct cost of deletability
// and it is the right side to fail on.
//
// The tag is permanent and carries no version meaning - it is a bucket that
// happens to live on GitHub. Assets are flat inside it, keyed by the basename of
// `MeshAsset.file`.

import { basename } from "node:path";
import { createHash } from "node:crypto";
import { MESH_ASSETS, RAW_ASSETS, TEXTURE_ASSETS, textureMaps } from "../src/render3d/assets";

// Overridable so a fork, or a private mirror, does not have to patch source.
export const ASSET_REPO = process.env.ASSET_REPO ?? "epictris/website";
export const ASSET_TAG = process.env.ASSET_TAG ?? "assets";

// Everything the store holds, flattened: a prop is one file and a texture set is
// up to five, and every consumer here - the fetch, the budget, the collision
// check - wants the files rather than the manifests. One list means a texture map
// cannot be left out of a check by being in the other manifest.
export interface StoredAsset {
  // Manifest key, qualified by the map slot for a texture, so a failure names
  // the thing to go and fix.
  key: string;
  file: string;
  sha256: string;
}

export function storedAssets(): StoredAsset[] {
  const out: StoredAsset[] = [];
  for (const [key, asset] of Object.entries(MESH_ASSETS)) {
    out.push({ key, file: asset.file, sha256: asset.sha256 });
  }
  // The water renderer's raw maps (flipbook, foam) - one file per entry, like a
  // prop; see `RawAsset` for why they are not texture-set slots.
  for (const [key, asset] of Object.entries(RAW_ASSETS)) {
    out.push({ key, file: asset.file, sha256: asset.sha256 });
  }
  for (const [key, asset] of Object.entries(TEXTURE_ASSETS)) {
    const maps = asset.maps;
    for (const [slot, map] of Object.entries(maps)) {
      if (map) out.push({ key: `${key}.${slot}`, file: map.file, sha256: map.sha256 });
    }
    // Belt and braces: `textureMaps` is what the runtime iterates, so a slot
    // added there and not here would be a file nothing checks.
    if (textureMaps(asset).length !== Object.values(maps).filter(Boolean).length) {
      throw new Error(`texture "${key}": textureMaps() disagrees with its own map slots`);
    }
  }
  return out;
}

export function assetName(asset: { file: string }): string {
  return basename(asset.file);
}

export function assetUrl(asset: { file: string }): string {
  return `https://github.com/${ASSET_REPO}/releases/download/${ASSET_TAG}/${assetName(asset)}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
