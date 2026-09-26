import { test } from "node:test";
import assert from "node:assert/strict";
import { boulderSlabCount, validateBoulderRequest } from "../src/server/boulderGenerator.ts";
import { generatedBoulderAsset } from "../src/render3d/generatedBoulders.ts";

test("boulder requests accept one outline and reject invalid generation settings", () => {
  const valid = { polygon: [[0, 0], [2, 0], [1, 1]], seed: 31, depth: 1.6 };
  assert.deepEqual(validateBoulderRequest(valid), valid);
  for (const polygon of [[], [[0, 0], [1, 0]], [[0, 0], [NaN, 0], [1, 1]],
    [[0, 0], [101, 0], [1, 1]]])
    assert.throws(() => validateBoulderRequest({ ...valid, polygon }));
  assert.throws(() => validateBoulderRequest({ ...valid, seed: "31" }));
  assert.throws(() => validateBoulderRequest({ ...valid, depth: 6 }));
});

test("generated boulder keys resolve to local GLBs only", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedBoulderAsset(`boulder-v5:${id}:12345`), {
    file: `/generated-boulders/${id}/boulder.glb`, bytes: 12345,
  });
  for (const key of [`boulder-v5:${id}:0`, `boulder-v5:${id}:9007199254740992`,
    "boulder-v5:../../secret:123", "rock-1"])
    assert.equal(generatedBoulderAsset(key), undefined);
});

test("boulder fracture count follows polygon area in square metres", () => {
  assert.equal(boulderSlabCount(0.1), 2);
  assert.equal(boulderSlabCount(1), 10);
  assert.equal(boulderSlabCount(4), 40);
  assert.equal(boulderSlabCount(20), 100);
});
