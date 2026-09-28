// Pictures a level shows on a flat plane: a painted backdrop, a matte behind the
// level (a geometry object with `kind: "image"`, see `GeometryObjectData.image`).
//
// The same store, fetch, budget and provenance rules as every other binary (see
// docs/asset-store.md) and a namespace of its own, for the reason `HDRI_ASSETS`
// has one: this list is what the editor's image picker enumerates, so an entry
// here is a thing an author can choose and nothing else belongs in it.
//
// The manifest is JSON rather than code because it is WRITTEN BY A TOOL: the
// editor's upload (`src/server/images.ts`) optimises the picture, hashes it and
// pins it here in one step, so the sha256 and the size are never typed by hand.
// `bun run assets:publish-images` (part of `just publish`) uploads what the
// release does not hold yet.

import * as THREE from "three";
import manifest from "./imageAssets.json";
import { trackPending } from "./assets";
import { withDownload } from "./download";

export interface ImageAsset {
  // Path under `public/` - `/images/<key>.webp`, gitignored and populated by
  // `bun run assets:fetch` like every other stored file.
  file: string;
  sha256: string;
  // What the loading bar counts (see `RawAsset.bytes`).
  bytes: number;
  // The picture's own size in pixels, so the editor can fit a plane to its
  // aspect without decoding it.
  width: number;
  height: number;
  // Whether any pixel is less than opaque, so the plane blends only when the
  // picture needs it. Absent = opaque.
  alpha?: boolean;
  // As on `MeshAsset`, and required for the same reasons.
  source: string;
  author: string;
  license: string;
}

// Where the pictures live under `public/`, and so the URL they are served at.
export const IMAGES_DIR = "/images";

export function imageFile(key: string): string {
  return `${IMAGES_DIR}/${key}.webp`;
}

// Mutable, and only ever ADDED to: the editor registers a picture it has just
// uploaded so the scene can draw it without a page load (the dev server does the
// same for its own copy, which feeds the preload list). Nothing removes an entry
// at runtime.
export const IMAGE_ASSETS: Record<string, ImageAsset> = { ...(manifest as Record<string, ImageAsset>) };

export function registerImageAsset(key: string, asset: ImageAsset): void {
  IMAGE_ASSETS[key] = asset;
}

// The keys an author may pick from, sorted, so the picker and anything else
// enumerating pictures cannot disagree about what exists.
export function imageNames(): string[] {
  return Object.keys(IMAGE_ASSETS).sort();
}

// Keyed by file, like every other stored-file cache: one fetch, one decode and
// one GPU upload however many planes show the same picture.
const cache = new Map<string, Promise<THREE.Texture | null>>();
let loader: THREE.TextureLoader | null = null;

// Resolves to null for an unknown key or a file that failed to load, which the
// caller draws as a grey plane: a missing picture is visible, not silent.
export function loadImage(key: string): Promise<THREE.Texture | null> {
  const asset = IMAGE_ASSETS[key];
  if (!asset) return Promise.resolve(null);
  const cached = cache.get(asset.file);
  if (cached) return cached;
  loader ??= new THREE.TextureLoader();
  const l = loader;
  const p = trackPending(
    withDownload(asset.file, asset.bytes, (href) => l.loadAsync(href))
      .then((tex) => {
        // A picture is COLOUR, painted in sRGB.
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        return tex;
      })
      .catch((err: unknown) => {
        console.warn(`[render3d] image "${key}": ${String(err)} <- ${asset.file}`);
        return null;
      }),
    `image "${key}"`,
  );
  cache.set(asset.file, p);
  return p;
}
