// The generator service's own cases, run by `bun run generators:check`: request
// validation and keys (rewritten from the fork's boulder-generator.test.mjs,
// mushroom-generator.test.mjs and generator-failure.test.mjs), the GLB triangle
// count, and the queue - one at a time, supersede, cancel, failure - against a
// stand-in "python" that behaves like rockgen.py without Blender. Every request
// carries the key `generatedKey` makes of it, as the editor's will.
// The fork's slab-count cases live in tools/blender/boulders/test_params.py,
// since the count is derived in Python. The schemas themselves are held by the
// `generator:` cases of `cli render3d`.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSchema, mergeDefaults, type ParamValues } from "../src/level/generatorParams";
import { generatedKey, type GeneratorInput, type MushroomsInput } from "../src/render3d/generated";
import { generatorFailure } from "../src/server/generators/failure";
import { glbTriangles } from "../src/server/generators/glb";
import { mushrooms, soupArea } from "../src/server/generators/mushrooms";
import type { Tools } from "../src/server/generators/paths";
import { BAKE_MARKER } from "../src/server/generators/run";
import { BODY_LIMIT, GeneratorService, HttpError, keyOfPath, readBody, type Status } from "../src/server/generators/service";

const keyOf = (kind: "boulder" | "mushrooms", input: GeneratorInput, params: ParamValues = {}) =>
  generatedKey(kind, loadSchema(kind)!.version, input, params);

// A 1 m square on level ground, as two triangles in the three.js frame.
const square = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];
const loop: MushroomsInput = {
  loop: [[0, 0, 0], [1, 0, 0], [1, 0, 1]],
  host: { kind: "primitive", mesh: "", outline: [[0, 0], [1, 0], [1, 1]], frame: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] },
};

test("the triangle soup's area is in square metres", () => {
  expect(soupArea(square)).toBe(1);
  expect(soupArea([0, 0, 0, 2, 0, 0, 0, 3, 0])).toBe(3);
});

