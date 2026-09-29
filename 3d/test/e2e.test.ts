// End to end: the built editor served by server.ts, its HTTP API, and the page
// driven in headless Chromium the way a person or an agent would use it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { fromDocument } from "../orthographic/src/core/document";
import { buildMesh } from "../orthographic/src/core/mesher";
import { encodePng } from "../orthographic/src/core/png";
import { rasterize } from "../orthographic/src/core/raster";
import { projectPoint } from "../orthographic/src/core/raycast";
import { type Primitive, presetOutlines } from "../orthographic/src/core/ring";
import { VIEWS } from "../orthographic/src/core/views";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 3290 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}/orthographic`;
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p))!;

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
/** A primitive's outlines in metres, filling min .. min + size. */
const primitive = (type: Primitive, min: number[], size: number[]) => {
  const p = presetOutlines(type);
  return Object.fromEntries(
    (["front", "top", "side"] as const).map((v) => {
      const [a, b] = VIEWS[v].axes;
      return [v, p[v].map(([u, w]) => [min[a] + u * size[a], min[b] + w * size[b]])];
    }),
  );
};
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Width and height from a PNG's IHDR chunk. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const scene = {
  format: "orthographic-scene",
  version: 1,
  scene: { size: { x: 20, y: 20, z: 10 }, scale: { basis: "the slab is a 20 m square" } },
  objects: [
    { id: "block", color: "#efc875", outlines: box(2, 8, 2, 8, 0, 6) },
    { id: "slab", outlines: box(0, 20, 0, 20, 0, 1) },
  ],
  references: { front: { image: "px", min: { x: 0, z: 0 }, size: { x: 20, z: 10 } } },
  images: { px: { mimeType: "image/png", width: 1, height: 1, data: PNG_1PX } },
};

const DATA_DIR = mkdtempSync(join(tmpdir(), "orthographic-e2e-"));
let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const build = Bun.spawnSync(["bunx", "vite", "build", "--logLevel", "error"], { cwd: ROOT });
  if (build.exitCode) throw new Error(build.stderr.toString());
  server = Bun.spawn(["bun", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (
    let i = 0;
    i < 50 &&
    !(await fetch(`${BASE}/`)
      .then((r) => r.ok)
      .catch(() => false));
    i++
  )
    await Bun.sleep(100);
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    env,
    args: ["--no-sandbox", "--ozone-platform=headless", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on("pageerror", (e) => {
    throw e;
  });
  await page.goto(`${BASE}/`);
  await page.waitForFunction("window.orthographic !== undefined");
}, 30000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const tool = async <T = Record<string, unknown>>(name: string, args: unknown) =>
  (await (await fetch(`${BASE}/api/tools/${name}`, { method: "POST", body: JSON.stringify(args) })).json()) as T & {
    ok: boolean;
    issues: { code: string; path: string; severity: string }[];
  };

describe("HTTP", () => {
  test("serves the editor, the guide and the schema", async () => {
    expect((await fetch(`${BASE}/`)).headers.get("content-type")).toContain("text/html");
    expect(await (await fetch(`${BASE}/llms.txt`)).text()).toContain("# Orthographic Studio");
    expect((await (await fetch(`${BASE}/schema.json`)).json()).$id).toBe("https://3d.tris.sh/orthographic/schema.json");
    expect((await fetch(`${BASE}/../etc/passwd`)).status).toBe(404);
  });

  test("validate reports every problem with a path", async () => {
    const bad = structuredClone(scene) as Record<string, unknown> & typeof scene;
    (bad.objects[0] as Record<string, unknown>).colour = "red";
    bad.objects[1].outlines.front = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
    ];
    const r = await (await fetch(`${BASE}/api/validate`, { method: "POST", body: JSON.stringify(bad) })).json();
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: { code: string; path: string }) => `${i.code} ${i.path}`)).toEqual([
      "schema-additionalProperties /objects/0",
      "ring-self-intersection /objects/1/outlines/front",
    ]);
  });

  test("render returns a PNG per view", async () => {
    const res = await fetch(`${BASE}/api/render`, {
      method: "POST",
      body: JSON.stringify({ document: scene, views: ["top", "perspective"], width: 400, height: 300 }),
    });
    const r = await res.json();
    expect(r.issues).toEqual([]);
    expect(Object.keys(r.images)).toEqual(["top", "perspective"]);
    for (const url of Object.values(r.images) as string[]) expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const png = await fetch(`${BASE}/api/render/front.png?width=300&height=200`, {
      method: "POST",
      body: JSON.stringify(scene),
    });
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer()).subarray(1, 4)).toEqual(new TextEncoder().encode("PNG"));
  }, 30000);

  test("orthographic renders share one scale and say where they lie", async () => {
    const r = await (
      await fetch(`${BASE}/api/render`, {
        method: "POST",
        body: JSON.stringify({ document: scene, views: ["front", "top", "side"], pixelsPerMeter: 20 }),
      })
    ).json();
    expect(r.issues).toEqual([]);
    expect(r.pixelsPerMeter).toBe(20);
    // The 20 x 20 x 10 m frame plus a 48 px (2.4 m) margin on every side.
    expect(r.placements).toEqual({
      front: { min: { x: -2.4, z: -2.4 }, size: { x: 24.8, z: 14.8 }, width: 496, height: 296 },
      top: { min: { x: -2.4, y: -2.4 }, size: { x: 24.8, y: 24.8 }, width: 496, height: 496 },
      side: { min: { y: -2.4, z: -2.4 }, size: { y: 24.8, z: 14.8 }, width: 496, height: 296 },
    });
    for (const v of ["front", "top", "side"])
      expect(pngSize(Buffer.from(r.images[v].split(",")[1], "base64"))).toEqual([
        r.placements[v].width,
        r.placements[v].height,
      ]);
    const png = await fetch(`${BASE}/api/render/top.png?pixelsPerMeter=20`, {
      method: "POST",
      body: JSON.stringify(scene),
    });
    expect(png.headers.get("x-pixels-per-meter")).toBe("20");
    expect(JSON.parse(png.headers.get("x-placement")!)).toEqual({
      min: { x: -2.4, y: -2.4 },
      size: { x: 24.8, y: 24.8 },
    });
    const huge = await (
      await fetch(`${BASE}/api/render`, {
        method: "POST",
        body: JSON.stringify({ document: scene, views: ["front"], pixelsPerMeter: 1000 }),
      })
    ).json();
    expect(huge.issues.map((i: { code: string }) => i.code)).toEqual(["render-too-large"]);
  }, 30000);
});

const api = <T = unknown>(f: string) =>
  page.evaluate(`(async () => { const o = window.orthographic; ${f} })()`) as Promise<T>;

describe("editor", () => {
  test("the page API loads, edits and undoes", async () => {
    expect(await api<unknown[]>(`return (await o.loadDocument(${JSON.stringify(scene)})).issues`)).toEqual([]);
    const moved = await api<{ ok: boolean }>('return o.setBounds("block", { max: { x: 10 } })');
    expect(moved.ok).toBe(true);
    expect(await api<number[]>("return o.getDocument().objects[0].outlines.top[1]")).toEqual([10, 2]);
    await api("o.undo()");
    expect(await api<number[]>("return o.getDocument().objects[0].outlines.top[1]")).toEqual([8, 2]);
    const refused = await api<{ ok: boolean; issues: { code: string }[] }>(
      'return o.setOutline("block", "side", [[0,0],[1,1],[1,0],[0,1]])',
    );
    expect(refused.issues[0].code).toBe("ring-self-intersection");
  });

  test("dragging an outline vertex edits the object in every view", async () => {
    await api(`await o.loadDocument(${JSON.stringify(scene)})`);
    await page.keyboard.press("v");
    const centre = async (selector: string, index = 0) =>
      page.$$eval(
        selector,
        (els, i) => {
          const r = els[i].getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2];
        },
        index,
      );
    const [bx, by] = await centre('.view-panel.front path.feature-hit[data-id="block"]');
    await page.mouse.click(bx, by);
    // Vertex 2 is the top-right corner (8, 6); drag it up and right.
    const [vx, vy] = await centre(".view-panel.front .vertex-handle", 2);
    await page.mouse.move(vx, vy);
    await page.mouse.down();
    await page.mouse.move(vx + 20, vy - 20, { steps: 4 });
    await page.mouse.up();
    const doc = await api<{
      objects: { outlines: Record<string, number[][]>; derived: { max: Record<string, number> } }[];
    }>("return o.getDocument()");
    const block = doc.objects[0];
    expect(block.derived.max.x).toBeGreaterThan(8);
    expect(block.derived.max.z).toBeGreaterThan(6);
    // The top view stretched to the new x extent.
    expect(Math.max(...block.outlines.top.map((p) => p[0]))).toBeCloseTo(block.derived.max.x, 9);
  });

  test("a trace is drawn, and its points dragged, in the perspective view", async () => {
    const img = await api<{ id: string }>(`return o.addImage({ data: "${PNG_1PX}", name: "px.png" })`);
    const doc = {
      ...scene,
      camera: {
        position: { x: 10, y: -14, z: 8 },
        target: { x: 10, y: 10, z: 3 },
        verticalFovDegrees: 36,
        frame: { width: 800, height: 450 },
      },
      references: { perspective: { image: img.id, opacity: 0.5 } },
      images: undefined,
    };
    expect((await api<{ ok: boolean }>(`return o.loadDocument(${JSON.stringify(doc)})`)).ok).toBe(true);
    await api('o.select(["block"])');
    await page.keyboard.press("v");
    const gate = await page.$eval("#pGate", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // Draw: three corners, then Enter. A 1 px reference is fitted to the frame, one image pixel covering it all.
    await page.$$eval("button", (els) =>
      (els.find((b) => b.textContent === "Draw trace") as HTMLButtonElement).click(),
    );
    for (const [fx, fy] of [
      [0.3, 0.8],
      [0.7, 0.8],
      [0.5, 0.2],
    ])
      await page.mouse.click(gate.x + fx * gate.w, gate.y + fy * gate.h);
    await page.keyboard.press("Enter");
    const traced = await api<{ points: number[][] }>(
      'return o.getDocument().objects.find((e) => e.id === "block").trace',
    );
    expect(traced.points).toHaveLength(3);
    // The 1 x 1 image is drawn letterboxed at the frame's height: pixel (0.5, 0.5) is the frame's centre.
    expect(traced.points[2][0]).toBeCloseTo(0.5, 1);
    expect(traced.points[2][1]).toBeCloseTo(0.2, 1);
    // Drag the third point down; the trace follows, as one undo step.
    const [hx, hy] = await page.$$eval(".trace-handle", (els) => {
      const r = els[2].getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + gate.h * 0.2, { steps: 4 });
    await page.mouse.up();
    const moved = await api<{ points: number[][] }>(
      'return o.getDocument().objects.find((e) => e.id === "block").trace',
    );
    expect(moved.points[2][1]).toBeCloseTo(0.4, 1);
    await api("o.undo()");
    const undone = await api<{ points: number[][] }>(
      'return o.getDocument().objects.find((e) => e.id === "block").trace',
    );
    expect(undone.points[2][1]).toBeCloseTo(0.2, 1);
    await page.keyboard.press("m");
  });

  test("a part added in the inspector is edited on its own", async () => {
    await api(`await o.loadDocument(${JSON.stringify(scene)})`);
    await api('o.select(["block"])');
    await page.keyboard.press("v");
    await page.$eval('button[aria-label="Add a part"]', (b) => (b as HTMLButtonElement).click());
    type Doc = { objects: { id: string; parts?: { outlines: Record<string, number[][]> }[] }[] };
    const withPart = await api<Doc>("return o.getDocument()");
    const parts = withPart.objects.find((e) => e.id === "block")!.parts!;
    expect(parts).toHaveLength(2);
    // The new part (the middle half of the block's box) is selected: drag its top-right front corner up.
    const handles = await page.$$eval(".view-panel.front .vertex-handle", (els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      }),
    );
    expect(handles).toHaveLength(4);
    const [hx, hy] = handles[2];
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy - 40, { steps: 4 });
    await page.mouse.up();
    const moved = (await api<Doc>("return o.getDocument()")).objects.find((e) => e.id === "block")!.parts!;
    // The first part is untouched; the second grew upwards.
    expect(moved[0].outlines).toEqual(parts[0].outlines);
    expect(Math.max(...moved[1].outlines.front.map((p) => p[1]))).toBeGreaterThan(
      Math.max(...parts[1].outlines.front.map((p) => p[1])),
    );
    await page.keyboard.press("m");
  });

  test("per-view references show in their views", async () => {
    await api(`await o.loadDocument(${JSON.stringify(scene)})`);
    expect(await page.$$eval(".view-panel.front svg.stage image", (els) => els.length)).toBe(1);
    expect(await page.$$eval(".view-panel.top svg.stage image", (els) => els.length)).toBe(0);
    const img = await api<{ id: string }>(`return o.addImage({ data: "${PNG_1PX}", name: "px.png" })`);
    expect(img.id).toMatch(/^img-[0-9a-f]{16}$/);
    expect((await api<{ ok: boolean }>(`return o.setReference("top", { image: "${img.id}" })`)).ok).toBe(true);
    expect(await page.$$eval(".view-panel.top svg.stage image", (els) => els.length)).toBe(1);
  });
});

describe("exact solids", () => {
  test("core/raster.ts sees the same object at each pixel as the WebGL renderer", async () => {
    const doc = {
      ...scene,
      objects: [
        ...scene.objects,
        { id: "drum", color: "#7fb4ff", outlines: primitive("cylinder", [12, 6, 0], [5, 4, 7]) },
        { id: "crag", color: "#d77a6a", outlines: primitive("rock", [11, 1.5, 1], [3, 2, 3]) },
        { id: "egg", color: "#9ad17c", outlines: primitive("ellipsoid", [4, 11, 2], [4, 4, 5]) },
      ],
      // Close and low: the slab runs behind the camera, so triangles are clipped at the near plane.
      camera: {
        position: { x: 10, y: -2, z: 5 },
        target: { x: 10, y: 10, z: 2 },
        focalLengthMm35Equivalent: 24,
        // Lens shift too: both renderers take it through the same projection.
        shift: { x: 0.04, y: -0.1 },
        frame: { width: 800, height: 450 },
      },
    };
    expect(await api<unknown[]>(`return (await o.loadDocument(${JSON.stringify(doc)})).issues`)).toEqual([]);
    // The GPU's id picture, decoded in the page into object ids per pixel.
    const gpu = await api<string[]>(`
      const r = await o.render({ views: ["perspective"], mode: "ids" });
      const img = new Image(); img.src = r.images.perspective; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const hex = (i) => "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      const out = [];
      for (let i = 0; i < d.length; i += 4) out.push(r.legend[hex(i)] ?? (hex(i) === "#000000" ? "" : "?"));
      return out;`);
    const state = fromDocument(doc).state!;
    const meshes = new Map(state.objects.map((e) => [e.id, buildMesh(e.parts, e.size)]));
    const cpu = rasterize(state.camera, state.objects, (e) => meshes.get(e.id), 800, 450);
    expect(gpu.length).toBe(cpu.ids.length);
    expect(gpu.filter((id) => id === "?").length).toBe(0);
    let same = 0;
    for (let i = 0; i < gpu.length; i++) if (gpu[i] === (cpu.ids[i] ? cpu.objects[cpu.ids[i] - 1] : "")) same++;
    expect(same / gpu.length).toBeGreaterThan(0.999);
    // Every object is in the picture, so the check covers them all.
    expect(new Set(gpu)).toEqual(new Set(["", "block", "slab", "drum", "crag", "egg"]));
  });
});

describe("comparison with the reference", () => {
  const W = 640;
  const H = 360;
  const camera = {
    position: { x: 10, y: -14, z: 8 },
    target: { x: 10, y: 10, z: 3 },
    verticalFovDegrees: 36,
    frame: { width: W, height: H },
  };
  /** A mid-grey reference the size of the frame, so its pixels are frame pixels. */
  const greyPng = async () => {
    const rgba = new Uint8Array(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : 128));
    return Buffer.from(await encodePng(W, H, { rgba }, (d) => deflateSync(d))).toString("base64");
  };
  const tracedScene = async () =>
    tool<{ sceneId: string }>("create_scene", {
      document: {
        ...scene,
        objects: [{ id: "block", color: "#ff00ff", outlines: box(8, 12, 8, 12, 0, 6) }],
        camera,
        references: { perspective: { image: "grey", opacity: 1 } },
        images: { grey: { mimeType: "image/png", width: W, height: H, data: await greyPng() } },
      },
    });
  /** The block's exact silhouette: the hull of its projected corners. */
  const silhouette = () => {
    const s = fromDocument({ ...scene, objects: [], camera }).state!;
    const pts = [0, 1, 2, 3, 4, 5, 6, 7]
      .map((k) => projectPoint(s.camera, [k & 1 ? 12 : 8, k & 2 ? 12 : 8, k & 4 ? 6 : 0], W, H)!)
      .map((p) => [p[0], p[1]] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: [number, number][]) => {
      const out: [number, number][] = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      out.pop();
      return out;
    };
    return [...half(pts), ...half([...pts].reverse())];
  };
  /** Pixel colours of a PNG data URL, counted by a predicate on [r, g, b]. */
  const countPixels = (dataUrl: string, test: string) =>
    page.evaluate(
      async (url, body) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const f = new Function("r", "g", "b", `return ${body}`);
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (f(d[i], d[i + 1], d[i + 2])) n++;
        return n;
      },
      dataUrl,
      test,
    );

  test("set_trace and compare_to_reference score an object against its trace", async () => {
    const { sceneId } = await tracedScene();
    const exact = silhouette();
    const shifted = exact.map(([u, v]) => [u + 12, v]);
    expect((await tool("set_trace", { sceneId, id: "block", points: shifted })).ok).toBe(true);
    type Compared = { objects: { id: string; iou: number; spill: { count: number }; missing: { count: number } }[] };
    const off = await tool<Compared & { images: { diff: string } }>("compare_to_reference", { sceneId, diff: true });
    expect(off.issues.map((i) => i.code)).toEqual(["trace-spill", "trace-missing"]);
    expect(off.objects[0].iou).toBeLessThan(0.95);
    expect(await countPixels(off.images.diff, "r === 235 && g === 64 && b === 52")).toBe(off.objects[0].spill.count);
    // validate reports the same problems, and so does the edit that caused them.
    expect((await tool("validate", { sceneId })).issues.map((i) => i.code)).toEqual(["trace-spill", "trace-missing"]);
    const fixed = await tool("set_trace", { sceneId, id: "block", points: exact });
    expect(fixed.issues).toEqual([]);
    const on = await tool<Compared>("compare_to_reference", { sceneId });
    expect(on.issues).toEqual([]);
    expect(on.objects[0].iou).toBeGreaterThan(0.99);
    const doc = await tool<{ document: { objects: { trace: { points: number[][] } }[] } }>("get_scene", { sceneId });
    expect(doc.document.objects[0].trace.points).toEqual(exact);
  }, 30000);

  test("id and depth pictures come without a browser, with a legend and a depth range", async () => {
    const { sceneId } = await tracedScene();
    const ids = await tool<{ images: { perspective: string }; legend: Record<string, string> }>("render", {
      sceneId,
      views: ["perspective"],
      mode: "ids",
    });
    expect(Object.values(ids.legend)).toEqual(["block"]);
    const [colour] = Object.keys(ids.legend);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    const block = await countPixels(ids.images.perspective, `r === ${r} && g === ${g} && b === ${b}`);
    const black = await countPixels(ids.images.perspective, "r === 0 && g === 0 && b === 0");
    expect(block).toBeGreaterThan(1000);
    expect(block + black).toBe(W * H);
    const depth = await tool<{ depthRange: { near: number; far: number } }>("render", {
      sceneId,
      views: ["perspective"],
      mode: "depth",
    });
    // The block's nearest corner is about 22 m from the camera along the view, its farthest about 28 m.
    expect(depth.depthRange.near).toBeGreaterThan(15);
    expect(depth.depthRange.far).toBeLessThan(35);
    expect(depth.depthRange.far).toBeGreaterThan(depth.depthRange.near);
  }, 30000);

  test("silhouette outlines leave out creases; referenceOpacity changes only the picture", async () => {
    const { sceneId } = await tracedScene();
    const shot = async (extra: Record<string, unknown>) =>
      (await tool<{ images: { perspective: string } }>("render", { sceneId, views: ["perspective"], ...extra })).images
        .perspective;
    const magentaish = "r > 180 && g < 90 && b > 180";
    const all = await countPixels(await shot({}), magentaish);
    const outer = await countPixels(await shot({ outlines: "silhouette" }), magentaish);
    // The box's front and top meet at a crease inside its silhouette.
    expect(outer).toBeGreaterThan(200);
    expect(all).toBeGreaterThan(outer + 100);
    // An opaque grey reference hides the solid; at opacity 0 the shaded solid shows.
    const grey = "r === 128 && g === 128 && b === 128";
    expect(await countPixels(await shot({ referenceOpacity: 0 }), grey)).toBe(0);
    expect(await countPixels(await shot({}), grey)).toBeGreaterThan(W * H * 0.5);
    const doc = await tool<{ document: { references: { perspective: { opacity: number } } } }>("get_scene", {
      sceneId,
    });
    expect(doc.document.references.perspective.opacity).toBe(1);
  }, 30000);
});

describe("fitting", () => {
  const W = 800;
  const H = 500;
  const camera = {
    position: { x: 10, y: -12, z: 9 },
    target: { x: 10, y: 10, z: 2 },
    verticalFovDegrees: 40,
    frame: { width: W, height: H },
  };
  const hull = (lo: number[], hi: number[]) => {
    const s = fromDocument({ ...scene, objects: [], camera, references: undefined, images: undefined }).state!;
    const pts = [0, 1, 2, 3, 4, 5, 6, 7]
      .map((k) => projectPoint(s.camera, [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]], W, H)!)
      .map((p) => [p[0], p[1]] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: [number, number][]) => {
      const out: [number, number][] = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      out.pop();
      return out;
    };
    return [...half(pts), ...half([...pts].reverse())];
  };

  test("suggest_views and fit_front build an object from its trace", async () => {
    const rgba = new Uint8Array(W * H * 4).fill(255);
    const png = Buffer.from(await encodePng(W, H, { rgba }, (d) => deflateSync(d))).toString("base64");
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {
      document: {
        ...scene,
        objects: [
          { id: "cap", outlines: box(6, 14, 6, 14, 0, 2) },
          // Some shape to start from; only its trace matters.
          { id: "stone", outlines: box(0, 1, 0, 1, 0, 1), trace: { points: hull([8, 8, 2], [12, 12, 7]) } },
        ],
        camera,
        references: { perspective: { image: "white" } },
        images: { white: { mimeType: "image/png", width: W, height: H, data: png } },
      },
    });
    type Fit = {
      outlines: Record<string, number[][]>;
      cell: number;
      comparison: { iou: number };
      dryRun?: boolean;
      revision: number;
    };
    const suggested = await tool<Fit>("suggest_views", { sceneId, id: "stone", depth: { min: 8, max: 12 } });
    expect(suggested.ok).toBe(true);
    const x = suggested.outlines.top.map((p) => p[0]);
    expect(Math.min(...x)).toBeLessThan(8);
    expect(Math.max(...x)).toBeGreaterThan(12);
    // A dry run changes nothing.
    const before = suggested.revision;
    const dry = await tool<Fit>("fit_front", { sceneId, id: "stone", top: box(8, 12, 8, 12, 0, 1).top, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.revision).toBe(before);
    const fit = await tool<Fit>("fit_front", {
      sceneId,
      id: "stone",
      top: box(8, 12, 8, 12, 0, 1).top,
      side: box(0, 1, 8, 12, 0, 9).side,
      restOn: ["cap"],
    });
    expect(fit.ok).toBe(true);
    expect(fit.revision).toBe(before + 1);
    expect(fit.comparison.iou).toBeGreaterThan(0.97);
    const zs = fit.outlines.front.map((p) => p[1]);
    // It rests on the cap (z = 2) and stops where the trace does (z = 7).
    expect(Math.abs(Math.min(...zs) - 2)).toBeLessThan(0.05);
    expect(Math.abs(Math.max(...zs) - 7)).toBeLessThan(0.05);
    expect(fit.issues.filter((i) => i.code.startsWith("trace-"))).toEqual([]);
  }, 30000);
});

describe("measuring", () => {
  test("raycast and measure answer from the scene, in frame or reference pixels", async () => {
    const W = 1000;
    const H = 600;
    const rgba = new Uint8Array(500 * 300 * 4).fill(255);
    const png = Buffer.from(await encodePng(500, 300, { rgba }, (d) => deflateSync(d))).toString("base64");
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {
      document: {
        ...scene,
        objects: [{ id: "wall", outlines: box(0, 20, 10, 10.5, 0, 6) }],
        camera: {
          position: { x: 10, y: 0, z: 3 },
          target: { x: 10, y: 10, z: 3 },
          verticalFovDegrees: 40,
          frame: { width: W, height: H },
        },
        // Half the frame's pixel size: reference pixel (250, 150) is the frame's centre.
        references: { perspective: { image: "white" } },
        images: { white: { mimeType: "image/png", width: 500, height: 300, data: png } },
      },
    });
    type Hits = { hits: ({ id: string; distance: number; point: { y: number } } | null)[] };
    const r = await tool<Hits>("raycast", {
      sceneId,
      points: [
        [W / 2, H / 2],
        [W / 2, 1],
      ],
    });
    expect(r.hits[0]).toMatchObject({ id: "wall", distance: 10, point: { y: 10 } });
    expect(r.hits[1]).toBeNull();
    const ref = await tool<Hits>("raycast", { sceneId, points: [[250, 150]], space: "reference" });
    expect(ref.hits[0]!.distance).toBeCloseTo(10, 6);
    // A metre on the wall, 10 m away: 1 / (2 * 10 * tan 20°) of the frame's height.
    const metre = H / (2 * 10 * Math.tan((20 * Math.PI) / 180));
    const m = await tool<{ length: number; depth: number }>("measure", {
      sceneId,
      from: [W / 2, H / 2],
      to: [W / 2, H / 2 - metre],
      at: "wall",
    });
    expect(m.length).toBeCloseTo(1, 6);
    expect(m.depth).toBeCloseTo(10, 6);
    const miss = await tool("measure", { sceneId, from: [W / 2, 1], to: [W / 2, 2], at: "wall" });
    expect(miss.issues.map((i) => i.code)).toEqual(["no-hit"]);
  });
});

describe("MCP", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: "e2e", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  });
  afterAll(() => client?.close());

  test("lists every tool, with instructions and resources", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("render");
    // All annotated read-only (see mcp.ts); the descriptions say which ones write.
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const writes = tools.filter((t) => t.description?.startsWith("WRITE TOOL")).map((t) => t.name);
    expect(writes).toContain("add_objects");
    expect(writes).not.toContain("get_scene");
    expect(
      tools
        .map((t) => t.name)
        .filter((n) => !writes.includes(n))
        .sort(),
    ).toEqual([
      "compare_to_reference",
      "export",
      "get_changes",
      "get_scene",
      "measure",
      "raycast",
      "read_guide",
      "render",
      "validate",
    ]);
    expect(client.getInstructions()).toContain("create_scene");
    const guide = await client.readResource({ uri: "orthographic://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("# Orthographic Studio");
  });

  test("builds a scene and renders it as images", async () => {
    const created = await client.callTool({ name: "create_scene", arguments: { document: scene } });
    const { sceneId, editorUrl } = created.structuredContent as { sceneId: string; editorUrl: string };
    expect(editorUrl).toBe(`http://127.0.0.1:${PORT}/orthographic/?scene=${sceneId}`);
    // The editor link works in place of the id.
    const moved = await client.callTool({
      name: "move_objects",
      arguments: { sceneId: editorUrl, ids: ["block"], offset: { x: 1, y: 0, z: 0 } },
    });
    expect(moved.isError).toBe(false);
    expect(
      (moved.structuredContent as { objects: { derived: { min: { x: number } } }[] }).objects[0].derived.min.x,
    ).toBe(3);
    const rendered = await client.callTool({
      name: "render",
      arguments: { sceneId, views: ["front"], width: 300, height: 200 },
    });
    const image = (rendered.content as { type: string; data?: string }[]).find((c) => c.type === "image")!;
    expect(Buffer.from(image.data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    const { urls } = rendered.structuredContent as { urls: Record<string, string> };
    const png = await fetch(urls.front);
    expect(png.headers.get("content-type")).toBe("image/png");
  }, 30000);

  test("errors come back as issues, flagged isError", async () => {
    const r = await client.callTool({ name: "add_object", arguments: { sceneId: "nope", colour: "red" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { issues: { code: string }[] }).issues[0].code).toBe(
      "argument-additionalProperties",
    );
  });
});

