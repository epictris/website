// Depth maps of the reference against the scene (calibration, occlusion order,
// depth ranges) and reading the stored pictures. Tested here without the
// model; the model itself in e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import sharp from "sharp";
import {
  boundaryOrder,
  calibrate,
  type DepthMap,
  depthFromGrey,
  depthOrderIssues,
  depthRangeFor,
  depthToGrey16,
} from "../orthographic/src/core/depthmap";
import { fromDocument } from "../orthographic/src/core/document";
import { buildMesh } from "../orthographic/src/core/mesher";
import { decodePng, encodePng } from "../orthographic/src/core/png";
import { rasterize } from "../orthographic/src/core/raster";
import { projectPoint } from "../orthographic/src/core/raycast";
import type { DocVec3, EditorState, Part, Point, Vec3 } from "../orthographic/src/core/types";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => ({
  front: [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ],
  top: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
  side: [
    [y0, z0],
    [y1, z0],
    [y1, z1],
    [y0, z1],
  ],
});

/** A seeded generator, so the noise is the same every run. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("depth maps against the scene", () => {
  // Camera level at z 2, looking along +y: depth along the view axis is y + 10.
  const W = 400;
  const H = 300;
  const camera = {
    position: { x: 5, y: -10, z: 2 },
    target: { x: 5, y: 10, z: 2 },
    verticalFovDegrees: 40,
    frame: { width: W, height: H },
  };
  const image = { width: W, height: H };
  const meshOf = (e: { parts: Part[]; size: Vec3 }) => buildMesh(e.parts, e.size);
  const sceneWith = (objects: unknown[]): EditorState => {
    const r = fromDocument({
      format: "orthographic-scene",
      version: 1,
      scene: { size: { x: 10, y: 30, z: 10 }, scale: { basis: "test" } },
      objects,
      camera,
      references: { perspective: { image: "ref" } },
      images: { ref: { mimeType: "image/png", width: W, height: H, data: PNG_1PX } },
    });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    return r.state!;
  };
  // A in front of B, overlapping on screen; C and D apart from both.
  const scene = sceneWith([
    { id: "A", outlines: box(3, 5, 0, 1, 0, 3) },
    { id: "B", outlines: box(4, 8, 6, 7, 0, 4) },
    { id: "C", outlines: box(8.5, 9.5, 2, 3, 0, 1) },
    { id: "D", outlines: box(1, 2, 12, 13, 5, 6) },
  ]);
  const A = 2.5;
  const B = 0.3;
  /** The map a perfect model would give, value = A / depth + B, with a little noise. */
  const synthesise = (s: EditorState, value?: (id: string, depth: number) => number): DepthMap => {
    const r = rasterize(s.camera, s.objects, meshOf, W, H);
    const next = random(7);
    const values = new Float32Array(W * H);
    for (let j = 0; j < values.length; j++) {
      const id = r.ids[j] ? r.objects[r.ids[j] - 1] : "";
      // The background is far: 60 m.
      const depth = id ? r.depth[j] : 60;
      values[j] = (value ? value(id, depth) : A / depth + B) * (1 + (next() - 0.5) * 0.004);
    }
    return { width: W, height: H, values };
  };

  test("a map made from the scene calibrates to it: r² near 1, the scale and offset recovered, no issues", () => {
    const map = synthesise(scene);
    const c = calibrate(scene, meshOf, map, image)!;
    expect(c.objects.map((o) => o.id).sort()).toEqual(["A", "B", "C", "D"]);
    expect(c.r2).toBeGreaterThan(0.99);
    expect(Math.abs(c.a - A) / A).toBeLessThan(0.02);
    expect(Math.abs(c.b - B)).toBeLessThan(0.01);
    for (const o of c.objects) expect(Math.abs(o.estimatedDepth! - o.sceneDepth) / o.sceneDepth).toBeLessThan(0.03);
    expect(depthOrderIssues(scene, meshOf, map, image)).toEqual([]);
    // A and B meet, with A in front; the map agrees everywhere.
    const ab = boundaryOrder(scene, meshOf, map, image).find((p) => p.a === "A" && p.b === "B")!;
    expect(ab.samples).toBeGreaterThan(40);
    expect(ab.agree).toBe(ab.samples);
  });

  test("swapping two objects' values reports exactly that pair", () => {
    const map = synthesise(scene, (id, depth) => (id === "A" ? A / 17 + B : id === "B" ? A / 10.5 + B : A / depth + B));
    const issues = depthOrderIssues(scene, meshOf, map, image);
    expect(issues.map((i) => `${i.code} ${i.objectId} ${i.path}`)).toEqual(["depth-order A /objects/0"]);
    expect(issues[0].message).toContain("B");
  });

  test("fewer than three placed objects cannot calibrate", () => {
    const two = sceneWith([
      { id: "A", outlines: box(3, 5, 0, 1, 0, 3) },
      { id: "B", outlines: box(4, 8, 6, 7, 0, 4) },
    ]);
    expect(calibrate(two, meshOf, synthesise(two), image)).toBeNull();
  });

  test("the stored 16-bit picture keeps the order and the calibration", () => {
    const map = synthesise(scene);
    const back = depthFromGrey(W, H, depthToGrey16(map));
    const c = calibrate(scene, meshOf, back, image)!;
    expect(c.r2).toBeGreaterThan(0.99);
    for (const o of c.objects) expect(Math.abs(o.estimatedDepth! - o.sceneDepth) / o.sceneDepth).toBeLessThan(0.03);
  });

  /** The exact silhouette of a box: the hull of its projected corners. */
  const hull = (s: EditorState, lo: number[], hi: number[]) => {
    const corners = [0, 1, 2, 3, 4, 5, 6, 7]
      .map((k) => projectPoint(s.camera, [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]], W, H)!)
      .map((c) => [c[0], c[1]] as Point)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: Point[]) => {
      const out: Point[] = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      out.pop();
      return out;
    };
    return { points: [...half(corners), ...half([...corners].reverse())] };
  };
  const boxSeenFrom = (position: DocVec3, target: DocVec3) =>
    fromDocument({
      format: "orthographic-scene",
      version: 1,
      scene: { size: { x: 10, y: 30, z: 10 }, scale: { basis: "test" } },
      objects: [{ id: "box", outlines: box(3, 7, 5, 9, 0, 4) }],
      camera: { ...camera, position, target },
      references: { perspective: { image: "ref" } },
      images: { ref: { mimeType: "image/png", width: W, height: H, data: PNG_1PX } },
    }).state!;

  test("seen from above, a box's range runs from its front towards its back", () => {
    const s = boxSeenFrom({ x: 5, y: -10, z: 12 }, { x: 5, y: 7, z: 0 });
    const range = depthRangeFor(s, synthesise(s), { a: A, b: B }, hull(s, [3, 5, 0], [7, 9, 4]), image)!;
    expect(range.assumedThickness).toBeUndefined();
    expect(Math.abs(range.min - 5)).toBeLessThan(0.1);
    // The back edge is foreshortened and never reached exactly, but the top face is.
    expect(range.max).toBeGreaterThan(7.5);
    expect(range.max).toBeLessThan(9);
  });

  test("seen head on, only the front shows: half its smaller extent is assumed for the depth", () => {
    const s = boxSeenFrom({ x: 5, y: -10, z: 2 }, { x: 5, y: 10, z: 2 });
    const range = depthRangeFor(s, synthesise(s), { a: A, b: B }, hull(s, [3, 5, 0], [7, 9, 4]), image)!;
    expect(Math.abs(range.visible.min - 5)).toBeLessThan(0.1);
    expect(Math.abs(range.visible.max - 5)).toBeLessThan(0.1);
    // 4 m wide and 4 m tall at the front face.
    expect(Math.abs(range.assumedThickness! - 2)).toBeLessThan(0.05);
    expect(Math.abs(range.max - range.min - 2)).toBeLessThan(0.05);
  });
});

