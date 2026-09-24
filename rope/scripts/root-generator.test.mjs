import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRootRequest } from "../src/server/rootGenerator.ts";
import { generatedRootAsset } from "../src/render3d/generatedRoots.ts";

const valid = { polygon: [[0,0], [2,0], [1,1]], seed: 1234, depth: 0.38 };
test("root requests reject invalid geometry and unsafe generation sizes", () => {
  assert.deepEqual(validateRootRequest(valid), valid);
  for (const polygon of [null, [], [[0,0],[1,0]], [[0,0],[1,0],[NaN,1]],
    [[0,0],[1,0],[101,1]], [[0,0],[1,0],["1",1]], Array(129).fill([0,0])]) {
    assert.throws(() => validateRootRequest({ ...valid, polygon }));
  }
  for (const depth of [0, -1, NaN, 6, "0.38"])
    assert.throws(() => validateRootRequest({ ...valid, depth }));
  for (const seed of [-1, 1.5, NaN, 2147483648, "1"])
    assert.throws(() => validateRootRequest({ ...valid, seed }));
});
test("saved mesh keys resolve locally and cannot address arbitrary files", () => {
  const id = "c81013ad-0aa9-4301-a6de-e766c5f7c81b";
  assert.deepEqual(generatedRootAsset(`root:${id}:12345`), {
    file: `/generated-roots/${id}/roots_LOD0.glb`, bytes: 12345,
  });
  for (const key of ["rock-1", "root:../../secret:123", `root:${id}:0`,
    `root:${id}:9007199254740992`, `root:${id}:12?url=http://elsewhere`])
    assert.equal(generatedRootAsset(key), undefined);
});
