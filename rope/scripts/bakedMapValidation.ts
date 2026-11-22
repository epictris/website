import { createHash } from "node:crypto";
import sharp from "sharp";
import { readGltf, type GltfJson } from "./gltfFile";

interface Document extends GltfJson {
  textures: { source?: number }[];
  materials: { pbrMetallicRoughness?: {
    baseColorTexture?: { index: number };
    baseColorFactor?: number[];
  } }[];
  meshes: { primitives: { material?: number }[] }[];
  nodes: { name?: string; mesh?: number }[];
}

const linear = (v: number): number => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;

/** Prove a removed colour image became the same constant on its actual mesh.
 * Keep the check conservative for multi-primitive/unnamed meshes, normal maps,
 * nonuniform images, missing bindings and images merely resized or re-encoded.
 */
export async function constantColourMaps(raw: string, encoded: string, candidates: string[]): Promise<Set<string>> {
  const { doc: source, imageBytes } = readGltf<Document>(raw);
  const { doc: output } = readGltf<Document>(encoded);
  const accepted = new Set<string>();
  const colours = new Map<string, Promise<number[] | null>>();
  for (const name of candidates) {
    if (!name.endsWith(" baked colour")) continue;
    const imageIndex = (source.images ?? []).findIndex((image) => image.name === name);
    const image = source.images?.[imageIndex];
    // A `.gltf` beside its images names the type by the file, not `mimeType`.
    if (!image || !(image.mimeType === "image/png" || /\.png$/i.test(image.uri ?? ""))) continue;
    const bytes = imageBytes(imageIndex);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!colours.has(hash)) colours.set(hash, (async () => {
      const { channels } = await sharp(bytes).stats();
      if ((channels.length !== 3 && channels.length !== 4) || channels.some((c) => c.min !== c.max)) return null;
      return [...channels.slice(0, 3).map((c) => linear(c.min / 255)), (channels[3]?.min ?? 255) / 255];
    })());
    const colour = await colours.get(hash)!;
    if (!colour) continue;
    let uses = 0;
    let valid = true;
    for (const node of source.nodes) {
      if (node.mesh === undefined) continue;
      const primitives = source.meshes[node.mesh]!.primitives;
      for (const primitive of primitives) {
        if (primitive.material === undefined) continue;
        const material = source.materials[primitive.material]!.pbrMetallicRoughness;
        const texture = material?.baseColorTexture;
        if (!texture || source.textures[texture.index]?.source !== imageIndex) continue;
        uses++;
        const destination = node.name ? output.nodes.find((n) => n.name === node.name) : undefined;
        const parts = destination?.mesh === undefined ? [] : output.meshes[destination.mesh]!.primitives;
        if (primitives.length !== 1 || parts.length !== 1 || parts[0]!.material === undefined) {
          valid = false;
          continue;
        }
        const target = output.materials[parts[0]!.material!]!.pbrMetallicRoughness;
        const expected = colour.map((c, i) => c * (material?.baseColorFactor?.[i] ?? 1));
        const actual = target?.baseColorFactor ?? [1, 1, 1, 1];
        if (target?.baseColorTexture || actual.length !== 4 || actual.some((c) => !Number.isFinite(c))
            || expected.some((c, i) => !Number.isFinite(c) || Math.abs(c - actual[i]!) > 1e-6)) valid = false;
      }
    }
    if (uses && valid) accepted.add(name);
  }
  return accepted;
}
