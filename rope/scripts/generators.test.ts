// The generator service's own cases, run by `bun run generators:check`: request
// validation and keys (rewritten from the fork's boulder-generator.test.mjs,
// mushroom-generator.test.mjs and generator-failure.test.mjs), the schemas, the
// GLB triangle count, and the queue - one at a time, supersede, cancel, failure
// - against a stand-in "python" that behaves like rockgen.py without Blender.
// The fork's slab-count cases live in tools/blender/boulders/test_params.py,
// since the count is derived in Python now.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boulder } from "../src/server/generators/boulder";
import { generatorFailure } from "../src/server/generators/failure";
import { glbTriangles } from "../src/server/generators/glb";
import { mushrooms, soupArea } from "../src/server/generators/mushrooms";
import type { Tools } from "../src/server/generators/paths";
import { BAKE_MARKER } from "../src/server/generators/run";
import { loadSchema, mergeParams, validateParams } from "../src/server/generators/schema";
import { GeneratorService, KEY, type Status } from "../src/server/generators/service";

const ROOT = dirname(import.meta.dir);
const boulderSchema = loadSchema(ROOT, "boulders");
const mushroomSchema = loadSchema(ROOT, "mushrooms");

describe("schemas", () => {
  for (const schema of [boulderSchema, mushroomSchema])
    test(`${schema.kind}: every default passes its own validation`, () => {
      const defaults = mergeParams(schema, {});
      expect(() => validateParams(schema, defaults)).not.toThrow();
      expect(new Set(schema.params.map((p) => p.key)).size).toBe(schema.params.length);
      for (const p of schema.params) expect(schema.groups).toContain(p.group);
    });
});

describe("boulder requests", () => {
  const valid = { outline: [[0, 0], [2, 0], [1, 1]] };
  const check = (input: unknown, params: unknown = {}) =>
    boulder.validateInput(input, mergeParams(boulderSchema, validateParams(boulderSchema, params)));

  test("accept one outline and reject invalid ones", () => {
    expect(check(valid)).toEqual(valid);
    for (const outline of [[], [[0, 0], [1, 0]], [[0, 0], [NaN, 0], [1, 1]], [[0, 0], [101, 0], [1, 1]]])
      expect(() => check({ outline })).toThrow();
    expect(() => check({ outline: [[0, 0], [1, 0], [2, 0]] })).toThrow(/zero area/);
  });

  test("reject invalid generation settings", () => {
    expect(() => check(valid, { seed: "31" })).toThrow(/whole number/);
    expect(() => check(valid, { seed: 1.5 })).toThrow(/whole number/);
    expect(() => check(valid, { depth: 6 })).toThrow(/between 0.02 and 5 m/);
    expect(() => check(valid, { bakeSize: 3000 })).toThrow(/one of/);
    expect(() => check(valid, { color: [0.1, 0.2] })).toThrow(/linear RGB/);
    expect(() => check(valid, { nope: 1 })).toThrow(/not a boulder parameter/);
    expect(() => check(valid, [])).toThrow(/object/);
    // Blank tolerance is the derived one.
    expect(() => check(valid, { tolerance: null, seed: 7, depth: 2 })).not.toThrow();
  });
});

describe("mushroom requests", () => {
  // A 1 m square on level ground, as two triangles in the three.js frame.
  const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];
  const check = (input: unknown, params: unknown = {}) =>
    mushrooms.validateInput(input, mergeParams(mushroomSchema, validateParams(mushroomSchema, params)));

  test("the triangle soup's area is in square metres", () => {
    expect(soupArea(square)).toBe(1);
    expect(soupArea([0, 0, 0, 2, 0, 0, 0, 3, 0])).toBe(3);
  });

  test("accept a surface and reject invalid settings", () => {
    expect(check({ positions: square }, { seed: 3, density: 150, height: 0.16, clumping: 0.75, detail: 0.3 })).toEqual({ positions: square });
    for (const positions of [[], square.slice(0, 8), [...square.slice(0, 8), NaN], [...square.slice(0, 8), 101]])
      expect(() => check({ positions })).toThrow();
    expect(() => check({ positions: square }, { seed: 1.5 })).toThrow();
    expect(() => check({ positions: square }, { density: 0 })).toThrow();
    expect(() => check({ positions: square }, { height: 3 })).toThrow();
    expect(() => check({ positions: square }, { clumping: 2 })).toThrow();
    expect(() => check({ positions: square }, { detail: -1 })).toThrow();
    // 4 m² at 1000 per m² is past what the exact overlap pass bakes interactively.
    expect(() => check({ positions: square.map((n) => n * 2) }, { density: 1000 })).toThrow(/lower the density/);
    // A sliver has no area to grow on.
    expect(() => check({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0] })).toThrow();
    // The limits are parameters too.
    expect(() => check({ positions: square }, { maxTriangles: 1 })).toThrow(/Select 1-1 faces/);
  });
});

