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
import type { MeshAsset } from "../src/render3d/assets";

// Overridable so a fork, or a private mirror, does not have to patch source.
export const ASSET_REPO = process.env.ASSET_REPO ?? "epictris/website";
export const ASSET_TAG = process.env.ASSET_TAG ?? "assets";

export function assetName(asset: MeshAsset): string {
  return basename(asset.file);
}

export function assetUrl(asset: MeshAsset): string {
  return `https://github.com/${ASSET_REPO}/releases/download/${ASSET_TAG}/${assetName(asset)}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
