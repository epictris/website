// Image assets: content-addressed ids and base64 helpers. Pure; runs in the
// browser and in Bun.

import type { ImageMime } from "./types";

export const IMAGE_MIMES: ImageMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function base64ToBytes(data: string): Uint8Array {
  const raw = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}

/** The same bytes always get the same id, so re-saving a project gives a stable file. */
export async function imageId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `img-${Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The file type from its magic bytes, or null when it is not an accepted image. */
export function sniffMime(b: Uint8Array): ImageMime | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Split a data: URL into its type and base64 payload. */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}