test("mesh keys are a generator and 16 hex digits, nothing else", () => {
  for (const key of ["boulder:0123456789abcdef", "mushrooms:ffffffffffffffff"]) expect(KEY.test(key)).toBe(true);
  for (const key of [
    "boulder:0123456789ABCDEF", "boulder:0123456789abcde", "boulder:0123456789abcdef0",
    "boulder-v5:c81013ad-0aa9-4301-a6de-e766c5f7c81b:12345", "boulder:../../secret", "rock-1", "moss:0123456789abcdef",
  ])
    expect(KEY.test(key)).toBe(false);
});

describe("generator failures", () => {
  // Shaped like a real boulder v5 validation failure: verdicts on stdout,
  // Blender deprecation warnings and a Python traceback on stderr.
  const stdout = ["Building boulder...", "boulder: FAIL; outline 0.06912140; front edge 0.030931; nonmanifold 0",
    "Validation failed. Inspect output/validation.json."].join("\n");
  const stderr = ["/repo/blender_build.py:543: DeprecationWarning: 'Material.use_nodes' is expected to be removed in Blender 6.0",
    "  baked.use_nodes=True", "Traceback (most recent call last):", '  File "/repo/rockgen.py", line 321, in main',
    "subprocess.CalledProcessError: Command '[...validate.py...]' returned non-zero exit status 1."].join("\n");

  test("lead with the validator verdicts and drop warnings", () => {
    const message = generatorFailure("Boulder generation", stdout, stderr, "exit 1", "/tmp/scratch");
    expect(message.split("\n").slice(0, 3)).toEqual([
      "Boulder generation failed.",
      "boulder: FAIL; outline 0.06912140; front edge 0.030931; nonmanifold 0",
      "Output kept in /tmp/scratch",
    ]);
    expect(message).not.toContain("DeprecationWarning");
    expect(message).not.toContain("baked.use_nodes");
    expect(message.endsWith("returned non-zero exit status 1.")).toBe(true);
  });

  test("cut a long tail on whole lines", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const tail = generatorFailure("Dirt and moss generation", "", long, "", "/tmp/scratch").split("\n").slice(2);
    expect(tail.every((line) => /^line \d+ x{20}$/.test(line))).toBe(true);
    expect(tail.at(-1)).toBe(`line 199 ${"x".repeat(20)}`);
    expect(tail.join("\n").length).toBeLessThanOrEqual(1200);
  });

  test("mushrooms say their own refusal", () => {
    expect(mushrooms.failure("MUSHROOMS: no mushrooms fit this surface", "", "exit 1", "/tmp/x")).toBe("no mushrooms fit this surface");
  });
});

// A GLB of `triangles` indexed triangles, JSON chunk only (no buffer is read).
function fakeGlb(triangles: number): Uint8Array {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    accessors: [{ count: triangles * 3 }, { count: 4 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    nodes: [{ mesh: 0 }],
  });
  // Chunks are 4-byte aligned, the JSON one padded with spaces.
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, " ");
  const bytes = new Uint8Array(20 + padded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(new TextEncoder().encode(padded), 20);
  return bytes;
}

test("triangles are counted from the GLB's accessors", () => {
  expect(glbTriangles(fakeGlb(7612))).toBe(7612);
  expect(() => glbTriangles(new Uint8Array(24))).toThrow(/not a GLB/);
});