describe("reading depth pictures", () => {
  test("a 16-bit grey PNG decodes to exactly the values encoded", async () => {
    const [w, h] = [97, 61];
    const grey = Uint16Array.from({ length: w * h }, (_, i) => (i * 7919) % 65536);
    const png = await encodePng(w, h, { grey16: grey }, (d) => deflateSync(d));
    const out = (await decodePng(png, (d) => inflateSync(d)))!;
    expect([out.width, out.height, out.channels, out.bitDepth]).toEqual([w, h, 1, 16]);
    expect(out.samples).toEqual(grey);
  });

  test("every row filter decodes like sharp does", async () => {
    const [w, h] = [83, 47];
    const next = random(3);
    // Smooth gradients with noise, so the encoder picks a mix of filters.
    const rgb = Uint8Array.from(
      { length: w * h * 3 },
      (_, i) => ((i % (w * 3)) * 2 + Math.floor(i / (w * 3)) * 3 + next() * 40) & 255,
    );
    const png = new Uint8Array(
      await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
        .png({ adaptiveFiltering: true, compressionLevel: 9 })
        .toBuffer(),
    );
    const out = (await decodePng(png, (d) => inflateSync(d)))!;
    expect([out.channels, out.bitDepth]).toEqual([3, 8]);
    expect(Array.from(out.samples)).toEqual(Array.from(rgb));
  });

  test("each of the five row filters, applied by hand, decodes back", async () => {
    const [w, h, bpp] = [19, 10, 2];
    const next = random(11);
    const pixels = Uint8Array.from({ length: w * h * bpp }, () => Math.floor(next() * 256));
    const row = w * bpp;
    const raw = new Uint8Array((row + 1) * h);
    for (let y = 0; y < h; y++) {
      const filter = y % 5;
      raw[y * (row + 1)] = filter;
      for (let x = 0; x < row; x++) {
        const at = (yy: number, xx: number) => (yy >= 0 && xx >= 0 ? pixels[yy * row + xx] : 0);
        const [a, b, c] = [at(y, x - bpp), at(y - 1, x), at(y - 1, x - bpp)];
        const e = a + b - c;
        const paeth =
          Math.abs(e - a) <= Math.abs(e - b) && Math.abs(e - a) <= Math.abs(e - c)
            ? a
            : Math.abs(e - b) <= Math.abs(e - c)
              ? b
              : c;
        const predicted = [0, a, b, (a + b) >> 1, paeth][filter];
        raw[y * (row + 1) + 1 + x] = (pixels[y * row + x] - predicted) & 255;
      }
    }
    // A 16-bit grey header from the encoder, with these rows as its data (the decoder does not check CRCs).
    const header = (await encodePng(w, h, { grey16: new Uint16Array(w * h) }, (d) => deflateSync(d))).subarray(0, 33);
    const data = deflateSync(raw);
    const idat = new Uint8Array(12 + data.length);
    new DataView(idat.buffer).setUint32(0, data.length);
    idat.set([73, 68, 65, 84], 4);
    idat.set(data, 8);
    const png = new Uint8Array([...header, ...idat, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
    const out = (await decodePng(png, (d) => inflateSync(d)))!;
    const expected = Array.from({ length: w * h }, (_, i) => (pixels[i * 2] << 8) | pixels[i * 2 + 1]);
    expect(Array.from(out.samples)).toEqual(expected);
  });
});

test("without the model, estimate_depth says so instead of failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "orthographic-vision-"));
  try {
    const tools = new URL("../api/tools.ts", import.meta.url).pathname;
    const document = {
      format: "orthographic-scene",
      version: 1,
      scene: { size: { x: 10, y: 10, z: 10 }, scale: { basis: "test" } },
      objects: [],
      references: { perspective: { image: "ref" } },
      images: { ref: { mimeType: "image/png", width: 1, height: 1, data: PNG_1PX } },
    };
    const script = `
      const { callTool } = await import(${JSON.stringify(tools)});
      const ctx = { origin: "http://test" };
      const { sceneId } = await callTool("create_scene", { document: ${JSON.stringify(document)} }, ctx);
      const codes = [];
      codes.push((await callTool("estimate_depth", { sceneId }, ctx)).issues.map((i) => i.code).join());
      console.log(JSON.stringify(codes));`;
    const run = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, MODELS_DIR: join(dir, "none"), DATA_DIR: join(dir, "data") },
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual(["vision-unavailable"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
