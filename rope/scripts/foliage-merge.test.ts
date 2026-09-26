import { test, expect } from "bun:test";
import { levelStoredFiles } from "../src/render3d/levelAssets";
import type { RawLevelData } from "../src/level/levelFormat";

test("a level preloads foliage patches alongside Visuals generated meshes", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  const meshes = [`grass-patch:${id}:12345`, `plant-patch:${id}:23456`, "boulder:045e61ca96dec7b1"];
  const level: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [{ kind: "static", x: 0, y: 0, objects: meshes.map(mesh => ({
      type: "geometry", kind: "mesh", mesh, shape: { kind: "rect", w: 100, h: 100 },
    })) }],
  };
  const files = levelStoredFiles(level);
  expect(files).toContainEqual({ file: `/generated-grass/${id}/grass.glb`, bytes: 12345 });
  expect(files).toContainEqual({ file: `/generated-plants/${id}/plants.glb`, bytes: 23456 });
  expect(files.some(file => file.file === "/generated/boulder/045e61ca96dec7b1/mesh.glb")).toBe(true);
});