describe("the queue", () => {
  // A scratch project: the real schemas, an empty public/, and a stand-in for
  // rockgen.py that reads its behaviour from the request's seed: seed 1 sleeps,
  // 2 prints the bake marker then sleeps, 3 fails its validation, else quick.
  const root = mkdtempSync(join(tmpdir(), "generators-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["boulders", "mushrooms"]) {
    mkdirSync(join(root, "tools", "blender", dir), { recursive: true });
    cpSync(join(ROOT, "tools", "blender", dir, "params.json"), join(root, "tools", "blender", dir, "params.json"));
  }
  const glb = join(root, "fake.glb");
  writeFileSync(glb, fakeGlb(12));
  const python = join(root, "fake-python");
  writeFileSync(
    python,
    `#!/bin/sh
# $1 rockgen.py, $2 request.json, $3 --output, $4 out
seed=$(sed -n 's/.*"seed":\\([0-9]*\\).*/\\1/p' "$2")
mkdir -p "$4/models"
case "$seed" in
  1) sleep 3 ;;
  2) echo "${BAKE_MARKER}"; sleep 1 ;;
  3) echo "boulder: FAIL; outline 0.07"; echo "Traceback" >&2; exit 1 ;;
esac
cp "${glb}" "$4/models/boulder.glb"
`,
  );
  chmodSync(python, 0o755);
  const tools: Tools = { python, blender: "/bin/true", venv: false };
  const service = new GeneratorService(root, () => {}, () => tools);
  const outline = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const key = (n: number) => `boulder:${n.toString(16).padStart(16, "0")}`;
  const submit = (n: number, seed: number, object?: string) =>
    service.submit({ kind: "boulder", key: key(n), input: { outline }, params: { seed }, object });
  const settle = async (k: string): Promise<Status> => {
    for (let i = 0; i < 100; i++) {
      const s = service.status(k)!;
      if (s.state !== "queued" && s.state !== "running") return s;
      await Bun.sleep(50);
    }
    throw new Error(`${k} never settled`);
  };

  test("bad requests are refused before anything runs", () => {
    const refuse = (body: unknown, pattern: RegExp) => expect(() => service.submit(body)).toThrow(pattern);
    refuse({ kind: "moss", key: "moss:0123456789abcdef", input: {} }, /boulder or mushrooms/);
    refuse({ kind: "boulder", key: "mushrooms:0123456789abcdef", input: { outline } }, /key must be boulder:/);
    refuse({ kind: "boulder", key: "boulder:xyz", input: { outline } }, /key must be/);
    refuse({ kind: "boulder", key: key(1), input: { outline }, params: { depth: 9 } }, /between/);
    refuse({ kind: "boulder", key: key(1), input: { outline: [[0, 0]] } }, /3-128/);
    // Raising a Min past the default Max is caught against the merged values.
    refuse({ kind: "boulder", key: key(1), input: { outline }, params: { chunkDepthScaleMin: 1.3 } }, /chunkDepthScaleMin \(1.3\) must not be above chunkDepthScaleMax \(1.2\)/);
    refuse({ kind: "mushrooms", key: "mushrooms:0000000000000001", input: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1] }, params: { sizeMin: 0.8, sizeMax: 0.5 } }, /sizeMin/);
  });

  test("one job runs at a time, and each lands under its key", async () => {
    expect(submit(10, 1)).toEqual({ key: key(10), state: "running" });
    expect(submit(11, 0)).toEqual({ key: key(11), state: "queued" });
    expect((await settle(key(10))).state).toBe("done");
    const done = await settle(key(11));
    expect(done).toMatchObject({ state: "done", triangles: 12 });
    expect(existsSync(join(root, "public", "generated", "boulder", key(11).slice(8), "mesh.glb"))).toBe(true);
    // Asking again is free: the directory answers.
    expect(submit(11, 0)).toEqual({ key: key(11), state: "done" });
  });

  test("a newer request for the same object supersedes a running job before its bake", async () => {
    submit(20, 1, "rock-a");
    await Bun.sleep(200);
    submit(21, 0, "rock-a");
    expect((await settle(key(20))).state).toBe("superseded");
    expect((await settle(key(21))).state).toBe("done");
    expect(existsSync(join(root, "public", "generated", "boulder", key(20).slice(8)))).toBe(false);
  });

  test("a job past its bake is left to finish", async () => {
    submit(30, 2, "rock-b");
    await Bun.sleep(400);
    submit(31, 0, "rock-b");
    expect((await settle(key(30))).state).toBe("done");
    expect((await settle(key(31))).state).toBe("done");
  });

  test("cancel stops a queued or running job", async () => {
    submit(40, 1);
    submit(41, 0);
    expect(service.cancel(key(41))!.state).toBe("superseded");
    await Bun.sleep(200);
    service.cancel(key(40));
    expect((await settle(key(40))).state).toBe("superseded");
  });

  test("a failure reports the validator verdicts", async () => {
    submit(50, 3);
    const failed = await settle(key(50));
    expect(failed.state).toBe("failed");
    expect(failed.message).toContain("boulder: FAIL; outline 0.07");
    const kept = /Output kept in (.*)/.exec(failed.message!)![1]!;
    expect(existsSync(join(kept, "request.json"))).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });

  test("a missing tool is said at once", () => {
    const bare = new GeneratorService(root, () => {}, () => ({ python: null, blender: null, venv: false }));
    expect(() => bare.submit({ kind: "boulder", key: key(60), input: { outline } })).toThrow(/No Python found/);
    expect(() =>
      bare.submit({ kind: "mushrooms", key: "mushrooms:0000000000000060", input: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1] } }),
    ).toThrow(/No Blender found/);
  });
});
