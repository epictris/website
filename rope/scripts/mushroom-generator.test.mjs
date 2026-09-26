import { test } from "node:test";
import assert from "node:assert/strict";
import { soupArea, validateMushroomRequest } from "../src/server/mushroomGenerator.ts";
import { generatedMushroomAsset } from "../src/render3d/generatedMushrooms.ts";

// A 1 m square on level ground, as two triangles in the three.js frame.
const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];

test("the triangle soup's area is in square metres", () => {
  assert.equal(soupArea(square), 1);
  assert.equal(soupArea([0, 0, 0, 2, 0, 0, 0, 3, 0]), 3);
});

test("mushroom requests accept a surface and reject invalid settings", () => {
  const valid = { positions: square, seed: 3, density: 150, height: 0.16, clumping: 0.75, detail: 0.3 };
  assert.deepEqual(validateMushroomRequest(valid), valid);
  for (const positions of [[], square.slice(0, 8), [...square.slice(0, 8), NaN], [...square.slice(0, 8), 101]])
    assert.throws(() => validateMushroomRequest({ ...valid, positions }));
  assert.throws(() => validateMushroomRequest({ ...valid, seed: 1.5 }));
  assert.throws(() => validateMushroomRequest({ ...valid, density: 0 }));
  assert.throws(() => validateMushroomRequest({ ...valid, height: 3 }));
  assert.throws(() => validateMushroomRequest({ ...valid, clumping: 2 }));
  assert.throws(() => validateMushroomRequest({ ...valid, detail: -1 }));
  // 4 m² at 1000 per m² is past what the exact overlap pass bakes interactively.
  assert.throws(() => validateMushroomRequest({ ...valid, positions: square.map((n) => n * 2), density: 1000 }),
    /lower the density/);
  // A sliver has no area to grow on.
  assert.throws(() => validateMushroomRequest({ ...valid, positions: [0, 0, 0, 1, 0, 0, 2, 0, 0] }));
});

test("generated mushroom keys resolve to local GLBs only", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedMushroomAsset(`mushroom-patch:${id}:12345`), {
    file: `/generated-mushrooms/${id}/mushrooms.glb`, bytes: 12345,
  });
  for (const key of [`mushroom-patch:${id}:0`, `mushroom-patch:${id}:9007199254740992`,
    "mushroom-patch:../../secret:123", "rock-1"])
    assert.equal(generatedMushroomAsset(key), undefined);
});
