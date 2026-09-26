import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGrassRequest } from "../src/server/grassGenerator.ts";
import { generatedGrassAsset } from "../src/render3d/generatedGrass.ts";

// A 1 m square on level ground, as two triangles in the three.js frame.
const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];

test("grass requests accept a surface and reject invalid settings", () => {
  const valid = { positions: square, seed: 3, density: 1100, height: 0.3, clumping: 0.7, tuft: 0.35, detail: 0.25 };
  assert.deepEqual(validateGrassRequest(valid), valid);
  for (const positions of [[], square.slice(0, 8), [...square.slice(0, 8), NaN], [...square.slice(0, 8), 101]])
    assert.throws(() => validateGrassRequest({ ...valid, positions }));
  assert.throws(() => validateGrassRequest({ ...valid, seed: 1.5 }));
  assert.throws(() => validateGrassRequest({ ...valid, density: 0 }));
  assert.throws(() => validateGrassRequest({ ...valid, height: 4 }));
  assert.throws(() => validateGrassRequest({ ...valid, clumping: 2 }));
  assert.throws(() => validateGrassRequest({ ...valid, tuft: 0.01 }));
  assert.throws(() => validateGrassRequest({ ...valid, detail: -1 }));
  // 100 m² at 1100 blades per m² is past what a level can draw.
  assert.throws(() => validateGrassRequest({ ...valid, positions: square.map((n) => n * 10) }),
    /lower the density/);
  // A sliver has no area to grow on.
  assert.throws(() => validateGrassRequest({ ...valid, positions: [0, 0, 0, 1, 0, 0, 2, 0, 0] }));
});

test("generated grass keys resolve to local GLBs only", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedGrassAsset(`grass-patch:${id}:12345`), {
    file: `/generated-grass/${id}/grass.glb`, bytes: 12345,
  });
  for (const key of [`grass-patch:${id}:0`, `grass-patch:${id}:9007199254740992`,
    "grass-patch:../../secret:123", `mushroom-patch:${id}:123`, "rock-1"])
    assert.equal(generatedGrassAsset(key), undefined);
});
