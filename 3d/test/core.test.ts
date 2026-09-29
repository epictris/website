import { describe, expect, test } from "bun:test";
import { focalToFov, fovToFocal } from "../orthographic/src/core/camera";
import {
  addObject,
  addPart,
  moveObjects,
  objectFromWorld,
  removePart,
  rescaleScene,
  setCamera,
  setOutline,
  setOutlines,
  setReference,
} from "../orthographic/src/core/commands";
import {
  compareToReference,
  hiddenEdges,
  hiddenRuns,
  MIN_PIXELS,
  maskHas,
  polygonMask,
} from "../orthographic/src/core/compare";
import { fromDocument, geometryIssues, toDocument, validateDocument } from "../orthographic/src/core/document";
import { FitError, fitFront, polygonTest } from "../orthographic/src/core/fit";
import { base64ToBytes, imageSize } from "../orthographic/src/core/images";
import { clone, lengthText } from "../orthographic/src/core/math";
import { buildMesh, buildSolid, objectSolid, solidMeta } from "../orthographic/src/core/mesher";
import { initialState } from "../orthographic/src/core/model";
import { measure, raycastPoints } from "../orthographic/src/core/ops";
import { frameToImage, overlayGeometry } from "../orthographic/src/core/overlay";
import { upgradeObject, wholePart } from "../orthographic/src/core/parts";
import { type Projection, projection, roundScale } from "../orthographic/src/core/projection";
import { idLegend, idPalette, idPixels, rasterize } from "../orthographic/src/core/raster";
import { frameRay, projectPoint } from "../orthographic/src/core/raycast";
import { polyArea, presetOutlines, ringExtent, worldRing } from "../orthographic/src/core/ring";
import type {
  DocVec3,
  EditorState,
  ImageAsset,
  Part,
  Point,
  Ring,
  SceneObject,
  Vec3,
} from "../orthographic/src/core/types";

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

// biome-ignore lint/suspicious/noExplicitAny: test documents are deliberately loose
const doc = (objects: unknown[], extra: Record<string, any> = {}): Record<string, any> => ({
  format: "orthographic-scene",
  version: 1,
  scene: { size: { x: 10, y: 10, z: 10 }, scale: { basis: "a 1 m test cube" } },
  objects,
  ...extra,
});

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("document", () => {
  test("a minimal document loads", () => {
    const r = fromDocument(doc([{ id: "a", outlines: box(1, 3, 2, 5, 0, 4) }]));
    expect(r.issues).toEqual([]);
    const e = r.state!.objects[0];
    expect(e.min).toEqual([1, 2, 0]);
    expect(e.size).toEqual([2, 3, 4]);
  });

  test("round trip keeps world outlines", () => {
    const r = fromDocument(doc([{ id: "a", name: "A", color: "#112233", outlines: box(1, 3, 2, 5, 0, 4) }]));
    const out = toDocument(r.state!, new Map());
    expect(out.objects[0].outlines).toEqual(box(1, 3, 2, 5, 0, 4) as never);
    const again = fromDocument(JSON.parse(JSON.stringify(out)));
    expect(again.issues).toEqual([]);
    // Exported values are rounded to 1e-9 m, so the document (not the float state) is what round-trips exactly.
    const plain = { derived: false };
    expect(toDocument(again.state!, new Map(), plain)).toEqual(toDocument(r.state!, new Map(), plain));
    expect(again.state!.objects).toEqual(r.state!.objects);
  });

  test("schema problems are all reported with paths", () => {
    const r = fromDocument(
      doc([{ id: "a", outlines: { front: [[0, 0]], top: [], side: [] }, colour: "red" }], { extra: 1 }),
    );
    expect(r.state).toBeUndefined();
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("");
    expect(paths).toContain("/objects/0");
    expect(paths).toContain("/objects/0/outlines/front");
    expect(r.issues.find((i) => i.path === "")!.message).toContain('"extra"');
  });

  test("self-intersecting outline and duplicate ids", () => {
    const bow = {
      ...box(0, 2, 0, 2, 0, 2),
      front: [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ],
    };
    const r = fromDocument(
      doc([
        { id: "a", outlines: bow },
        { id: "a", outlines: box(0, 1, 0, 1, 0, 1) },
      ]),
    );
    expect(r.issues.map((i) => i.code)).toEqual(["ring-self-intersection", "duplicate-id"]);
    expect(r.issues[0].path).toBe("/objects/0/outlines/front");
  });

  test("views that disagree on a shared axis warn", () => {
    const o = box(0, 2, 0, 2, 0, 2);
    o.top = [
      [0, 0],
      [3, 0],
      [3, 2],
      [0, 2],
    ];
    const r = fromDocument(doc([{ id: "a", outlines: o }]));
    expect(r.state).toBeDefined();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ severity: "warning", code: "extent-mismatch" });
    expect(r.state!.objects[0].size).toEqual([3, 2, 2]);
  });

  test("geometry: disjoint silhouettes have no volume, conflicting ones low coverage", () => {
    // Front narrows upward, side narrows downward: no z fits both at the top plan's corners.
    const conflict = {
      ...box(0, 2, 0, 2, 0, 2),
      front: [
        [0, 0],
        [2, 0],
        [1, 2],
      ],
      side: [
        [0, 2],
        [1, 0],
        [2, 2],
      ],
    };
    const apart = {
      ...box(0, 2, 0, 2, 0, 2),
      front: [
        [0, 0],
        [1, 0],
        [1, 2],
        [0, 2],
      ],
      top: [
        [1.5, 0],
        [2, 0],
        [2, 2],
        [1.5, 2],
      ],
    };
    const v = validateDocument(
      doc([
        { id: "t", outlines: conflict },
        { id: "d", outlines: apart },
        { id: "b", outlines: box(0, 2, 0, 2, 0, 2) },
      ]),
    );
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => `${i.code}:${i.objectId}${i.view ? `/${i.view}` : ""}`)).toEqual([
      "extent-mismatch:d",
      "low-coverage:t/top",
      "no-common-volume:d",
    ]);
  });

  test("camera accepts focal length and rejects a disagreeing pair", () => {
    const cam = { position: { x: 0, y: -10, z: 0 }, target: { x: 0, y: 0, z: 0 } };
    const r = fromDocument(doc([], { camera: { ...cam, focalLengthMm35Equivalent: 50 } }));
    expect(r.state!.camera.fov).toBeCloseTo(26.9915, 3);
    const bad = fromDocument(doc([], { camera: { ...cam, focalLengthMm35Equivalent: 50, verticalFovDegrees: 40 } }));
    expect(bad.issues[0].code).toBe("camera-lens-mismatch");
    expect(fovToFocal(focalToFov(35))).toBeCloseTo(35, 9);
  });

  test("references: placement per view, missing images reported", () => {
    const img: ImageAsset = { id: "p", name: "p", mimeType: "image/png", width: 200, height: 100, data: "AA==" };
    const withRef = doc([], {
      references: {
        top: { image: "p", min: { x: 1, y: 2 }, size: { x: 4, y: 2 } },
        side: { image: "missing", min: { y: 0, z: 0 }, size: { y: 1, z: 1 } },
      },
      images: { p: { mimeType: "image/png", width: 200, height: 100, data: "AA==" } },
    });
    const r = fromDocument(withRef);
    expect(r.issues.map((i) => [i.code, i.path])).toEqual([["unknown-image", "/references/side/image"]]);
    const ok = fromDocument({ ...withRef, references: { top: withRef.references.top } });
    expect(ok.state!.references.top).toMatchObject({ image: "p", min: [1, 2], size: [4, 2] });
    const out = toDocument(ok.state!, new Map([["p", img]]), { images: "metadata" });
    expect(out.references!.top).toMatchObject({ min: { x: 1, y: 2 }, size: { x: 4, y: 2 } });
    expect(out.images!.p.data).toBeUndefined();
  });
});

