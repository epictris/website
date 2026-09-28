// 3d.tris.sh: the 3D tools and their HTTP API.
//
//   /orthographic/              the editor (one self-contained HTML file, built by Vite)
//   /orthographic/llms.txt      guide for agents
//   /orthographic/schema.json   the scene document's JSON Schema
//   /orthographic/api/...       validate and render scene documents
//
// Every route is explicit, so no request path reaches the filesystem.
// API_ONLY=1 (scripts/dev.ts) serves just the API and spec files while Vite
// serves the editor; EDITOR_URL then points the renderer at Vite.

import { Busy, closeBrowser, runInEditor } from "./api/browser";
import { validateDocument } from "./orthographic/src/core/document";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = new URL(".", import.meta.url);
const EDITOR_URL = process.env.EDITOR_URL ?? `http://127.0.0.1:${PORT}/orthographic/`;
const MAX_BODY = 64 * 1024 * 1024;

const file = (path: string) => Bun.file(new URL(path, ROOT));
const redirect =
  (to: string, status = 301) =>
  () =>
    new Response(null, { status, headers: { Location: to } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const problem = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ ok: false, issues: [{ severity: "error", code, path: "", message }] }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadRequest(`The body is not valid JSON: ${(e as Error).message}`);
  }
}

class BadRequest extends Error {}

const VIEWS = ["front", "top", "side", "perspective"];

interface RenderRequest {
  document: unknown;
  views?: string[];
  width?: number;
  height?: number;
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
}

interface RenderJob {
  document: unknown;
  options: { views: string[]; width?: number; height?: number; references?: boolean; labels?: boolean; grid?: boolean };
}

interface RenderOutcome {
  ok: boolean;
  issues: { code: string; path: string }[];
  images?: Record<string, string>;
}

/** Runs inside the editor page: load the document, render, and report every issue once. */
async function renderInEditor(job: RenderJob): Promise<RenderOutcome> {
  const api = (window as unknown as { orthographic: Record<string, (...a: unknown[]) => Promise<RenderOutcome>> })
    .orthographic;
  const loaded = await api.loadDocument(job.document);
  if (!loaded.ok) return loaded;
  const rendered = await api.render(job.options);
  const checked = await api.validate();
  const known = new Set(loaded.issues.map((i) => `${i.code} ${i.path}`));
  return {
    ok: rendered.ok,
    issues: [...loaded.issues, ...rendered.issues, ...checked.issues.filter((i) => !known.has(`${i.code} ${i.path}`))],
    images: rendered.images,
  };
}

async function render(req: RenderRequest) {
  const views = req.views ?? VIEWS;
  if (!Array.isArray(views) || !views.every((v) => VIEWS.includes(v)))
    throw new BadRequest(`views must be a list of ${VIEWS.join(", ")}.`);
  const clamp = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined;
  const options = {
    views,
    width: clamp(req.width, 128, 4096),
    height: clamp(req.height, 128, 4096),
    references: req.references,
    labels: req.labels,
    grid: req.grid,
  };
  return runInEditor(EDITOR_URL, renderInEditor, { document: req.document, options });
}

const API_INDEX = {
  guide: "https://3d.tris.sh/orthographic/llms.txt",
  schema: "https://3d.tris.sh/orthographic/schema.json",
  endpoints: {
    "POST /orthographic/api/validate": "Body: a scene document. Returns { ok, issues } including geometry checks.",
    "POST /orthographic/api/render":
      "Body: { document, views?, width?, height?, references?, labels?, grid? }. Returns { ok, issues, images: { view: PNG data URL } }.",
    "POST /orthographic/api/render/{front|top|side|perspective}.png":
      "Body: a scene document. Returns the PNG itself (issues in the X-Issues header).",
  },
};

async function handleApi(req: Request, path: string): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (path === "/orthographic/api" || path === "/orthographic/api/") return json(API_INDEX);
  if (req.method !== "POST") return problem(405, "method-not-allowed", "Use POST.", { Allow: "POST, OPTIONS" });
  try {
    if (path === "/orthographic/api/validate") {
      const v = validateDocument(await readJson(req));
      return json({ ok: v.ok, issues: v.issues });
    }
    if (path === "/orthographic/api/render") {
      const body = (await readJson(req)) as RenderRequest;
      if (!body || typeof body !== "object" || !("document" in body))
        throw new BadRequest("Send { document, views?, width?, height? }.");
      const out = await render(body);
      return json(out, out.ok ? 200 : 422);
    }
    const png = /^\/orthographic\/api\/render\/(front|top|side|perspective)\.png$/.exec(path);
    if (png) {
      const url = new URL(req.url);
      const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
      const out = await render({
        document: await readJson(req),
        views: [png[1]],
        width: num("width"),
        height: num("height"),
        references: url.searchParams.get("references") !== "false",
      });
      if (!out.ok || !out.images) return json(out, 422);
      const data = out.images[png[1]].replace(/^data:image\/png;base64,/, "");
      return new Response(Buffer.from(data, "base64"), {
        headers: {
          "Content-Type": "image/png",
          "X-Issues": encodeURIComponent(JSON.stringify(out.issues)).slice(0, 7000),
          ...CORS,
        },
      });
    }
    return problem(404, "not-found", "Unknown API endpoint; GET /orthographic/api lists them.");
  } catch (e) {
    if (e instanceof BadRequest) return problem(400, "bad-request", e.message);
    if (e instanceof Busy) return problem(503, "busy", e.message, { "Retry-After": "5" });
    console.error(e);
    return problem(500, "internal-error", "Rendering failed.");
  }
}

const spec = {
  "/orthographic/llms.txt": () =>
    new Response(file("orthographic/llms.txt"), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS },
    }),
  "/orthographic/schema.json": () =>
    new Response(file("orthographic/src/core/schema.json"), {
      headers: { "Content-Type": "application/schema+json", ...CORS },
    }),
};

const editor = {
  "/": redirect("/orthographic/", 302),
  "/orthographic": redirect("/orthographic/"),
  "/orthographic/": () =>
    new Response(file("dist/orthographic/index.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
};

Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  routes: process.env.API_ONLY ? spec : { ...spec, ...editor },
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/orthographic/api")) return handleApi(req, path);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`3d listening on http://localhost:${PORT}/orthographic/`);

// Close the renderer's Chromium with the server, or it outlives it.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
