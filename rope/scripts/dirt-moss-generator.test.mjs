import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDirtMossRequest } from "../src/server/dirtMossGenerator.ts";
import { generatedDirtMossAsset } from "../src/render3d/generatedDirtMoss.ts";

test("dirt and moss requests validate outline and coverage", () => {
  const valid = { polygon: [[0, 0], [2, 0], [1, 1]], seed: 31, depth: 1.6, moss: 0.28 };
  assert.deepEqual(validateDirtMossRequest(valid), valid);
  for (const polygon of [[], [[0, 0], [1, 0]], [[0, 0], [NaN, 0], [1, 1]],
    [[0, 0], [101, 0], [1, 1]]])
    assert.throws(() => validateDirtMossRequest({ ...valid, polygon }));
  for (const moss of [-0.01, 1.01, NaN, "0.5"])
    assert.throws(() => validateDirtMossRequest({ ...valid, moss }));
  assert.throws(() => validateDirtMossRequest({ ...valid, seed: "31" }));
  assert.throws(() => validateDirtMossRequest({ ...valid, depth: 6 }));
});

test("generated dirt and moss keys resolve to local GLBs only", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedDirtMossAsset(`dirt-moss:${id}:12345`), {
    file: `/generated-dirt-moss/${id}/dirt.glb`, bytes: 12345,
  });
  for (const key of [`dirt-moss:${id}:0`, `dirt-moss:${id}:9007199254740992`,
    "dirt-moss:../../secret:123", "rock-1"])
    assert.equal(generatedDirtMossAsset(key), undefined);
});
