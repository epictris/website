import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGltf } from "./gltfFile";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true }); });
const scratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "gltf-file-"));
  folders.push(folder);
  return folder;
};

const first = Buffer.from("the first image");
const second = Buffer.from("and the second, longer one");
// Geometry ahead of the images, as an exporter lays a buffer out.
const lead = Buffer.alloc(12, 7);
const bin = Buffer.concat([lead, first, second]);
const views = [
  { buffer: 0, byteLength: lead.length },
  { buffer: 0, byteOffset: lead.length, byteLength: first.length },
  { buffer: 0, byteOffset: lead.length + first.length, byteLength: second.length },
];

test("a .glb's images are read out of its binary chunk", () => {
  const path = join(scratch(), "scene.glb");
  const text = Buffer.from(JSON.stringify({
    images: [{ name: "a", bufferView: 1 }, { name: "b", bufferView: 2 }],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  }));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(json);
  const head = Buffer.alloc(20);
  [0x46546c67, 2, 28 + json.length + bin.length, json.length, 0x4e4f534a].forEach((v, i) => head.writeUInt32LE(v, i * 4));
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(bin.length, 0);
  tail.writeUInt32LE(0x004e4942, 4);
  writeFileSync(path, Buffer.concat([head, json, tail, bin]));
  const { doc, imageBytes } = readGltf(path);
  expect(doc.images?.map((im) => im.name)).toEqual(["a", "b"]);
  expect(imageBytes(0)).toEqual(first);
  expect(imageBytes(1)).toEqual(second);
});

test("a .gltf's images are read from their own files, its buffer's file, or a data URI", () => {
  const folder = scratch();
  mkdirSync(join(folder, "textures"));
  writeFileSync(join(folder, "textures", "rock 1 baked colour.png"), first);
  writeFileSync(join(folder, "scene.bin"), bin);
  const path = join(folder, "scene.gltf");
  writeFileSync(path, JSON.stringify({
    images: [
      { name: "file", uri: "textures/rock%201%20baked%20colour.png" },
      { name: "buffer", bufferView: 2 },
      { name: "inline", uri: `data:image/png;base64,${second.toString("base64")}` },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length, uri: "scene.bin" }],
  }));
  const { imageBytes } = readGltf(path);
  expect(imageBytes(0)).toEqual(first);
  expect(imageBytes(1)).toEqual(second);
  expect(imageBytes(2)).toEqual(second);
});

test("a file that is not a GLB is refused, and so is a read past its end", () => {
  const folder = scratch();
  const notGlb = join(folder, "not.glb");
  writeFileSync(notGlb, Buffer.alloc(64));
  expect(() => readGltf(notGlb)).toThrow("is not a GLB");
  writeFileSync(join(folder, "short.bin"), lead);
  const path = join(folder, "short.gltf");
  writeFileSync(path, JSON.stringify({ images: [{ bufferView: 1 }], bufferViews: views, buffers: [{ byteLength: bin.length, uri: "short.bin" }] }));
  expect(() => readGltf(path).imageBytes(0)).toThrow("short of");
});
