import { test } from "node:test";
import assert from "node:assert/strict";
import { plantEstimate, validatePlantRequest } from "../src/server/plantGenerator.ts";
import { generatedPlantAsset } from "../src/render3d/generatedPlants.ts";

// A 1 m square on level ground, as two triangles in the three.js frame.
const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];
const valid = {
  positions: square, seed: 3, density: 1.5, size: 1, ivyLength: 1.2, detail: 0.5, slope: 75,
  types: ["alocasia", "fern", "creepers", "ivy"],
};

test("plant requests accept a surface and reject invalid settings", () => {
  assert.deepEqual(validatePlantRequest(valid), valid);
  for (const positions of [[], square.slice(0, 8), [...square.slice(0, 8), NaN], [...square.slice(0, 8), 101]])
    assert.throws(() => validatePlantRequest({ ...valid, positions }));
  assert.throws(() => validatePlantRequest({ ...valid, seed: 1.5 }));
  assert.throws(() => validatePlantRequest({ ...valid, density: 0 }));
  assert.throws(() => validatePlantRequest({ ...valid, size: 4 }));
  assert.throws(() => validatePlantRequest({ ...valid, ivyLength: 0.1 }));
  assert.throws(() => validatePlantRequest({ ...valid, detail: -1 }));
  assert.throws(() => validatePlantRequest({ ...valid, slope: 91 }));
  // 100 m² at 3 plants (12 ivy) per m² is past what a level can draw.
  assert.throws(() => validatePlantRequest({ ...valid, density: 3, positions: square.map((n) => n * 10) }),
    /lower the density/);
  // A sliver has no area to grow on.
  assert.throws(() => validatePlantRequest({ ...valid, positions: [0, 0, 0, 1, 0, 0, 2, 0, 0] }));
});

test("only the plants are accepted, never rocks or mushrooms", () => {
  for (const types of [[], ["fern", "fern"], ["rock"], ["mushrooms"], ["fern", "Rock_A"], "fern"])
    assert.throws(() => validatePlantRequest({ ...valid, types }), /at least one plant type/);
  for (const t of ["alocasia", "birdsnest", "fern", "creepers", "ivy"])
    assert.doesNotThrow(() => validatePlantRequest({ ...valid, types: [t] }));
});

test("the estimate takes the larger of what the up faces and the undersides can hold", () => {
  assert.equal(plantEstimate(2, 3, ["fern"]), 6);
  assert.equal(plantEstimate(2, 3, ["fern", "creepers"]), 12);
  assert.equal(plantEstimate(2, 3, ["ivy"]), 24);
  assert.equal(plantEstimate(2, 3, ["fern", "ivy"]), 24);
});

test("generated plant keys resolve to local GLBs only", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedPlantAsset(`plant-patch:${id}:12345`), {
    file: `/generated-plants/${id}/plants.glb`, bytes: 12345,
  });
  for (const key of [`plant-patch:${id}:0`, `plant-patch:${id}:9007199254740992`,
    "plant-patch:../../secret:123", `grass-patch:${id}:123`, "rock-1"])
    assert.equal(generatedPlantAsset(key), undefined);
});