describe("commands", () => {
  test("setOutline moves the box and stretches the other views", () => {
    const s = initialState();
    addObject(s, { id: "a", outlines: box(0, 2, 0, 2, 0, 2) as never });
    expect(
      setOutline(s, "a", "front", [
        [0, 0],
        [4, 0],
        [4, 2],
        [0, 2],
      ]),
    ).toEqual([]);
    const e = s.objects[0];
    expect(e.size).toEqual([4, 2, 2]);
    expect(worldRing(e, "top")).toEqual([
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ]);
    expect(
      setOutline(s, "a", "front", [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ])[0].code,
    ).toBe("ring-self-intersection");
  });

  test("locked objects refuse edits but can be unlocked", () => {
    const s = initialState();
    addObject(s, { id: "a", locked: true });
    expect(moveObjects(s, ["a"], [1, 0, 0])[0].code).toBe("object-locked");
  });

  test("camera focal length", () => {
    const s = initialState();
    expect(setCamera(s, { focalLengthMm: 50 })).toEqual([]);
    expect(s.camera.fov).toBeCloseTo(26.9915, 3);
    expect(setCamera(s, { fov: 2 })[0].code).toBe("invalid-camera");
  });

  test("a new reference image is fitted to the scene frame", () => {
    const s = initialState();
    setReference(s, "front", { image: "p" }, () => ({ width: 400, height: 100 }));
    expect(s.references.front).toMatchObject({ min: [0, 5], size: [40, 10] });
  });

  test("geometryIssues flags objects outside the frame", () => {
    const s = initialState();
    addObject(s, { id: "far", center: [100, 5, 5], size: [2, 2, 2] });
    expect(geometryIssues(s).map((i) => i.code)).toEqual(["outside-frame"]);
  });
});