describe("HTTP tools and scenes", () => {
  test("edits report geometry problems of the objects they touch", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {});
    // Top keeps y <= 4 - x and side keeps y >= 4 - z, so only z >= x of the square front view is solid.
    const r = await tool("add_object", {
      sceneId,
      id: "wedge",
      outlines: {
        front: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        top: [
          [0, 0],
          [4, 0],
          [0, 4],
        ],
        side: [
          [4, 0],
          [4, 4],
          [0, 4],
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("low-coverage");
    const undone = await tool<{ undone: boolean }>("undo", { sceneId });
    expect(undone.undone).toBe(true);
    expect((await tool<{ document: { objects: unknown[] } }>("get_scene", { sceneId })).document.objects).toEqual([]);
  });

  test("add_objects adds a batch in one step, or nothing when one object is wrong", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {});
    const good = { id: "a", outlines: box(0, 2, 0, 2, 0, 2) };
    const refused = await tool("add_objects", {
      sceneId,
      objects: [
        good,
        {
          id: "b",
          outlines: {
            ...box(0, 2, 0, 2, 0, 2),
            top: [
              [0, 0],
              [2, 2],
              [2, 0],
              [0, 2],
            ],
          },
        },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues.map((i) => `${i.code} ${i.path}`)).toEqual([
      "ring-self-intersection /objects/1/outlines/top",
    ]);
    expect((await tool<{ document: { objects: unknown[] } }>("get_scene", { sceneId })).document.objects).toEqual([]);
    const added = await tool<{ ids: string[]; revision: number; objects: Record<string, unknown>[] }>("add_objects", {
      sceneId,
      objects: [good, { primitive: "box", center: { x: 10, y: 10, z: 1 }, size: { x: 2, y: 2, z: 2 } }],
    });
    expect(added.ids).toEqual(["a", "obj-1"]);
    expect(added.revision).toBe(2);
    expect(Object.keys(added.objects[0])).toEqual(["id", "derived"]);
    expect((await tool<{ undone: boolean }>("undo", { sceneId })).undone).toBe(true);
    expect((await tool<{ document: { objects: unknown[] } }>("get_scene", { sceneId })).document.objects).toEqual([]);
  });

  test("images come from data (not from private URLs) and back references", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {});
    const img = await tool<{ id: string; width: number }>("add_image", { sceneId, data: PNG_1PX, name: "px.png" });
    expect(img.id).toMatch(/^img-[0-9a-f]{16}$/);
    expect(img.width).toBe(1);
    expect((await tool("set_reference", { sceneId, view: "top", image: img.id })).ok).toBe(true);
    const local = await tool("add_image", { sceneId, url: `http://127.0.0.1:${PORT}/orthographic/` });
    expect(local.issues[0].code).toBe("invalid-url");
  });

  test("the perspective render outlines the solids above an opaque reference", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", {
      document: {
        ...scene,
        objects: [{ id: "block", color: "#ff00ff", outlines: box(8, 12, 8, 12, 0, 6) }],
        references: { perspective: { image: "px", opacity: 1 } },
      },
    });
    // Pure #ff00ff pixels: shading always darkens the solid, so only outline pixels are that colour.
    const magenta = (dataUrl: string) =>
      page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) n++;
        return n;
      }, dataUrl);
    const shot = async (references: boolean) =>
      (
        await tool<{ images: { perspective: string } }>("render", {
          sceneId,
          views: ["perspective"],
          width: 640,
          references,
        })
      ).images.perspective;
    expect(await magenta(await shot(true))).toBeGreaterThan(100);
    expect(await magenta(await shot(false))).toBe(0);
  }, 30000);

  test("a render placed back as its view's reference lines up with the drawing", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const clean = { sceneId, views: ["top"], pixelsPerMeter: 20, labels: false, grid: false };
    type Rendered = { images: { top: string }; placements: { top: { min: object; size: object } } };
    const drawing = await tool<Rendered>("render", { ...clean, references: false });
    const img = await tool<{ id: string }>("add_image", { sceneId, data: drawing.images.top, name: "top.png" });
    const { min, size } = drawing.placements.top;
    // Hidden objects leave only the picture of them, so the comparison is picture against drawing.
    for (const id of ["block", "slab"]) await tool("update_object", { sceneId, id, visible: false });
    // Pixels that differ clearly: the frame and scale bar, drawn over their own picture, change by at most ~20.
    const clearDifferences = (a: string, b: string) =>
      page.evaluate(
        async (urls) => {
          const pixels = async (url: string) => {
            const img = new Image();
            img.src = url;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height).data;
          };
          const [p, q] = await Promise.all(urls.map(pixels));
          if (p.length !== q.length) return -1;
          let n = 0;
          for (let i = 0; i < p.length; i += 4)
            if (Math.max(...[0, 1, 2].map((k) => Math.abs(p[i + k] - q[i + k]))) > 40) n++;
          return n;
        },
        [a, b],
      );
    const over = async (placement: { min: object; size: object }) => {
      expect((await tool("set_reference", { sceneId, view: "top", image: img.id, opacity: 1, ...placement })).ok).toBe(
        true,
      );
      return (await tool<Rendered>("render", { ...clean, references: true })).images.top;
    };
    expect(await clearDifferences(drawing.images.top, await over({ min, size }))).toBe(0);
    // The control: one pixel (5 cm) off shows up.
    const shifted = { ...(min as { x: number; y: number }), x: (min as { x: number }).x + 0.05 };
    expect(await clearDifferences(drawing.images.top, await over({ min: shifted, size }))).toBeGreaterThan(1000);
  }, 30000);

  test("rescale_scene corrects the scale of everything built", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const out = await tool<{ revision: number }>("rescale_scene", {
      sceneId,
      factor: 0.5,
      scale: { basis: "the slab is a 10 m square" },
    });
    expect(out.ok).toBe(true);
    const { document } = await tool<{
      document: {
        scene: { size: object; scale: object };
        objects: { derived: { size: object } }[];
        references: { front: object };
      };
    }>("get_scene", { sceneId });
    expect(document.scene).toMatchObject({
      size: { x: 10, y: 10, z: 5 },
      scale: { basis: "the slab is a 10 m square" },
    });
    expect(document.objects[0].derived.size).toEqual({ x: 3, y: 3, z: 3 });
    expect(document.references.front).toMatchObject({ min: { x: 0, z: 0 }, size: { x: 10, z: 5 } });
    expect((await tool("rescale_scene", { sceneId, factor: 0 })).issues[0].code).toBe("argument-exclusiveMinimum");
  });

  test("a save based on an old revision is refused", async () => {
    const { sceneId, revision } = await tool<{ sceneId: string; revision: number }>("create_scene", {
      document: scene,
    });
    await tool("set_scene", { sceneId, title: "Changed" });
    const put = await fetch(`${BASE}/api/scenes/${sceneId}`, {
      method: "PUT",
      body: JSON.stringify({ baseRevision: revision, document: scene }),
    });
    expect(put.status).toBe(409);
  });

  test("edits based on an old revision are refused, and get_changes says what happened in between", async () => {
    const { sceneId, revision } = await tool<{ sceneId: string; revision: number }>("create_scene", {
      document: scene,
    });
    // A person moves the block in the editor (a PUT, as the editor saves).
    const doc = structuredClone(scene);
    doc.objects[0].outlines = box(3, 9, 2, 8, 0, 6);
    const put = await fetch(`${BASE}/api/scenes/${sceneId}`, {
      method: "PUT",
      body: JSON.stringify({ baseRevision: revision, document: doc }),
    });
    expect(put.status).toBe(200);
    const stale = await tool<{ revision: number }>("set_scene", { sceneId, title: "Mine", baseRevision: revision });
    expect(stale.ok).toBe(false);
    expect(stale.issues.map((i) => i.code)).toEqual(["revision-conflict"]);
    expect(stale.revision).toBe(revision + 1);
    expect(
      (await tool<{ document: { scene: { title: string } } }>("get_scene", { sceneId })).document.scene.title,
    ).not.toBe("Mine");
    type Changes = {
      complete: boolean;
      changes: { revision: number; by: string; objects: { changed: Record<string, string[]> }; scene: string[] }[];
    };
    const changes = await tool<Changes>("get_changes", { sceneId, since: revision });
    expect(changes.complete).toBe(true);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]).toMatchObject({
      revision: revision + 1,
      by: "editor",
      objects: { changed: { block: ["outlines.front", "outlines.top"] } },
    });
    const fresh = await tool("set_scene", { sceneId, title: "Mine", baseRevision: revision + 1 });
    expect(fresh.ok).toBe(true);
    const later = await tool<Changes>("get_changes", { sceneId, since: revision });
    expect(later.changes.map((c) => [c.by, c.scene])).toEqual([
      ["editor", []],
      ["set_scene", ["title"]],
    ]);
  });

  test("set_outlines and upsert_objects change objects in one step, keeping what is not given", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    await tool("update_object", { sceneId, id: "block", name: "The block", notes: "keep me" });
    const set = await tool<{ objects: { derived: { min: object; max: object } }[] }>("set_outlines", {
      sceneId,
      id: "block",
      outlines: box(1, 4, 1, 3, 0, 2),
    });
    expect(set.ok).toBe(true);
    expect(set.objects[0].derived).toMatchObject({ min: { x: 1, y: 1, z: 0 }, max: { x: 4, y: 3, z: 2 } });
    const up = await tool<{ added: string[]; changed: string[] }>("upsert_objects", {
      sceneId,
      objects: [
        { id: "block", color: "#123456" },
        { id: "rock", primitive: "rock", center: { x: 15, y: 15, z: 3 }, size: { x: 4, y: 4, z: 6 } },
      ],
    });
    expect(up.ok).toBe(true);
    expect([up.added, up.changed]).toEqual([["rock"], ["block"]]);
    const doc = await tool<{ document: { objects: { id: string; name: string; notes: string; color: string }[] } }>(
      "get_scene",
      { sceneId },
    );
    const block = doc.document.objects.find((o) => o.id === "block")!;
    expect([block.name, block.notes, block.color]).toEqual(["The block", "keep me", "#123456"]);
    // All or nothing: one bad object leaves everything as it was.
    const bad = await tool("upsert_objects", {
      sceneId,
      objects: [
        { id: "block", color: "#654321" },
        { id: "rock", inFrontOf: ["nothing-here"] },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => `${i.code} ${i.path}`)).toEqual(["unknown-object /objects/1/inFrontOf/0"]);
    const after = await tool<{ document: { objects: { id: string; color: string }[] } }>("get_scene", { sceneId });
    expect(after.document.objects.find((o) => o.id === "block")!.color).toBe("#123456");
    // One undo reverts the whole batch.
    await tool("undo", { sceneId });
    const undone = await tool<{ document: { objects: { id: string }[] } }>("get_scene", { sceneId });
    expect(undone.document.objects.map((o) => o.id)).toEqual(["block", "slab"]);
  });

  test("a scene stored before parts existed still loads, edits and undoes", async () => {
    // As an older server wrote it: objects with outlines, and a reconstruction setting, in state and history.
    const state = fromDocument({ ...scene, references: undefined, images: undefined }).state!;
    const legacy = (s: typeof state) => ({
      ...s,
      reconstruction: { resolution: 40 },
      objects: s.objects.map(({ parts, ...e }) => ({ ...e, outlines: parts[0].outlines })),
    });
    const id = "legacyScene0123456789a";
    const older = structuredClone(state);
    older.scene.title = "Older";
    const stored = {
      id,
      revision: 7,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      state: legacy(state),
      images: {},
      past: [JSON.stringify(legacy(older))],
      future: [],
    };
    await Bun.write(join(DATA_DIR, "scenes", `${id}.json`), JSON.stringify(stored));
    const got = await tool<{ document: { objects: { outlines: number[][] }[] } }>("get_scene", { sceneId: id });
    expect(got.ok).toBe(true);
    expect(got.document.objects[0].outlines).toEqual(scene.objects[0].outlines as never);
    expect(
      (await tool("set_outline", { sceneId: id, id: "block", view: "front", points: box(2, 9, 2, 8, 0, 6).front })).ok,
    ).toBe(true);
    await tool("undo", { sceneId: id });
    await tool("undo", { sceneId: id });
    const undone = await tool<{ document: { scene: { title: string }; objects: unknown[] } }>("get_scene", {
      sceneId: id,
    });
    expect(undone.document.scene.title).toBe("Older");
    expect((await tool("validate", { sceneId: id })).issues).toEqual([]);
  });

  test("objects in parts through the tools", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const added = await tool("add_object", {
      sceneId,
      id: "L",
      parts: [{ id: "slab", outlines: box(10, 16, 10, 12, 0, 1) }, { outlines: box(10, 12, 10, 12, 0, 5) }],
    });
    expect(added.ok).toBe(true);
    const missing = await tool("set_outlines", { sceneId, id: "L", outlines: box(10, 12, 10, 12, 0, 7) });
    expect(missing.issues.map((i) => i.code)).toEqual(["part-required"]);
    const taller = await tool<{ objects: { derived: { max: { z: number } } }[] }>("set_outlines", {
      sceneId,
      id: "L",
      part: 1,
      outlines: box(10, 12, 10, 12, 0, 7),
    });
    expect(taller.objects[0].derived.max.z).toBe(7);
    const doc = await tool<{ document: { objects: { id: string; parts?: { id?: string }[] }[] } }>("get_scene", {
      sceneId,
    });
    expect(doc.document.objects.find((o) => o.id === "L")!.parts!.map((p) => p.id)).toEqual(["slab", undefined]);
    const changes = await tool<{ changes: { objects: { changed: Record<string, string[]> } }[] }>("get_changes", {
      sceneId,
      since: 2,
    });
    expect(changes.changes[0].objects.changed.L).toEqual(["parts.1.outlines.front", "parts.1.outlines.side"]);
  });

  test("exports the scene, including a working editor file", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const csv = await tool<{ content: string }>("export", { sceneId, format: "objects.csv" });
    expect(csv.content.split("\r\n")).toHaveLength(3);
    const html = await (await fetch(`${BASE}/api/scenes/${sceneId}/export/editor.html`)).text();
    expect(html).toContain('"format":"orthographic-scene"');
    const offline = await browser.newPage();
    try {
      await offline.setContent(html, { waitUntil: "load" });
      await offline.waitForFunction("window.orthographic?.getDocument().objects.length === 2", { timeout: 10000 });
    } finally {
      await offline.close();
    }
  }, 30000);
});

