// End to end: the built editor served by server.ts, its HTTP API, and the page
// driven in headless Chromium the way a person or an agent would use it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

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
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const scene = {
  format: "orthographic-scene",
  version: 1,
  scene: { size: { x: 20, y: 20, z: 10 } },
  objects: [
    { id: "block", color: "#efc875", outlines: box(2, 8, 2, 8, 0, 6) },
    { id: "slab", outlines: box(0, 20, 0, 20, 0, 1) },
  ],
  references: { front: { image: "px", min: { x: 0, z: 0 }, size: { x: 20, z: 10 } } },
  images: { px: { mimeType: "image/png", width: 1, height: 1, data: PNG_1PX } },
};

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const build = Bun.spawnSync(["bunx", "vite", "build", "--logLevel", "error"], { cwd: ROOT });
  if (build.exitCode) throw new Error(build.stderr.toString());
  server = Bun.spawn(["bun", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
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
});

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
});

describe("editor", () => {
  const api = <T = unknown>(f: string) =>
    page.evaluate(`(async () => { const o = window.orthographic; ${f} })()`) as Promise<T>;

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