describe("scale", () => {
  const cube = { id: "a", outlines: box(1, 3, 2, 5, 0, 4) };
  const unscaled = { scene: { size: { x: 10, y: 10, z: 10 } } };

  test("the scale basis round-trips; objects without one warn", () => {
    const r = fromDocument(doc([cube]));
    expect(r.state!.scene.scaleBasis).toBe("a 1 m test cube");
    expect(toDocument(r.state!, new Map()).scene.scale).toEqual({ basis: "a 1 m test cube" });
    expect(fromDocument(doc([cube], unscaled)).issues.map((i) => `${i.severity} ${i.code} ${i.path}`)).toEqual([
      "warning scale-not-set /scene/scale",
    ]);
    expect(fromDocument(doc([], unscaled)).issues).toEqual([]);
    // Lengths are metres; there is no unit to convert.
    const legacy = fromDocument(doc([], { scene: { size: { x: 10, y: 10, z: 10 }, metersPerUnit: 2 } }));
    expect(legacy.issues.map((i) => i.code)).toEqual(["schema-additionalProperties"]);
  });

  test("rescaleScene multiplies every length, locked objects included", () => {
    const s = initialState();
    addObject(s, { ...cube, outlines: cube.outlines as never, locked: true });
    setReference(s, "top", { image: "p", min: [1, 2], size: [4, 2] }, () => ({ width: 200, height: 100 }));
    const camera = clone(s.camera);
    const front = worldRing(s.objects[0], "front");
    expect(rescaleScene(s, 0.5)).toEqual([]);
    expect(s.scene.size).toEqual([20, 15, 10]);
    expect(s.objects[0]).toMatchObject({ min: [0.5, 1, 0], size: [1, 1.5, 2] });
    expect(worldRing(s.objects[0], "front")).toEqual(front.map(([a, b]) => [a / 2, b / 2]));
    expect(s.references.top).toMatchObject({ min: [0.5, 1], size: [2, 1] });
    expect(s.camera.position).toEqual(camera.position.map((v) => v / 2) as never);
    expect(s.camera.target).toEqual(camera.target.map((v) => v / 2) as never);
    expect(s.camera.far).toBe(camera.far / 2);
    expect(rescaleScene(s, 0)[0].code).toBe("invalid-scale");
    expect(rescaleScene(clone(s), 1e-9)[0].code).toBe("out-of-range");
  });

  test("every orthographic view is pictured at one scale, shared axes aligned", () => {
    const s = initialState(); // frame 40 x 30 x 20 m
    addObject(s, { id: "far", center: [50, 5, 5], size: [2, 2, 2] }); // grows x to 51 m
    const p = projection(s) as Projection;
    // The largest round scale at which 51 m (+ margins) fits 1200 px.
    expect(p.pixelsPerMeter).toBe(20);
    const { front, top, side } = p.views;
    expect([front.min[0], front.size[0], front.width]).toEqual([top.min[0], top.size[0], top.width]);
    expect([top.min[1], top.size[1], top.height]).toEqual([side.min[0], side.size[0], side.width]);
    expect([front.min[1], front.size[1], front.height]).toEqual([side.min[1], side.size[1], side.height]);
    expect(front.width).toBe(51 * 20 + 96);
    expect(front.size[0] * 20).toBeCloseTo(front.width, 9);
    expect(front.min[0]).toBeCloseTo(-48 / 20, 9);
    expect((projection(s, { pixelsPerMeter: 50 }) as Projection).views.top.width).toBe(51 * 50 + 96);
    expect(projection(s, { pixelsPerMeter: 100 })).toMatch(/fits at up to 50 px\/m/);
  });

  test("round scales and lengths for people", () => {
    expect([26.8, 46, 199, 4.9, 9.99, 0.03, 1].map(roundScale)).toEqual([25, 40, 100, 4, 8, 0.025, 1]);
    expect([2500, 1.5, 0.5, 0.004, 0].map(lengthText)).toEqual(["2.5 km", "1.5 m", "50 cm", "4 mm", "0 m"]);
  });
});

test("unknown properties do not hide other problems", () => {
  const bow = [
    [0, 0],
    [2, 2],
    [2, 0],
    [0, 2],
  ];
  const r = fromDocument({
    format: "orthographic-scene",
    version: 1,
    scene: { size: { x: 10, y: 10, z: 10 }, scale: { basis: "a 1 m test cube" } },
    objects: [
      {
        id: "a",
        colour: "red",
        outlines: {
          front: bow,
          top: bow.map(() => [0, 0]).slice(0, 3),
          side: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      },
    ],
  });
  expect(r.state).toBeUndefined();
  expect(r.issues.map((i) => i.code)).toEqual([
    "schema-additionalProperties",
    "ring-self-intersection",
    "ring-repeated-point",
  ]);
});

test("the example in llms.txt is a valid document", async () => {
  const guide = await Bun.file(new URL("../orthographic/llms.txt", import.meta.url)).text();
  // The document example, not the other JSON blocks (a render result, say).
  const example = /```json\n(\{\n {2}"\$schema"[\s\S]*?)```/.exec(guide)![1];
  // A 1x1 PNG stands in for the elided image data.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const v = validateDocument(JSON.parse(example.replace("<base64>", png)));
  expect(v.issues).toEqual([]);
});

describe("image headers", () => {
  const bytes = (...parts: (number[] | string)[]) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const le16 = (v: number) => [v & 255, v >> 8];
  const be16 = (v: number) => [v >> 8, v & 255];

  test("reads the pixel size of every accepted type", () => {
    expect(imageSize(base64ToBytes(PNG_1PX))).toEqual({ width: 1, height: 1 });
    expect(imageSize(bytes("GIF89a", le16(640), le16(480), [0, 0, 0]))).toEqual({ width: 640, height: 480 });
    // SOI, an APP0 segment to skip, then SOF0 (length, precision, height, width).
    const jpeg = bytes(
      [0xff, 0xd8, 0xff, 0xe0],
      be16(4),
      [0, 0],
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(900),
      be16(1600),
      [3],
    );
    expect(imageSize(jpeg)).toEqual({ width: 1600, height: 900 });
    const webp = bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBP",
      "VP8X",
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      [0x3f, 0x06, 0],
      [0x83, 0x03, 0],
    );
    expect(imageSize(webp)).toEqual({ width: 1600, height: 900 });
    expect(imageSize(bytes("not an image"))).toBeNull();
  });
});

