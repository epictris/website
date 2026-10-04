// An Orthographic Studio scene's rocks as exact solids, for the Blender
// backdrop (tools/blender/backdrop.py, docs/blender-backdrop.md).
//
//   bun scripts/ortho-solids.ts <scene id | scene.json> out.json
//
// A scene id is fetched from 3d.tris.sh (`export/scene.json`). Each object's
// solid is the studio's own (3d/orthographic/src/core/mesher.ts: the union of
// its parts, each the intersection of its front, top and side outlines'
// prisms), so Blender gets exactly what the studio draws, in the studio's
// metres and axes (x right, y away from the camera, z up). The camera comes
// along: the backdrop is placed so the game camera sees what it saw.

import { readFileSync, writeFileSync } from "node:fs";
import { fromDocument } from "../../3d/orthographic/src/core/document";
import { objectSolid } from "../../3d/orthographic/src/core/mesher";

const STUDIO = "https://3d.tris.sh/orthographic/api/scenes";

const [source, out] = process.argv.slice(2);
if (!source || !out) {
  console.error("usage: bun scripts/ortho-solids.ts <scene id | scene.json> out.json");
  process.exit(2);
}

async function load(): Promise<{ doc: unknown; revision: string }> {
  if (source.endsWith(".json")) return { doc: JSON.parse(readFileSync(source, "utf8")), revision: source };
  const res = await fetch(`${STUDIO}/${source}/export/scene.json`);
  if (!res.ok) throw new Error(`${source}: ${res.status} ${await res.text()}`);
  return { doc: await res.json(), revision: `${STUDIO}/${source}` };
}

const { doc, revision } = await load();
const read = fromDocument(doc);
if (!("state" in read) || !read.state) throw new Error(`not a readable scene: ${JSON.stringify(read.issues).slice(0, 600)}`);
const s = read.state;
const objects = s.objects.map((e) => {
  const { solid } = objectSolid(e.parts);
  try {
    const m = solid.getMesh();
    const n = m.numProp;
    const verts: number[][] = [];
    for (let i = 0; i < m.vertProperties.length / n; i++)
      verts.push([0, 1, 2].map((a) => e.min[a] + m.vertProperties[i * n + a] * e.size[a]));
    const tris: number[][] = [];
    for (let i = 0; i < m.triVerts.length; i += 3) tris.push([m.triVerts[i], m.triVerts[i + 1], m.triVerts[i + 2]]);
    return { id: e.id, name: e.name, kind: e.kind, min: e.min, size: e.size, verts, tris };
  } finally {
    solid.delete();
  }
});
writeFileSync(out, JSON.stringify({ source: revision, title: s.scene.title, camera: s.camera, objects }));
for (const o of objects) console.log(`${o.id.padEnd(18)} ${o.kind.padEnd(6)} ${o.tris.length} triangles`);
