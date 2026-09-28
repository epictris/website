// Images the editor holds. Pixels are kept once, as base64 for saving and as a
// decoded element + blob URL for drawing; scene state refers to them by id.

import { createSignal } from "solid-js";
import { base64ToBytes, bytesToBase64, IMAGE_MIMES, imageId, MAX_IMAGE_BYTES, sniffMime } from "./core/images";
import type { ImageAsset } from "./core/types";

export interface LoadedImage extends ImageAsset {
  /** Blob URL for on-screen drawing (cheap to put in markup, unlike a data URL). */
  url: string;
  element: HTMLImageElement;
}

const images = new Map<string, LoadedImage>();
const [version, setVersion] = createSignal(0);

/** Read an image, tracking additions reactively. */
export function image(id: string | undefined | null): LoadedImage | undefined {
  version();
  return id ? images.get(id) : undefined;
}

export const allImages = (): ReadonlyMap<string, LoadedImage> => {
  version();
  return images;
};

export const dataUrl = (a: ImageAsset) => `data:${a.mimeType};base64,${a.data}`;

/** Register an asset whose id and metadata are already known (from a document). */
export async function registerImage(a: ImageAsset): Promise<LoadedImage> {
  const existing = images.get(a.id);
  if (existing && existing.data === a.data) return existing;
  const bytes = base64ToBytes(a.data);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.mimeType }));
  const element = new Image();
  element.src = url;
  try {
    await element.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Image "${a.id}" could not be decoded.`);
  }
  const loaded: LoadedImage = { ...a, width: element.naturalWidth, height: element.naturalHeight, url, element };
  if (existing) URL.revokeObjectURL(existing.url);
  images.set(a.id, loaded);
  setVersion((v) => v + 1);
  return loaded;
}

/** Add image bytes (a file or API upload). The id is derived from the content. */
export async function addImageBytes(bytes: Uint8Array, name: string): Promise<LoadedImage> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Use an image smaller than 25 MB.");
  const mimeType = sniffMime(bytes);
  if (!mimeType || !IMAGE_MIMES.includes(mimeType)) throw new Error("Use a PNG, JPEG, WebP or GIF image.");
  const id = await imageId(bytes);
  const existing = images.get(id);
  if (existing) return existing;
  return registerImage({
    id,
    name: name.slice(0, 180) || id,
    mimeType,
    width: 1,
    height: 1,
    data: bytesToBase64(bytes),
  });
}

export async function addImageFile(file: File): Promise<LoadedImage> {
  return addImageBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}