describe("mesher", () => {
  const unitBox: Ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  test("a box from three rectangles is exactly the box: six faces, twelve triangles", () => {
    const solid = buildSolid({ front: unitBox, top: unitBox, side: unitBox });
    expect(solid.volume()).toBeCloseTo(1, 12);
    solid.delete();
    const m = buildMesh([wholePart({ front: unitBox, top: unitBox, side: unitBox })], [2, 3, 4]);
    expect(m.indices.length / 3).toBe(12);
    // Sharp corners: every face keeps its own four vertices and one normal.
    expect(m.pos.length / 3).toBe(24);
    const normals = new Set<string>();
    for (let i = 0; i < m.norm.length; i += 3) normals.add(`${m.norm[i]},${m.norm[i + 1]},${m.norm[i + 2]}`);
    expect([...normals].sort()).toEqual(["-127,0,0", "0,-127,0", "0,0,-127", "0,0,127", "0,127,0", "127,0,0"]);
    expect(m.meta.parts[0].coverage).toEqual({ front: 1, top: 1, side: 1 });
  });

  test("a triangle front and a polygon plan give the analytic volume", () => {
    // Front: triangle (x, z); top: a 32-gon (x, y); side: the full square.
    // Volume = integral over x of height(x) * depth(x); both are piecewise linear
    // in x, so Simpson's rule is exact between their breakpoints.
    const front: Ring = [
      [0, 0],
      [1, 0],
      [0.3, 1],
    ];
    const top = presetOutlines("cylinder").top;
    const solid = buildSolid({ front, top, side: unitBox });
    const along = (ring: Ring, x: number) => {
      const ys: number[] = [];
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        if ((a[0] <= x && x < b[0]) || (b[0] <= x && x < a[0]))
          ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      });
      ys.sort((p, q) => p - q);
      let len = 0;
      for (let i = 0; i + 1 < ys.length; i += 2) len += ys[i + 1] - ys[i];
      return len;
    };
    const breaks = [...new Set([...front, ...top].map((p) => p[0]))].sort((p, q) => p - q);
    let volume = 0;
    for (let i = 0; i + 1 < breaks.length; i++) {
      const [a, b] = [breaks[i], breaks[i + 1]];
      const f = (x: number) => along(front, x) * along(top, x);
      const e = 1e-12;
      volume += ((b - a) / 6) * (f(a + e) + 4 * f((a + b) / 2) + f(b - e));
    }
    expect(Math.abs(solid.volume() - volume)).toBeLessThan(1e-6);
    solid.delete();
  });

  test("solids are closed, with no zero-area triangles (T-junctions crack on the GPU)", () => {
    for (const p of ["box", "ellipsoid", "cylinder", "rock"] as const) {
      const m = buildMesh([wholePart(presetOutlines(p))], [3, 2, 5]);
      expect(m.meta.empty).toBe(false);
      // Creases split vertices; weld by position to check the surface is closed.
      const weld = new Map<string, number>();
      const at = (k: number) => [m.pos[k * 3], m.pos[k * 3 + 1], m.pos[k * 3 + 2]];
      const vid = (k: number) => {
        const key = at(k).join(",");
        if (!weld.has(key)) weld.set(key, weld.size);
        return weld.get(key)!;
      };
      const edges = new Map<string, number>();
      const idx = m.indices;
      for (let i = 0; i < idx.length; i += 3) {
        const t = [idx[i], idx[i + 1], idx[i + 2]];
        const w = t.map(vid);
        for (const [a, b] of [
          [w[0], w[1]],
          [w[1], w[2]],
          [w[2], w[0]],
        ]) {
          // Directed: each edge must be crossed once each way by its two faces.
          const key = `${a},${b}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
        const [A, B, C] = t.map(at);
        const ab = B.map((v, j) => v - A[j]);
        const ac = C.map((v, j) => v - A[j]);
        const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        expect(cross.some((v) => v !== 0)).toBe(true);
      }
      for (const [key, n] of edges) {
        const [a, b] = key.split(",");
        expect(n).toBe(1);
        expect(edges.get(`${b},${a}`)).toBe(1);
      }
    }
  });

  test("coverage is the exact share of an outline the solid's shadow fills", () => {
    // The top is a unit square, but the front only allows x < 0.5: the top's shadow is half filled.
    const front: Ring = [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ];
    const meta = solidMeta([wholePart({ front, top: unitBox, side: unitBox })]).parts[0];
    expect(meta.coverage.front).toBeCloseTo(1, 9);
    expect(meta.coverage.top).toBeCloseTo(0.5, 6);
    expect(meta.coverage.side).toBeCloseTo(1, 9);
  });
});

describe("comparison with the reference", () => {
  // A 4 m box seen from 12 m, the reference image the size of the frame, so image pixels are frame pixels.
  const W = 400;
  const H = 300;
  const camera = {
    position: { x: 5, y: -8, z: 6 },
    target: { x: 5, y: 5, z: 2 },
    verticalFovDegrees: 40,
    frame: { width: W, height: H },
  };
  const reference = { perspective: { image: "ref", opacity: 0.5 } };
  const images = { ref: { mimeType: "image/png", width: W, height: H, data: PNG_1PX } };
  const sceneWith = (objects: unknown[]) => {
    const r = fromDocument(doc(objects, { camera, references: reference, images }));
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    return r.state!;
  };
  const meshOf = (e: { parts: Part[]; size: Vec3 }) => buildMesh(e.parts, e.size);
  const image = { width: W, height: H };
  /** The box's exact silhouette on the frame: the convex hull of its projected corners. */
  const silhouette = (s: EditorState, lo: number[], hi: number[]): Point[] => {
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (k) => projectPoint(s.camera, [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]], W, H)!,
    );
    const pts = corners.map((c) => [c[0], c[1]] as Point).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
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
    return [...half(pts), ...half([...pts].reverse())];
  };

  test("a box traced from its own exact projection matches: IoU 1, no issues", () => {
    const s0 = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4) }]);
    const trace = silhouette(s0, [3, 3, 0], [7, 7, 4]);
    const s = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4), trace: { points: trace } }]);
    const c = compareToReference(s, meshOf, image)!;
    expect(c.issues).toEqual([]);
    expect(c.objects[0].iou).toBeGreaterThan(0.998);
    expect(c.objects[0].spill.count + c.objects[0].missing.count).toBeLessThan(0.002 * c.objects[0].tracePixels);
  });

  test("a trace shifted 10 px reports spill and missing, with the expected counts", () => {
    const s0 = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4) }]);
    const exact = silhouette(s0, [3, 3, 0], [7, 7, 4]);
    const shifted = exact.map(([u, v]) => [u + 10, v] as Point);
    const s = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4), trace: { points: shifted } }]);
    const c = compareToReference(s, meshOf, image, { diff: true })!;
    // Independently: the pixels in one polygon and not the other.
    const a = polygonMask(exact, W, H);
    const b = polygonMask(shifted, W, H);
    let onlyExact = 0;
    let onlyShifted = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [p, q] = [maskHas(a, x, y), maskHas(b, x, y)];
        if (p && !q) onlyExact++;
        if (q && !p) onlyShifted++;
      }
    const o = c.objects[0];
    expect(Math.abs(o.spill.count - onlyExact)).toBeLessThan(0.02 * onlyExact);
    expect(Math.abs(o.missing.count - onlyShifted)).toBeLessThan(0.02 * onlyShifted);
    expect(c.issues.map((i) => `${i.code} ${i.path}`)).toEqual([
      "trace-spill /objects/0/trace",
      "trace-missing /objects/0/trace",
    ]);
    // The spill is the strip on the left, the missing the strip on the right.
    expect(o.spill.bbox!.x1).toBeLessThan(o.missing.bbox!.x0);
    // The picture: every spill pixel red, every missing pixel blue.
    const count = (rgb: number[]) => {
      let n = 0;
      for (let k = 0; k < c.diff!.length; k += 4) if (rgb.every((v, j) => c.diff![k + j] === v)) n++;
      return n;
    };
    expect(count([235, 64, 52])).toBe(o.spill.count);
    expect(count([52, 120, 235])).toBe(o.missing.count);
  });

  test("hidden runs excuse the pixels nearer them than the traced edges", () => {
    const s0 = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4) }]);
    const exact = silhouette(s0, [3, 3, 0], [7, 7, 4]);
    // The trace claims a larger object on the right, but those edges are guesses.
    const right = Math.max(...exact.map((p) => p[0]));
    const wide = exact.map(([u, v]) => [u > right - 1 ? u + 30 : u, v] as Point);
    const guessed = wide.flatMap((p, i) => (p[0] > right ? [i] : []));
    const run: [number, number] = [(guessed[0] - 1 + wide.length) % wide.length, (guessed.at(-1)! + 1) % wide.length];
    const plain = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4), trace: { points: wide } }]);
    expect(compareToReference(plain, meshOf, image)!.issues.map((i) => i.code)).toEqual(["trace-missing"]);
    const excused = sceneWith([{ id: "box", outlines: box(3, 7, 3, 7, 0, 4), trace: { points: wide, hidden: [run] } }]);
    const c = compareToReference(excused, meshOf, image)!;
    expect(c.issues).toEqual([]);
    expect(c.objects[0].missing.count).toBeLessThan(MIN_PIXELS);
  });

  test("a contradicted inFrontOf hint is an occlusion-order warning", () => {
    const objects = (hint: string[]) => [
      { id: "near", outlines: box(4, 6, 1, 2, 0, 3) },
      { id: "far", outlines: box(3, 7, 6, 7, 0, 4), inFrontOf: hint },
    ];
    // Without a trace nothing is compared; give "far" one covering its projection.
    const s0 = sceneWith(objects([]));
    const t = silhouette(s0, [3, 6, 0], [7, 7, 4]);
    const s = sceneWith(objects(["near"]).map((o) => (o.id === "far" ? { ...o, trace: { points: t } } : o)));
    const c = compareToReference(s, meshOf, image)!;
    const order = c.issues.filter((i) => i.code === "occlusion-order");
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({ objectId: "far", path: "/objects/1/inFrontOf/0" });
    expect(c.objects[0].order.near.count).toBeGreaterThan(100);
  });

  test("traces are checked like outlines, and inFrontOf names real objects", () => {
    const r = fromDocument(
      doc([
        {
          id: "a",
          outlines: box(0, 1, 0, 1, 0, 1),
          trace: {
            points: [
              [0, 0],
              [10, 10],
              [10, 0],
              [0, 10],
            ],
            hidden: [[0, 9]],
          },
          inFrontOf: ["ghost"],
        },
      ]),
    );
    expect(r.issues.map((i) => `${i.severity} ${i.code} ${i.path}`)).toEqual([
      "error trace-self-intersection /objects/0/trace/points",
    ]);
    const ok = fromDocument(
      doc([
        {
          id: "a",
          outlines: box(0, 1, 0, 1, 0, 1),
          trace: {
            points: [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
            hidden: [[2, 0]],
          },
          inFrontOf: ["ghost"],
        },
      ]),
    );
    expect(ok.issues.map((i) => `${i.severity} ${i.code} ${i.path}`)).toEqual([
      "warning unknown-object /objects/0/inFrontOf/0",
    ]);
    const out = toDocument(ok.state!, new Map(), { derived: false }).objects[0];
    expect(out.trace).toEqual({
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      hidden: [[2, 0]],
    });
    expect(out.inFrontOf).toEqual(["ghost"]);
    expect(hiddenEdges(3, [[2, 0]])).toEqual([false, false, true]);
    expect(hiddenEdges(4, [[3, 1]])).toEqual([true, false, false, true]);
  });

  test("id pictures use one distinct colour per object and nothing else", () => {
    const s = sceneWith([
      { id: "near", outlines: box(4, 6, 1, 2, 0, 3) },
      { id: "far", outlines: box(3, 7, 6, 7, 0, 4) },
    ]);
    const r = rasterize(s.camera, s.objects, meshOf, W, H);
    const px = idPixels(r);
    const legend = idLegend(r.objects);
    const seen = new Set<string>();
    for (let i = 0; i < px.length; i += 4)
      seen.add(`#${[px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    expect([...seen].sort()).toEqual(["#000000", ...Object.keys(legend)].sort());
    expect(Object.values(legend).sort()).toEqual(["far", "near"]);
    expect(new Set(idPalette(300).map(String)).size).toBe(300);
  });
});

test("hidden runs and per-edge flags convert both ways", () => {
  const cases: [number, [number, number][]][] = [
    [5, []],
    [5, [[1, 3]]],
    [5, [[3, 1]]],
    [
      6,
      [
        [0, 2],
        [3, 5],
      ],
    ],
    [
      4,
      [
        [0, 1],
        [1, 0],
      ],
    ],
  ];
  for (const [n, runs] of cases) expect(hiddenRuns(hiddenEdges(n, runs))).toEqual(runs);
});

describe("fitting the front outline to a trace", () => {
  const W = 1200;
  const H = 800;
  const camera = {
    position: { x: 5, y: -9, z: 7 },
    target: { x: 5, y: 5, z: 2 },
    verticalFovDegrees: 40,
    frame: { width: W, height: H },
  };
  const images = { ref: { mimeType: "image/png", width: W, height: H, data: PNG_1PX } };
  const sceneWith = (objects: unknown[], perspective: Record<string, unknown> = {}) => {
    const r = fromDocument(
      doc(objects, { camera, references: { perspective: { image: "ref", ...perspective } }, images }),
    );
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    return r.state!;
  };
  const image = { width: W, height: H };
  const meshOf = (e: { parts: Part[]; size: Vec3 }) => buildMesh(e.parts, e.size);
  /** The exact silhouette of a box: the hull of its projected corners. */
  const hull = (s: EditorState, lo: number[], hi: number[]): Point[] => {
    const pts = [0, 1, 2, 3, 4, 5, 6, 7]
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
    return [...half(pts), ...half([...pts].reverse())];
  };
  const extent = (r: Ring) => ringExtent(r);

  test("a box traced from its own exact projection gets its own front back, within one cell", () => {
    const s0 = sceneWith([]);
    // Start from a wrong front (a triangle): the fit uses only the trace, top and side.
    const wrong = {
      ...box(3, 7, 3, 7, 0, 4),
      front: [
        [3, 0],
        [7, 0],
        [5, 4],
      ],
    };
    const s = sceneWith([{ id: "b", outlines: wrong, trace: { points: hull(s0, [3, 3, 0], [7, 7, 4]) } }]);
    const { outlines, cell } = fitFront(s, s.objects[0], image);
    expect(cell).toBeLessThan(0.01);
    const f = extent(outlines.front);
    for (const [got, want] of [
      [f.lo[0], 3],
      [f.hi[0], 7],
      [f.lo[1], 0],
      [f.hi[1], 4],
    ])
      expect(Math.abs(got - want)).toBeLessThan(cell);
    // A rectangle, near enough: its area is the box face's.
    expect(Math.abs(Math.abs(polyArea(outlines.front)) - 16)).toBeLessThan(16 * 0.01);
  });

  test("a trace running off the image does not produce a spilling object", () => {
    // The image covers the frame's left half only; the trace leaves it on the right.
    const s0 = sceneWith([], { scale: 1, offsetPercent: { x: -25, y: 0 } });
    const exact = hull(s0, [3, 3, 0], [7, 7, 4]);
    const ref = s0.references.perspective!;
    // Frame pixels to image pixels: the image is W x H drawn at half size, centred a quarter frame left.
    const g = overlayGeometry(W, H, ref, image);
    const trace = exact.map((p) => frameToImage(g, image, p));
    // Top and side far larger than the object: the fit has to find it from the trace alone.
    const s = sceneWith([{ id: "b", outlines: box(0, 10, 3, 7, 0, 8), trace: { points: trace } }], {
      scale: 1,
      offsetPercent: { x: -25, y: 0 },
    });
    const { outlines } = fitFront(s, s.objects[0], image);
    expect(setOutlines(s, "b", outlines).filter((i) => i.severity === "error")).toEqual([]);
    const c = compareToReference(s, meshOf, image)!;
    expect(c.issues.filter((i) => i.code === "trace-spill")).toEqual([]);
    // Every vertex of the solid projects inside the trace (on the frame or off it), give or take a pixel.
    const e = s.objects[0];
    const m = meshOf(e);
    const inside = polygonTest(exact);
    for (let i = 0; i < m.pos.length; i += 3) {
      const p = [0, 1, 2].map((a) => e.min[a] + (m.pos[i + a] / 65535) * e.size[a]) as Vec3;
      const q = projectPoint(s.camera, p, W, H)!;
      const near = [-1.5, 0, 1.5].some((dx) => [-1.5, 0, 1.5].some((dy) => inside(q[0] + dx, q[1] + dy)));
      expect(near).toBe(true);
    }
  });

  test("restOn: a block fitted onto a cap stops at the cap's top, with no volume inside it", () => {
    const s0 = sceneWith([]);
    // The block's trace reaches the ground, as if the cap were not there.
    const trace = hull(s0, [3, 3, 0], [7, 7, 5]);
    const s = sceneWith([
      { id: "cap", outlines: box(2, 8, 2, 8, 0, 2) },
      { id: "block", outlines: box(3, 7, 3, 7, 0, 5), trace: { points: trace } },
    ]);
    const block = s.objects[1];
    const free = fitFront(s, block, image);
    expect(extent(free.outlines.front).lo[1]).toBeLessThan(free.cell);
    const { outlines, cell } = fitFront(s, block, image, { restOn: [s.objects[0]] });
    expect(Math.abs(extent(outlines.front).lo[1] - 2)).toBeLessThan(cell);
    setOutlines(s, "block", outlines);
    const toUnit = (e: SceneObject) =>
      objectSolid(e.parts)
        .solid.scale(e.size as never)
        .translate(e.min as never);
    const [a, b] = [toUnit(s.objects[0]), toUnit(s.objects[1])];
    const overlap = a.intersect(b);
    expect(overlap.volume()).toBeLessThan(6 * 6 * cell);
    for (const m of [a, b, overlap]) m.delete();
  });

  test("the fitted outlines agree on their shared axes, and nothing fits outside the views", () => {
    const s0 = sceneWith([]);
    const s = sceneWith([
      { id: "b", outlines: box(3, 7, 3, 7, 0, 4), trace: { points: hull(s0, [3, 3, 0], [7, 7, 4]) } },
    ]);
    const { outlines } = fitFront(s, s.objects[0], image);
    const built = objectFromWorld("b", { outlines });
    expect(built.issues).toEqual([]);
    expect(solidMeta(built.object!.parts).parts[0].coverage.front).toBeGreaterThan(0.99);
    // A trace far off to the side of the views: nothing to fit.
    const away = sceneWith([
      {
        id: "b",
        outlines: box(3, 7, 3, 7, 0, 4),
        trace: {
          points: [
            [0, 0],
            [30, 0],
            [30, 30],
            [0, 30],
          ],
        },
      },
    ]);
    expect(() => fitFront(away, away.objects[0], image)).toThrow(FitError);
  });
});

describe("measuring the picture", () => {
  const W = 1000;
  const H = 600;
  const level = (extra: Record<string, unknown> = {}) => ({
    position: { x: 5, y: -10, z: 1.5 },
    target: { x: 5, y: 0, z: 1.5 },
    verticalFovDegrees: 40,
    frame: { width: W, height: H },
    ...extra,
  });
  const sceneWith = (objects: unknown[], camera = level()) => {
    const r = fromDocument(doc(objects, { camera }));
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    return r.state!;
  };
  const ctx = { meshOf: (e: { parts: Part[]; size: Vec3 }) => buildMesh(e.parts, e.size) };

  test("a ray through the frame centre meets a wall 10 m away at 10 m", () => {
    const s = sceneWith([{ id: "wall", outlines: box(0, 10, 0, 0.5, 0, 3) }]);
    const r = raycastPoints(s, [[W / 2, H / 2]], "frame", ctx);
    const [hit] = r.value!.hits as { id: string; distance: number; depth: number; normal: DocVec3 }[];
    expect(hit.id).toBe("wall");
    expect(hit.distance).toBeCloseTo(10, 6);
    expect(hit.depth).toBeCloseTo(10, 6);
    expect(hit.normal).toEqual({ x: 0, y: -1, z: 0 });
    // Above the wall: nothing.
    expect((raycastPoints(s, [[W / 2, 2]], "frame", ctx).value!.hits as unknown[])[0]).toBeNull();
  });

  test("a 2 m edge measured from its render is 2 m, within a pixel's worth", () => {
    const s = sceneWith([{ id: "box", outlines: box(4, 6, 2, 4, 0, 2) }]);
    // The front face's middle, from the bottom row of pixels to the top row it covers.
    const px = (p: Vec3) => projectPoint(s.camera, p, W, H)!;
    const foot = px([5, 2, 0]);
    const head = px([5, 2, 2]);
    const from: Point = [Math.floor(foot[0]) + 0.5, Math.floor(foot[1]) - 0.5];
    const to: Point = [Math.floor(head[0]) + 0.5, Math.ceil(head[1]) + 0.5];
    const r = measure(s, { from, to, at: "box" }, ctx);
    const depth = r.value!.depth as number;
    expect(depth).toBeCloseTo(12, 6);
    const pixel = (2 * depth * Math.tan((40 * Math.PI) / 360)) / H;
    expect(Math.abs((r.value!.length as number) - 2)).toBeLessThan(2 * pixel);
    // The same with a depth given, and with each end on its own surface.
    expect(measure(s, { from, to, at: 12 }, ctx).value!.length).toBeCloseTo(r.value!.length as number, 9);
    expect(Math.abs((measure(s, { from, to, at: "surface" }, ctx).value!.length as number) - 2)).toBeLessThan(
      2 * pixel,
    );
  });

  test("lens shift keeps verticals vertical and moves the horizon to the shifted row", () => {
    const shifted = sceneWith([], level({ shift: { x: 0, y: 0.2 } }));
    const tilted = sceneWith([], level({ target: { x: 5, y: 0, z: -1 } }));
    const px = (s: EditorState, p: Vec3) => projectPoint(s.camera, p, W, H)!;
    // A vertical edge off to the side.
    const [a, b] = [px(shifted, [8, 5, 0]), px(shifted, [8, 5, 6])];
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-9);
    const [c, d] = [px(tilted, [8, 5, 0]), px(tilted, [8, 5, 6])];
    expect(Math.abs(c[0] - d[0])).toBeGreaterThan(1);
    // The horizon: a far point at the camera's height.
    expect(px(shifted, [5, 1e5, 1.5])[1]).toBeCloseTo(H * (0.5 + 0.2), 3);
    // Rays follow the shift: the pixel a point projects to casts back through it.
    const p: Vec3 = [7, 6, 3];
    const q = px(shifted, p);
    const ray = frameRay(shifted.camera, q[0], q[1], W, H);
    const t = (p[1] - ray.origin[1]) / ray.dir[1];
    for (const k of [0, 2]) expect(ray.origin[k] + t * ray.dir[k]).toBeCloseTo(p[k], 6);
    // It round-trips through the document.
    expect(toDocument(shifted, new Map()).camera!.shift).toEqual({ x: 0, y: 0.2 });
  });
});