describe("mushroom input", () => {
  const values = (params: ParamValues = {}) => mergeDefaults(params, loadSchema("mushrooms")!);
  const check = (soup: unknown, params: ParamValues = {}, input: unknown = loop) =>
    mushrooms.validateInput(input, soup, values(params));

  test("accepts a loop, a host and a soup; the key input is the loop and host alone", () => {
    const ok = check(square);
    expect(ok).toEqual({ key: loop, soup: square });
    expect(mushrooms.keyInput(ok)).toBe(loop);
    expect(mushrooms.sidecars(ok)).toEqual({ "input.json": { soup: square } });
  });

  test("rejects a bad soup, loop or host", () => {
    for (const soup of [undefined, [], square.slice(0, 8), [...square.slice(0, 8), NaN], [...square.slice(0, 8), 101]])
      expect(() => check(soup)).toThrow(/faces within 100 metres/);
    // 4 m² at 1000 per m² is past what the exact overlap pass bakes interactively.
    expect(() => check(square.map((n) => n * 2), { density: 1000 })).toThrow(/lower the density/);
    // A sliver has no area to grow on.
    expect(() => check([0, 0, 0, 1, 0, 0, 2, 0, 0])).toThrow(/zero area/);
    // The limits are parameters too.
    expect(() => check(square, { maxTriangles: 1 })).toThrow(/Select 1-1 faces/);
    expect(() => check(square, {}, { ...loop, loop: [[0, 0, 0]] })).toThrow(/input.loop/);
    expect(() => check(square, {}, { ...loop, host: { kind: "mesh", mesh: "rock-1" } })).toThrow(/input.host/);
  });
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

describe("the service", () => {
  // A scratch project root with an empty public/, and stand-ins for Python and
  // Blender that write a GLB. The Python reads its behaviour from the last digit
  // of the request's seed: 1 sleeps, 2 prints the bake marker then sleeps, 3
  // fails its validation, else quick. Every request it is handed is appended to
  // requests.log, one per line, so a case can read what the generator saw.
  const root = mkdtempSync(join(tmpdir(), "generators-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const glb = join(root, "fake.glb");
  writeFileSync(glb, fakeGlb(12));
  const python = join(root, "fake-python");
  const requests = join(root, "requests.log");
  writeFileSync(
    python,
    `#!/bin/sh
# $1 rockgen.py, $2 request.json, $3 --output, $4 out
seed=$(sed -n 's/.*"seed":\\([0-9]*\\).*/\\1/p' "$2")
{ cat "$2"; echo; } >> "${requests}"
mkdir -p "$4/models"
case "$((seed % 10))" in
  1) sleep 3 ;;
  2) echo "${BAKE_MARKER}"; sleep 1 ;;
  3) echo "boulder: FAIL; outline 0.07"; echo "Traceback" >&2; exit 1 ;;
esac
cp "${glb}" "$4/models/boulder.glb"
`,
  );
  const blender = join(root, "fake-blender");
  // editor_patch.py's arguments end "--spec <file> --out <dir>".
  writeFileSync(blender, `#!/bin/sh\nfor last; do :; done\nmkdir -p "$last"\ncp "${glb}" "$last/mushrooms.glb"\n`);
  chmodSync(python, 0o755);
  chmodSync(blender, 0o755);
  const tools: Tools = { python, blender, venv: false };
  const service = new GeneratorService(root, () => {}, () => tools);
  const outline: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const rock = (seed: number, object?: string) => {
    const params = { seed };
    return { kind: "boulder", key: keyOf("boulder", { outline }, params), input: { outline }, params, object };
  };
  const submit = (seed: number, object?: string) => service.submit(rock(seed, object));
  const keyFor = (seed: number) => rock(seed).key;
  const settle = async (k: string): Promise<Status> => {
    for (let i = 0; i < 100; i++) {
      const s = service.status(k)!;
      if (s.state !== "queued" && s.state !== "running") return s;
      await Bun.sleep(50);
    }
    throw new Error(`${k} never settled`);
  };
  const refuse = (body: unknown, pattern: RegExp) => expect(() => service.submit(body)).toThrow(pattern);
  const withParams = (params: Record<string, unknown>) => ({
    kind: "boulder", key: keyOf("boulder", { outline }, params as ParamValues), input: { outline }, params,
  });
  const pinned = { outline: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] as [number, number][] };
  const mkey = keyOf("mushrooms", loop);

  test("the key must be the one its content makes", () => {
    // Pinned by the format phase's cases in cli render3d.
    const params = { seed: 7, depth: 1.2 };
    expect(keyOf("boulder", pinned, params)).toBe("boulder:c82bc75873f0956b");
    refuse({ kind: "boulder", key: "boulder:0123456789abcdef", input: pinned, params },
      /The key boulder:0123456789abcdef does not match its content, which makes boulder:c82bc75873f0956b/);
    // Defaults, unrounded noise and key order make the same key.
    expect(service.submit({ kind: "boulder", key: "boulder:c82bc75873f0956b", input: pinned,
      params: { depth: 1.20000001, seed: 7, weathering: 0.38 } }).key).toBe("boulder:c82bc75873f0956b");
    // A mushroom patch's key covers the loop and host, not the soup.
    expect(service.submit({ kind: "mushrooms", key: mkey, input: loop, soup: square }).key).toBe(mkey);
    expect(service.submit({ kind: "mushrooms", key: mkey, input: loop, soup: square.map((n) => n * 0.5) }).key).toBe(mkey);
    refuse({ kind: "mushrooms", key: mkey, input: { ...loop, loop: [[0, 0, 0], [1, 0, 0], [1, 0, 2]] }, soup: square }, /does not match/);
  });

  test("bad requests are refused before anything runs", () => {
    refuse({ kind: "moss", key: "moss:0123456789abcdef", input: {} }, /boulder or mushrooms/);
    refuse({ kind: "boulder", key: "mushrooms:0123456789abcdef", input: { outline } }, /key must be boulder:/);
    refuse({ kind: "boulder", key: "boulder:xyz", input: { outline } }, /key must be/);
    refuse({ kind: "boulder", key: "boulder:0123456789ABCDEF", input: { outline } }, /key must be/);
    refuse({ ...withParams({}), params: [] }, /params must be an object/);
    refuse(withParams({ depth: 9 }), /depth: 9 is outside 0.02..5/);
    refuse(withParams({ seed: "31" }), /seed: must be an integer/);
    refuse(withParams({ seed: 1.5 }), /seed: must be an integer/);
    refuse(withParams({ bakeSize: 3000 }), /bakeSize: 3000 is not one of/);
    refuse(withParams({ color: [0.1, 0.2] }), /color: must be a linear RGB triple/);
    refuse(withParams({ nope: 1 }), /nope: unknown parameter for boulder/);
    refuse({ ...withParams({}), input: { outline: [[0, 0]] } }, /3-128/);
    refuse({ ...withParams({}), input: { outline: [[0, 0], [1, 0], [2, 0]] } }, /zero area/);
    // Raising a Min past the default Max is caught against the merged values.
    refuse(withParams({ chunkDepthScaleMin: 1.3 }), /chunkDepthScaleMin: 1.3 is above chunkDepthScaleMax \(1.2\)/);
    const sizes = { sizeMin: 0.8, sizeMax: 0.5 };
    refuse({ kind: "mushrooms", key: keyOf("mushrooms", loop, sizes), input: loop, soup: square, params: sizes }, /sizeMin/);
    refuse({ kind: "mushrooms", key: keyOf("mushrooms", loop, { density: 0 }), input: loop, soup: square, params: { density: 0 } },
      /density: 0 is outside/);
  });

  test("a blank tolerance is the derived one, and makes the default's key", () => {
    expect(service.submit({ ...withParams({}), params: { tolerance: null, seed: 5 },
      key: keyOf("boulder", { outline }, { seed: 5 }) }).key).toBe(keyFor(5));
  });

  test("one job runs at a time, and each lands under its key with its meta", async () => {
    await Promise.all(["boulder:c82bc75873f0956b", mkey, keyFor(5)].map(settle));
    expect(submit(101)).toEqual({ key: keyFor(101), state: "running" });
    expect(submit(100)).toEqual({ key: keyFor(100), state: "queued" });
    expect((await settle(keyFor(101))).state).toBe("done");
    expect(await settle(keyFor(100))).toMatchObject({ state: "done", triangles: 12 });
    const dir = join(root, "public", "generated", "boulder", keyFor(100).slice(8));
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ key: keyFor(100), kind: "boulder", version: 1, params: { seed: 100 }, input: { outline }, triangles: 12 });
    expect(existsSync(join(dir, "input.json"))).toBe(false);
    // Asking again is free: the directory answers.
    expect(submit(100)).toEqual({ key: keyFor(100), state: "done" });
  });

  test("a patch's meta holds its key input, and the soup sits beside it", () => {
    const dir = join(root, "public", "generated", "mushrooms", mkey.slice(10));
    expect(service.status(mkey)!.state).toBe("done");
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).input).toEqual(loop);
    // The first soup submitted is the one generated; the second found it queued.
    expect(JSON.parse(readFileSync(join(dir, "input.json"), "utf8"))).toEqual({ soup: square });
  });

  test("a newer request for the same object supersedes a running job before its bake", async () => {
    submit(201, "rock-a");
    await Bun.sleep(200);
    submit(200, "rock-a");
    expect((await settle(keyFor(201))).state).toBe("superseded");
    expect((await settle(keyFor(200))).state).toBe("done");
    expect(existsSync(join(root, "public", "generated", "boulder", keyFor(201).slice(8)))).toBe(false);
  });

  test("a job past its bake is left to finish", async () => {
    submit(302, "rock-b");
    await Bun.sleep(400);
    submit(300, "rock-b");
    expect((await settle(keyFor(302))).state).toBe("done");
    expect((await settle(keyFor(300))).state).toBe("done");
  });

  test("cancel stops a queued or running job", async () => {
    submit(401);
    submit(400);
    expect(service.cancel(keyFor(400))!.state).toBe("superseded");
    await Bun.sleep(200);
    service.cancel(keyFor(401));
    expect((await settle(keyFor(401))).state).toBe("superseded");
  });

  test("a failure reports the validator verdicts", async () => {
    submit(503);
    const failed = await settle(keyFor(503));
    expect(failed.state).toBe("failed");
    expect(failed.message).toContain("boulder: FAIL; outline 0.07");
    const kept = /Output kept in (.*)/.exec(failed.message!)![1]!;
    expect(existsSync(join(kept, "request.json"))).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });

  test("a job two objects wait on runs on until neither does", async () => {
    // A rock duplicated mid-generation: the copy asks for the same key, then
    // moves on to another. The original still waits, so the job runs on for it.
    submit(701, "rock-c");
    await Bun.sleep(200);
    expect(submit(701, "rock-d")).toEqual({ key: keyFor(701), state: "running" });
    submit(704, "rock-d");
    expect(service.status(keyFor(701))!.state).toBe("running");
    expect((await settle(keyFor(701))).state).toBe("done");
    expect((await settle(keyFor(704))).state).toBe("done");
  });

  test("a job is superseded once every object waiting on it has moved on", async () => {
    submit(811, "rock-e");
    submit(811, "rock-f");
    await Bun.sleep(200);
    submit(814, "rock-e");
    expect(service.status(keyFor(811))!.state).toBe("running");
    submit(815, "rock-f");
    expect((await settle(keyFor(811))).state).toBe("superseded");
    expect((await settle(keyFor(814))).state).toBe("done");
    expect((await settle(keyFor(815))).state).toBe("done");
  });

  test("the generator is handed the parameters the key hashed (rounded), not the request's", async () => {
    // 1.20004 m and 1.2 m share a key, so they must build the same mesh.
    const params = { seed: 906, depth: 1.20004 };
    const key = keyOf("boulder", { outline }, params);
    expect(key).toBe(keyOf("boulder", { outline }, { seed: 906, depth: 1.2 }));
    service.submit({ kind: "boulder", key, input: { outline }, params });
    expect((await settle(key)).state).toBe("done");
    const seen = readFileSync(requests, "utf8").split("\n").filter((l) => l.includes('"seed":906')).map((l) => JSON.parse(l));
    expect(seen.length).toBe(1);
    expect(seen[0].params).toEqual({ depth: 1.2, seed: 906 });
  });

  test("a malformed key escape is a 400, not a 500", () => {
    expect(keyOfPath("/boulder%3A00000000000000aa")).toBe("boulder:00000000000000aa");
    for (const bad of ["/%E0%A4%A", "/%", "/boulder:xyz"]) {
      let status = 0;
      try {
        keyOfPath(bad);
      } catch (e) {
        status = (e as HttpError).status;
      }
      expect(status).toBe(400);
    }
  });

  test("a body is decoded once, so a character split across chunks survives", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "moss é ü 苔" }));
    // Cut inside the three-byte character.
    const at = bytes.length - 4;
    async function* chunks() {
      yield bytes.slice(0, at);
      yield bytes.slice(at);
    }
    expect(await readBody(chunks())).toEqual({ name: "moss é ü 苔" });
    let status = 0;
    try {
      await readBody(chunks(), 10);
    } catch (e) {
      status = (e as HttpError).status;
    }
    expect(status).toBe(413);
  });

  test("the body limit holds the largest soup the schema allows", () => {
    const max = loadSchema("mushrooms")!.params.find((p) => p.key === "maxTriangles")!.max!;
    // Every number at the widest the editor sends it: "-99.9999,".
    const widest = 9 * max * "-99.9999,".length;
    expect(BODY_LIMIT).toBeGreaterThan(widest + 100_000);
  });

  test("a missing tool is said at once", () => {
    const bare = new GeneratorService(root, () => {}, () => ({ python: null, blender: null, venv: false }));
    expect(() => bare.submit(rock(600))).toThrow(/No Python found/);
    const other = { ...loop, loop: [[0, 0, 0], [2, 0, 0], [2, 0, 2]] as [number, number, number][] };
    expect(() => bare.submit({ kind: "mushrooms", key: keyOf("mushrooms", other), input: other, soup: square })).toThrow(/No Blender found/);
  });
});
