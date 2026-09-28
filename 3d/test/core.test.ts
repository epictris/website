import { describe, expect, test } from "bun:test";
import { focalToFov, fovToFocal } from "../orthographic/src/core/camera";
import { addObject, moveObjects, setCamera, setOutline, setReference } from "../orthographic/src/core/commands";
import { fromDocument, geometryIssues, toDocument, validateDocument } from "../orthographic/src/core/document";
import { base64ToBytes, imageSize } from "../orthographic/src/core/images";
import { buildMesh } from "../orthographic/src/core/mesher";
import { initialState } from "../orthographic/src/core/model";
import { presetOutlines, worldRing } from "../orthographic/src/core/ring";
import type { ImageAsset } from "../orthographic/src/core/types";

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
  scene: { size: { x: 10, y: 10, z: 10 } },
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
    // Exported values are rounded to 1e-9 u, so the document (not the float state) is what round-trips exactly.
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
    scene: { size: { x: 10, y: 10, z: 10 } },
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
  const example = /```json\n([\s\S]*?)```/.exec(guide)![1];
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
  test("solids are closed, with no zero-area triangles (T-junctions crack on the GPU)", () => {
    for (const p of ["box", "ellipsoid", "cylinder", "rock"] as const) {
      const m = buildMesh(presetOutlines(p), 40);
      const edges = new Map<string, number>();
      const idx = m.indices;
      const at = (k: number) => [m.pos[k * 3], m.pos[k * 3 + 1], m.pos[k * 3 + 2]];
      for (let i = 0; i < idx.length; i += 3) {
        const t = [idx[i], idx[i + 1], idx[i + 2]];
        for (const [a, b] of [
          [t[0], t[1]],
          [t[1], t[2]],
          [t[2], t[0]],
        ]) {
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
        const [A, B, C] = t.map(at);
        const ab = B.map((v, j) => v - A[j]);
        const ac = C.map((v, j) => v - A[j]);
        const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        expect(cross.some((v) => v !== 0)).toBe(true);
      }
      expect([...edges.values()].every((n) => n === 2)).toBe(true);
    }
  });
});
