import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { constantColourMaps } from "./bakedMapValidation";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true }); });
const name = "pool map 1 baked colour";
const colour = [26, 69, 85].map((v) => {
  const x = v / 255;
  return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
}).concat(1);

function glb(path: string, doc: object, bin = Buffer.alloc(0)): void {
  const text = Buffer.from(JSON.stringify(doc));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(json);
  const data = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  bin.copy(data);
  const head = Buffer.alloc(20);
  [0x46546c67, 2, 28 + json.length + data.length, json.length, 0x4e4f534a].forEach((v, i) => head.writeUInt32LE(v, i * 4));
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(data.length, 0); tail.writeUInt32LE(0x004e4942, 4);
  writeFileSync(path, Buffer.concat([head, json, tail, data]));
}

async function fixture(factor = colour, nonuniform = false, missingNode = false): Promise<[string, string]> {
  const folder = mkdtempSync(join(tmpdir(), "baked-map-validation-")); folders.push(folder);
  const png = await sharp(Buffer.from([26, 69, 85, nonuniform ? 27 : 26, 69, 85]),
    { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();
  const nodes = [{ name: "pool chunk 001", mesh: 0 }, { name: "pool chunk 002", mesh: 0 }];
  const meshes = [{ primitives: [{ material: 0 }] }];
  const raw = join(folder, "raw.glb"), encoded = join(folder, "encoded.glb");
  glb(raw, { nodes, meshes, textures: [{ source: 0 }],
    images: [{ name, mimeType: "image/png", bufferView: 0 }], bufferViews: [{ byteLength: png.length }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }] }, png);
  glb(encoded, { nodes: missingNode ? nodes.slice(0, 1) : nodes, meshes,
    materials: [{ pbrMetallicRoughness: { baseColorFactor: factor } }] });
  return [raw, encoded];
}

test("constant textures may become matching factors on every bound mesh", async () => {
  expect(await constantColourMaps(...await fixture(), [name])).toEqual(new Set([name]));
});
test("wrong colour and missing mesh bindings are rejected", async () => {
  expect((await constantColourMaps(...await fixture([0, 0, 0, 1]), [name])).size).toBe(0);
  expect((await constantColourMaps(...await fixture([]), [name])).size).toBe(0);
  expect((await constantColourMaps(...await fixture(colour, false, true), [name])).size).toBe(0);
});
test("nonuniform images and normal maps cannot use the constant-colour exception", async () => {
  expect((await constantColourMaps(...await fixture(colour, true), [name])).size).toBe(0);
  expect((await constantColourMaps(...await fixture(), ["pool baked normal"])).size).toBe(0);
});