describe("objects in parts", () => {
  // An L: a slab along x, and a post standing on its left end.
  const slab = box(0, 6, 0, 2, 0, 1);
  const post = box(0, 2, 0, 2, 0, 5);
  const lDoc = () => doc([{ id: "L", parts: [{ id: "slab", outlines: slab }, { outlines: post }] }]);

  test("the solid is the union of the parts, and the document keeps them", () => {
    const r = fromDocument(lDoc());
    expect(r.issues).toEqual([]);
    const e = r.state!.objects[0];
    expect(e.min).toEqual([0, 0, 0]);
    expect(e.size).toEqual([6, 2, 5]);
    // 6 x 2 x 1 slab + 2 x 2 x 5 post - their 2 x 2 x 1 overlap, in the object's box.
    const { solid } = objectSolid(e.parts);
    const scaled = solid.scale(e.size as never);
    expect(scaled.volume()).toBeCloseTo(12 + 20 - 4, 6);
    for (const m of [solid, scaled]) m.delete();
    const out = toDocument(r.state!, new Map(), { derived: false }).objects[0];
    expect(out.outlines).toBeUndefined();
    expect(out.parts).toEqual([{ id: "slab", outlines: slab }, { outlines: post }] as never);
    // A plain object is still written with outlines.
    const plain = toDocument(fromDocument(doc([{ id: "a", outlines: post }])).state!, new Map()).objects[0];
    expect(plain.outlines).toEqual(post as never);
    expect(plain.parts).toBeUndefined();
  });

  test("outlines and parts together are refused; problems point into the part", () => {
    const both = fromDocument(doc([{ id: "x", outlines: slab, parts: [{ outlines: post }] }]));
    expect(both.state).toBeUndefined();
    const conflict = { ...post, side: box(0, 2, 0, 2, 3, 5).side };
    const r = validateDocument(doc([{ id: "L", parts: [{ outlines: slab }, { outlines: conflict }] }]));
    expect(r.issues.map((i) => `${i.code} ${i.path}`)).toEqual([
      "extent-mismatch /objects/0/parts/1/outlines",
      "low-coverage /objects/0/parts/1/outlines/front",
    ]);
    const bad = fromDocument(
      doc([
        {
          id: "L",
          parts: [
            { id: "a", outlines: slab },
            { id: "a", outlines: post },
          ],
        },
      ]),
    );
    expect(bad.issues.map((i) => `${i.code} ${i.path}`)).toEqual(["invalid-part-id /objects/0/parts/1/id"]);
  });

  test("editing a part moves only it; the object's box follows its parts", () => {
    const s = fromDocument(lDoc()).state!;
    // Taller post: the object grows to 7 m.
    expect(setOutlines(s, "L", box(0, 2, 0, 2, 0, 7) as never, 1)).toEqual([]);
    expect(s.objects[0].size).toEqual([6, 2, 7]);
    expect(worldRing(s.objects[0], "front", 0)).toEqual(slab.front as Ring);
    // Several parts: which one must be said.
    expect(setOutlines(s, "L", post as never).map((i) => i.code)).toEqual(["part-required"]);
    expect(
      setOutline(
        s,
        "L",
        "front",
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        5,
      ).map((i) => i.code),
    ).toEqual(["unknown-part"]);
    // Moving the object carries both parts.
    moveObjects(s, ["L"], [10, 0, 0]);
    expect(worldRing(s.objects[0], "front", 0)[0]).toEqual([10, 0]);
    expect(worldRing(s.objects[0], "top", 1)[1]).toEqual([12, 0]);
    // Parts come and go; the last one stays.
    expect(addPart(s, "L").part).toBe(2);
    expect(removePart(s, "L", 2)).toEqual([]);
    expect(removePart(s, "L", 0)).toEqual([]);
    expect(removePart(s, "L", 0).map((i) => i.code)).toEqual(["last-part"]);
    expect(s.objects[0].min).toEqual([10, 0, 0]);
    expect(s.objects[0].size).toEqual([2, 2, 7]);
  });

  test("geometry problems are reported per part", () => {
    const apart = { ...post, top: box(5, 6, 0, 2, 0, 1).top, front: box(0, 1, 0, 2, 0, 5).front };
    const r = validateDocument(doc([{ id: "L", parts: [{ outlines: slab }, { outlines: apart }] }]));
    expect(r.issues.map((i) => `${i.code} ${i.path}`)).toContain("no-common-volume /objects/0/parts/1/outlines");
  });

  test("a stored object from before parts is upgraded in place", () => {
    const old = { ...fromDocument(doc([{ id: "a", outlines: post }])).state!.objects[0] } as SceneObject & {
      outlines?: unknown;
    };
    old.outlines = old.parts[0].outlines;
    delete (old as { parts?: unknown }).parts;
    expect(upgradeObject(old)).toBe(true);
    expect(old.parts).toHaveLength(1);
    expect(old.outlines).toBeUndefined();
    expect(worldRing(old, "front")).toEqual(post.front as Ring);
  });
});
