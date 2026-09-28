// End to end: the built editor served by server.ts, its HTTP API, and the page
// driven in headless Chromium the way a person or an agent would use it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
    expect(writes).toHaveLength(tools.length - 5);
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

  test("Share stores the scene and switches the editor to it", async () => {
    await api(`await o.loadDocument(${JSON.stringify(scene)})`);
    await page.click('button[title^="Store this scene on the server"]');
    await page.waitForFunction('location.search.startsWith("?scene=")', { timeout: 5000 });
    const id = await page.evaluate("new URLSearchParams(location.search).get('scene')");
    const stored = await tool<{ document: { objects: unknown[] } }>("get_scene", { sceneId: id });
    expect(stored.document.objects).toHaveLength(2);
  });
});
