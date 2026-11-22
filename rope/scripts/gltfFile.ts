// A glTF read without loading the file whole: its JSON, and one image's bytes
// at a time.
//
// The scene export's checks used to `readFileSync` a `.glb` and slice it, and
// the river's raw export passed 2 GiB on 2026-11-22 (683 baked PNGs, 2.85 GB),
// which no single read in Node or Bun takes. So Blender now writes a `.gltf`
// beside its `.bin` and one file per image (scene_export.py), and both layouts
// are read here by position, whatever their size.

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GltfImage {
  name?: string;
  mimeType?: string;
  uri?: string;
  bufferView?: number;
}

export interface GltfJson {
  images?: GltfImage[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  [key: string]: unknown;
}

export interface GltfFile<Doc extends GltfJson = GltfJson> {
  doc: Doc;
  /** The bytes of image `index`, read from wherever the file keeps them. */
  imageBytes(index: number): Buffer;
}

function readAt(path: string, offset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let done = 0;
    while (done < length) {
      const n = readSync(fd, out, done, length - done, offset + done);
      if (n === 0) throw new Error(`${path} ends at ${offset + done}, short of ${offset + length}`);
      done += n;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

const DATA_URI = /^data:[^,]*;base64,/;

/** Open the `.gltf` or `.glb` at `path`. */
export function readGltf<Doc extends GltfJson = GltfJson>(path: string): GltfFile<Doc> {
  const glb = !path.toLowerCase().endsWith(".gltf");
  let doc: Doc;
  // Where the GLB's binary chunk starts in the file.
  let binStart = 0;
  if (glb) {
    const header = readAt(path, 0, 20);
    if (header.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB`);
    const jsonLength = header.readUInt32LE(12);
    doc = JSON.parse(readAt(path, 20, jsonLength).toString("utf8")) as Doc;
    binStart = 28 + jsonLength;
  } else {
    doc = JSON.parse(readFileSync(path, "utf8")) as Doc;
  }
  const dir = dirname(path);
  const external = (uri: string): string => join(dir, decodeURIComponent(uri));
  const imageBytes = (index: number): Buffer => {
    const image = doc.images?.[index];
    if (!image) throw new Error(`${path} has no image ${index}`);
    if (image.uri !== undefined) {
      const data = DATA_URI.exec(image.uri);
      return data ? Buffer.from(image.uri.slice(data[0].length), "base64") : readFileSync(external(image.uri));
    }
    const view = image.bufferView !== undefined ? doc.bufferViews?.[image.bufferView] : undefined;
    if (!view) return Buffer.alloc(0);
    const buffer = doc.buffers?.[view.buffer ?? 0];
    const offset = view.byteOffset ?? 0;
    if (buffer?.uri === undefined) {
      if (!glb) throw new Error(`${path}: image ${index} is in a buffer with no file`);
      return readAt(path, binStart + offset, view.byteLength);
    }
    const data = DATA_URI.exec(buffer.uri);
    if (data) return Buffer.from(buffer.uri.slice(data[0].length), "base64").subarray(offset, offset + view.byteLength);
    return readAt(external(buffer.uri), offset, view.byteLength);
  };
  return { doc, imageBytes };
}
