import assert from "node:assert/strict";
import * as THREE from "three";
import { DEFAULT_HANGING_VINE_SETTINGS, generateHangingVine, VineSurface, type HangingVineRecipe } from "../src/render3d/foliage/vine/hangingVine";
import { DEFAULT_FERN_SETTINGS, generateFern, varietyDefaults, type FernRecipe, type FernVariety } from "../src/render3d/foliage/vine/fern";
import { findFernSpots } from "../src/render3d/foliage/fernPlacement";
import { validateSavedFoliage, type SavedFoliage } from "../src/render3d/foliage/recipe";
import { generatedVineAsset } from "../src/render3d/generatedVines";
import { attachFoliageWind, updateFoliageWind, disposeFoliageWind } from "../src/render3d/foliage/wind";
import { modelFromDisk, modelToDisk } from "../src/editor/model";
import { foliageGenerator } from "../src/server/foliageGenerator";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const soup = new THREE.BoxGeometry(3, 1.8, 1.6).toNonIndexed().getAttribute("position").array as Float32Array;
const surface = new VineSurface(soup);
const vine: HangingVineRecipe = { version: 1, start: [0, .9, .4], normal: [0, 1, 0], direction: [0, 0, 1],
  settings: { ...DEFAULT_HANGING_VINE_SETTINGS, length: 1.4, leafStyle: "paint-1+leaf-3", natural: true, paintTint: .6 } };
const a = generateHangingVine(soup, vine), b = generateHangingVine(soup, vine);
assert.deepEqual(a.points.map(p => p.toArray()), b.points.map(p => p.toArray()));
assert.ok(a.leafCount > 0 && a.obstacles.length > 0);
for (let i = 1; i < a.points.length; i++) assert.ok(surface.clear(a.points[i - 1], a.points[i], vine.settings.radius * .9));
for (const variety of ["painted", "leaflet", "sprig"] as FernVariety[]) {
  const recipe: FernRecipe = { version: 1, kind: "fern", root: [0, .9, 0], normal: [0, 1, 0], open: [1, 0, 0],
    settings: { ...DEFAULT_FERN_SETTINGS, ...varietyDefaults(variety), fronds: 5, length: .3 } };
  const one = generateFern(surface, recipe), two = generateFern(surface, structuredClone(recipe));
  assert.ok(one.frondCount > 0 && one.obstacles.length > 0, `${variety} grows`);
  let vertices = 0;
  one.group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const p = object.geometry.getAttribute("position"); vertices += p.count;
    for (const n of p.array) assert.ok(Number.isFinite(n));
    assert.ok(object.geometry.getAttribute("sway"));
    const twin = two.group.getObjectByName(object.name) as THREE.Mesh;
    assert.deepEqual(p.array, twin.geometry.getAttribute("position").array);
  });
  assert.ok(vertices > 100);
  validateSavedFoliage({ version: 2, kind: "fern", hostId: 1, hostMesh: "", hostIndex: 0, recipe });
  assert.throws(() => validateSavedFoliage({ version: 2, kind: "fern", hostId: 1, hostMesh: "", hostIndex: 0,
    recipe: { ...recipe, normal: [0, 0, 0] } }), /direction/);
}
const spots = findFernSpots(surface, soup, { ...DEFAULT_FERN_SETTINGS, fronds: 5 }, [], 5, .3, 42);
assert.ok(spots.length > 0 && spots.length <= 5);
assert.deepEqual(spots.map(s => s.point.toArray()), findFernSpots(surface, soup, { ...DEFAULT_FERN_SETTINGS, fronds: 5 }, [], 5, .3, 42).map(s => s.point.toArray()));
for (let i = 0; i < spots.length; i++) for (let j = 0; j < i; j++) assert.ok(spots[i].point.distanceTo(spots[j].point) >= .3);
const existing = spots.map(s => s.point);
const next = findFernSpots(surface, soup, DEFAULT_FERN_SETTINGS, existing, 5, .3, 42);
for (const spot of next) for (const root of existing) assert.ok(spot.point.distanceTo(root) >= .3);

const key = "foliage-v1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:120";
assert.equal(generatedVineAsset(key)?.file, "/generated-vines/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/vine.glb");
assert.ok(generatedVineAsset(key.replace("foliage-v1", "vine-v3")));
const transform = new THREE.Matrix4().makeTranslation(.25, .5, -.1).toArray();
const data = { player: { x: 0, y: 0 }, bodies: [], scene: "river", foliage: [
  { id: 1000000001, host: "body:boulder-1", mesh: key, transform },
] };
const roundtrip = modelToDisk(modelFromDisk(data));
assert.deepEqual(roundtrip.foliage, data.foliage, "host-local metre transforms survive pixel/metre conversion");
const editorModel = modelFromDisk(data);
editorModel.foliage![0]!.transform[12] = 7;
assert.equal(transform[12], .25, "editing does not mutate the loaded recipe");

const windGroup = a.group.clone(true); attachFoliageWind(windGroup); updateFoliageWind(2);
windGroup.traverse(object => {
  if (!(object instanceof THREE.Mesh)) return;
  if (!object.geometry.getAttribute("sway")) return;
  assert.ok(object.customDepthMaterial && object.customDistanceMaterial);
  const mat = object.material as THREE.Material;
  const shader = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "" };
  mat.onBeforeCompile(shader as never, {} as never);
  assert.ok(shader.vertexShader.includes("foliageTime"));
});
disposeFoliageWind(windGroup);

// Live vine previews share the stem material between several meshes.
attachFoliageWind(b.group, false);
b.group.traverse(object => {
  if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute("sway")) return;
  const shader = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "" };
  (object.material as THREE.Material).onBeforeCompile(shader as never, {} as never);
  assert.equal(shader.vertexShader.split("attribute float sway;").length - 1, 1, "shared preview materials get one wind patch");
});
disposeFoliageWind(b.group);

// Exercise the real save middleware without running a second web server.
const scratch = await mkdtemp(join(tmpdir(), "rope-foliage-test-"));
try {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {};
  const plugin = foliageGenerator();
  (plugin.configureServer as Function)({ config: { root: scratch }, middlewares: { use: (_path: string, fn: typeof handler) => { handler = fn; } } });
  const saved: SavedFoliage = { version: 2, kind: "vine", hostId: 1, hostIndex: 0, hostMesh: "rock", recipe: vine };
  const glb = Buffer.alloc(20); glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(20, 8);
  async function request(method: string, url: string, body?: unknown, origin?: string) {
    let code = 0, result: Record<string, any> = {};
    const req = { method, url, headers: { "content-type": "application/json", host: "localhost:5174", ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { set statusCode(n: number) { code = n; }, setHeader() {}, end(text: string) { result = JSON.parse(text); } };
    await handler(req, res); return { code, result };
  }
  const response = await request("POST", "/", { saved, glb: glb.toString("base64") });
  assert.equal(response.code, 200);
  const id = response.result.mesh.split(":")[1];
  assert.deepEqual((await request("GET", `/${id}`)).result, saved);
  assert.equal((await readFile(join(scratch, "public/generated-vines", id, "vine.glb"))).length, 20);
  assert.equal((await request("POST", "/", { saved, glb: "broken" })).code, 400);
  assert.equal((await request("POST", "/", { saved, glb: glb.toString("base64") }, "https://other.test")).code, 403);
  assert.equal((await request("GET", "/../../secret")).code, 404);
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log(`Foliage tests passed: painted vines, all fern varieties, deterministic scatter (${spots.length} placements), clearance, asset resolution, level roundtrip, sway/shadows, save/reload and validation.`);