describe("live scenes", () => {
  test("the editor follows agent edits and saves its own", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const tab = await browser.newPage();
    try {
      await tab.goto(`${BASE}/?scene=${sceneId}`);
      await tab.waitForFunction("window.orthographic?.getDocument().objects.length === 2", { timeout: 10000 });
      expect(await tab.$eval(".badge.live", (e) => e.textContent)).toContain("LIVE");
      await tool("delete_objects", { sceneId, ids: ["slab"] });
      await tab.waitForFunction("window.orthographic.getDocument().objects.length === 1", { timeout: 5000 });
      await tab.evaluate('window.orthographic.updateObject("block", { name: "Edited in the editor" })');
      let name = "";
      for (let i = 0; i < 30 && name !== "Edited in the editor"; i++) {
        await Bun.sleep(100);
        name = (await tool<{ document: { objects: { name: string }[] } }>("get_scene", { sceneId })).document.objects[0]
          .name;
      }
      expect(name).toBe("Edited in the editor");
    } finally {
      await tab.close();
    }
  }, 30000);

  test("an agent edit keeps the solids it did not change", async () => {
    const { sceneId } = await tool<{ sceneId: string }>("create_scene", { document: scene });
    const tab = await browser.newPage();
    const shown = () => tab.evaluate(() => /· (\d+) objects ·/.exec(document.body.innerText)?.[1]);
    try {
      await tab.goto(`${BASE}/?scene=${sceneId}`);
      await tab.waitForFunction(() => /· 2 objects ·/.test(document.body.innerText), { timeout: 10000 });
      await tool("set_scene", { sceneId, title: "Retitled" });
      await tab.waitForFunction('window.orthographic.getDocument().scene.title === "Retitled"', { timeout: 5000 });
      // The reload used to drop every mesh and rebuild none of them (the outlines had not changed).
      expect(await shown()).toBe("2");
      await Bun.sleep(500);
      expect(await shown()).toBe("2");
    } finally {
      await tab.close();
    }
  }, 30000);

  test("Share stores the scene and switches the editor to it", async () => {
    await api(`await o.loadDocument(${JSON.stringify(scene)})`);
    await page.click('button[title^="Store this scene on the server"]');
    await page.waitForFunction('location.search.startsWith("?scene=")', { timeout: 5000 });
    const id = await page.evaluate("new URLSearchParams(location.search).get('scene')");
    const stored = await tool<{ document: { objects: unknown[] } }>("get_scene", { sceneId: id });
    expect(stored.document.objects).toHaveLength(2);
  });
});
