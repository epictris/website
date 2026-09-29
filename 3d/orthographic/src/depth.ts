// Depth maps in the page: the editor cannot run the depth model (it is one
// offline file), but it reads the depth map the server made. The stored PNG
// is decoded here at its full 16 bits (a canvas would round to 8, too coarse
// to order objects at nearly the same depth); other pictures go through a canvas.

import { image, type LoadedImage } from "./assets";
import { type DepthMap, depthFromGrey } from "./core/depthmap";
import { base64ToBytes } from "./core/images";
import { decodePng } from "./core/png";
import type { EditorState } from "./core/types";

const decoded = new WeakMap<LoadedImage, Promise<DepthMap>>();

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decode(a: LoadedImage): Promise<DepthMap> {
  const png = a.mimeType === "image/png" ? await decodePng(base64ToBytes(a.data), inflate) : null;
  if (png) {
    const grey = new Uint16Array(png.width * png.height);
    for (let i = 0; i < grey.length; i++) grey[i] = png.samples[i * png.channels];
    return depthFromGrey(png.width, png.height, grey);
  }
  const canvas = document.createElement("canvas");
  canvas.width = a.width;
  canvas.height = a.height;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(a.element, 0, 0);
  const rgba = g.getImageData(0, 0, a.width, a.height).data;
  const grey = new Uint8Array(a.width * a.height);
  for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4];
  return depthFromGrey(a.width, a.height, grey);
}

/** The perspective reference's depth map, when it has one and its picture is loaded. */
export function depthMapOf(s: EditorState): Promise<DepthMap> | undefined {
  const a = image(s.references.perspective?.depth);
  if (!a) return undefined;
  let map = decoded.get(a);
  if (!map) {
    map = decode(a);
    decoded.set(a, map);
  }
  return map;
}
