// The HTTP API under /orthographic/api (and the MCP endpoint beside it).
//
//   POST /validate, /render, /render/{view}.png     stateless: the document is the body
//   GET  /tools, POST /tools/{name}                  the MCP tools over plain HTTP
//   POST /scenes, GET|PUT /scenes/{id}               stored scenes (the editor syncs through these)
//   POST /scenes/{id}/images                         upload image bytes
//   GET  /scenes/{id}/events                         server-sent events: a revision per change
//   GET  /scenes/{id}/render/{view}.png              a render, cached by revision
//   GET  /scenes/{id}/export/{file}                  scene.json, agent.json, objects.csv, views.svg, editor.html

import type { Server } from "bun";
import { validateDocument } from "../orthographic/src/core/document";
import { objectsCsv } from "../orthographic/src/core/table";
import { Busy } from "./browser";
import { checkGeometry } from "./geometry";
import { handleMcp } from "./mcp";
import { BadRequest, pngBytes, projectionSheet, render } from "./render";
import {
  addImage,
  createScene,
  getScene,
  readDocument,
  replaceScene,
  type Scene,
  StoreError,
  sceneDocument,
  subscribe,
} from "./scenes";
import { callTool, editorUrl, TOOLS, type ToolContext } from "./tools";

const ROOT = new URL("..", import.meta.url);

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, If-Match",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, ETag, X-Issues",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS, ...headers } });
const problem = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  json({ ok: false, issues: [{ severity: "error", code, path: "", message }] }, status, extra);

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadRequest(`The body is not valid JSON: ${(e as Error).message}`);
  }
}

/** Where the caller reaches this server (behind Caddy: the public https origin). */
export function contextOf(req: Request): ToolContext {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return { origin: `${proto}://${host}` };
}

const API_INDEX = (ctx: ToolContext) => ({
  guide: `${ctx.origin}/orthographic/llms.txt`,
  schema: `${ctx.origin}/orthographic/schema.json`,
  mcp: `${ctx.origin}/orthographic/mcp`,
  endpoints: {
    "POST /orthographic/mcp":
      "MCP server (Streamable HTTP, no auth): every tool below, plus the guide and schema as resources.",
    "GET /orthographic/api/tools": "The tools with their JSON Schemas.",
    "POST /orthographic/api/tools/{name}": "Run a tool; body is its arguments. Returns { ok, issues, ... }.",
    "POST /orthographic/api/validate": "Body: a scene document. Returns { ok, issues } including geometry checks.",
    "POST /orthographic/api/render":
      "Body: { document, views?, width?, height?, references?, labels?, grid? }. Returns { ok, issues, images: { view: PNG data URL } }.",
    "POST /orthographic/api/render/{front|top|side|perspective}.png":
      "Body: a scene document. Returns the PNG itself (issues in the X-Issues header).",
    "POST /orthographic/api/scenes": "Body: a scene document (or nothing). Stores it; returns { sceneId, editorUrl }.",
    "GET /orthographic/api/scenes/{id}":
      "The stored scene: { sceneId, revision, editorUrl, document }; ?images=data embeds pixels.",
    "PUT /orthographic/api/scenes/{id}":
      "Body: { baseRevision, document }. Replaces the scene; 409 if it changed since baseRevision.",
    "POST /orthographic/api/scenes/{id}/images": "Body: image bytes (?name=). Returns { id, width, height }.",
    "GET /orthographic/api/scenes/{id}/events":
      "Server-sent events: event revision, data { revision }, once now and on every change.",
    "GET /orthographic/api/scenes/{id}/render/{view}.png":
      "A render of the stored scene (?width, height, references, labels, grid).",
    "GET /orthographic/api/scenes/{id}/export/{file}":
      "scene.json, agent.json, objects.csv, views.svg or editor.html (the editor with the scene inside).",
  },
});

// ---- Stateless document endpoints ------------------------------------------------------------

async function validate(req: Request) {
  const read = validateDocument(await readJson(req), { geometry: false });
  const issues = [...read.issues, ...(read.state ? await checkGeometry(read.state) : [])];
  return json({ ok: !issues.some((i) => i.severity === "error"), issues });
}

function pngResponse(out: { ok: boolean; issues: unknown[]; images?: Record<string, string> }, view: string) {
  if (!out.ok || !out.images?.[view]) return json(out, 422);
  return new Response(pngBytes(out.images[view]), {
    headers: {
      "Content-Type": "image/png",
      "X-Issues": encodeURIComponent(JSON.stringify(out.issues)).slice(0, 7000),
      ...CORS,
    },
  });
}

const boolParam = (url: URL, k: string) => (url.searchParams.has(k) ? url.searchParams.get(k) !== "false" : undefined);
const numParam = (url: URL, k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
const renderQuery = (url: URL) => ({
  width: numParam(url, "width"),
  height: numParam(url, "height"),
  references: boolParam(url, "references"),
  labels: boolParam(url, "labels"),
  grid: boolParam(url, "grid"),
});

// ---- Stored scenes ----------------------------------------------------------------------------

function events(scene: Scene, req: Request, server: Server<unknown>) {
  // A long-lived stream: no idle timeout; a comment every 20 s keeps proxies from closing it.
  server.timeout(req, 0);
  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      send(`retry: 3000\nevent: revision\ndata: ${JSON.stringify({ revision: scene.revision })}\n\n`);
      const unsubscribe = subscribe(scene.id, (revision) =>
        send(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`),
      );
      const ping = setInterval(() => send(": ping\n\n"), 20_000);
      stop = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => stop());
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...CORS },
  });
}

const attachment = (scene: Scene, name: string) => ({
  "Content-Disposition": `attachment; filename="${
    scene.state.scene.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "scene"
  }.${name}"`,
});

async function exportScene(scene: Scene, file: string): Promise<Response> {
  const headers = { ...CORS, ...attachment(scene, file) };
  switch (file) {
    case "scene.json":
      return Response.json(sceneDocument(scene, { images: "data" }), { headers });
    case "agent.json":
      return Response.json(sceneDocument(scene, { images: "metadata" }), { headers });
    case "objects.csv":
      return new Response(objectsCsv(scene.state), {
        headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
      });
    case "views.svg": {
      const out = await projectionSheet(sceneDocument(scene, { images: "data" }));
      if (!out.svg) return json(out, 422);
      return new Response(out.svg, { headers: { ...headers, "Content-Type": "image/svg+xml" } });
    }
    case "editor.html": {
      const page = Bun.file(new URL("dist/orthographic/index.html", ROOT));
      if (!(await page.exists())) return problem(503, "no-build", "The editor is not built on this server (dev mode).");
      const doc = JSON.stringify(sceneDocument(scene, { images: "data" })).replace(/</g, "\\u003c");
      const tag = '<script id="embedded-document" type="application/json">null</script>';
      const html = (await page.text()).replace(tag, () => tag.replace(">null<", `>${doc}<`));
      return new Response(html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    }
  }
  return problem(404, "not-found", "Export formats: scene.json, agent.json, objects.csv, views.svg, editor.html.");
}

async function sceneRoutes(req: Request, rest: string[], server: Server<unknown>, ctx: ToolContext) {
  if (!rest.length) {
    if (req.method !== "POST") return problem(405, "method-not-allowed", "POST a document to create a scene.");
    const body = await readJson(req);
    if (body === undefined) {
      const scene = createScene();
      return json(
        { ok: true, issues: [], sceneId: scene.id, revision: scene.revision, editorUrl: editorUrl(ctx, scene) },
        201,
      );
    }
    const read = await readDocument(body);
    if (!read.state) return json({ ok: false, issues: read.issues }, 422);
    const scene = createScene(read.state, read.images);
    return json(
      { ok: true, issues: read.issues, sceneId: scene.id, revision: scene.revision, editorUrl: editorUrl(ctx, scene) },
      201,
    );
  }
  const scene = getScene(rest[0]);
  if (!scene) return problem(404, "unknown-scene", `There is no scene "${rest[0]}".`);
  const url = new URL(req.url);
  const [, sub, leaf] = rest;
  if (sub === undefined) {
    if (req.method === "GET") {
      const images = url.searchParams.get("images");
      return json(
        {
          ok: true,
          issues: [],
          sceneId: scene.id,
          revision: scene.revision,
          editorUrl: editorUrl(ctx, scene),
          document: sceneDocument(scene, {
            images: images === "data" || images === "none" ? images : "metadata",
            derived: url.searchParams.get("derived") !== "false",
          }),
        },
        200,
        { ETag: `"${scene.revision}"` },
      );
    }
    if (req.method === "PUT") {
      const body = (await readJson(req)) as { baseRevision?: number; document?: unknown } | undefined;
      if (!body || typeof body !== "object" || !("document" in body))
        throw new BadRequest("Send { baseRevision, document }.");
      if (body.baseRevision !== undefined && body.baseRevision !== scene.revision)
        return json(
          {
            ok: false,
            revision: scene.revision,
            issues: [
              {
                severity: "error",
                code: "revision-conflict",
                path: "",
                message: `The scene changed (now revision ${scene.revision}, not ${body.baseRevision}); load it again.`,
              },
            ],
          },
          409,
        );
      const read = await readDocument(body.document, scene);
      if (!read.state) return json({ ok: false, issues: read.issues, revision: scene.revision }, 422);
      replaceScene(scene, read.state, read.images);
      return json({ ok: true, issues: read.issues, revision: scene.revision });
    }
    return problem(405, "method-not-allowed", "GET or PUT a scene.");
  }
  if (sub === "images" && leaf === undefined && req.method === "POST") {
    // The editor keeps its own id for an image a document named (not every id is a content hash).
    const id = url.searchParams.get("id") ?? undefined;
    if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id))
      throw new BadRequest("id is not a valid image id.");
    const img = await addImage(
      scene,
      new Uint8Array(await req.arrayBuffer()),
      url.searchParams.get("name") ?? "image",
      id,
    );
    return json({
      ok: true,
      issues: [],
      id: img.id,
      name: img.name,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
    });
  }
  if (sub === "events" && leaf === undefined && req.method === "GET") return events(scene, req, server);
  const png = sub === "render" && req.method === "GET" && /^(front|top|side|perspective)\.png$/.exec(leaf ?? "");
  if (png) {
    const view = png[1];
    const out = await render(
      sceneDocument(scene, { images: "data" }),
      { views: [view], ...renderQuery(url) },
      `${scene.id}@${scene.revision}`,
    );
    return pngResponse(out, view);
  }
  if (sub === "export" && leaf && req.method === "GET") return exportScene(scene, leaf);
  return problem(404, "not-found", "Unknown scene endpoint; GET /orthographic/api lists them.");
}

// ---- Dispatch -----------------------------------------------------------------------------------

const TOOL_STATUS: Record<string, number> = {
  "unknown-tool": 404,
  "unknown-scene": 404,
  busy: 503,
  "storage-full": 507,
  "internal-error": 500,
};

async function route(req: Request, path: string, server: Server<unknown>): Promise<Response> {
  const ctx = contextOf(req);
  const parts = path
    .replace(/^\/orthographic\/api\/?/, "")
    .split("/")
    .filter(Boolean);
  if (!parts.length) return json(API_INDEX(ctx));
  const [head, ...rest] = parts;
  if (head === "scenes") return sceneRoutes(req, rest, server, ctx);
  if (head === "tools") {
    if (!rest.length && req.method === "GET")
      return json(
        TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
      );
    if (rest.length === 1 && req.method === "POST") {
      const out = await callTool(rest[0], await readJson(req), ctx);
      return json(out, out.ok ? 200 : (TOOL_STATUS[out.issues[0]?.code] ?? 200));
    }
    return problem(405, "method-not-allowed", "GET /tools lists them; POST /tools/{name} runs one.");
  }
  if (req.method !== "POST") return problem(405, "method-not-allowed", "Use POST.", { Allow: "POST, OPTIONS" });
  if (head === "validate" && !rest.length) return validate(req);
  if (head === "render" && !rest.length) {
    const body = (await readJson(req)) as { document?: unknown } | undefined;
    if (!body || typeof body !== "object" || !("document" in body))
      throw new BadRequest("Send { document, views?, width?, height? }.");
    const { document, ...options } = body as { document: unknown };
    const out = await render(document, options);
    return json(out, out.ok ? 200 : 422);
  }
  const png = head === "render" && rest.length === 1 && /^(front|top|side|perspective)\.png$/.exec(rest[0]);
  if (png) {
    const url = new URL(req.url);
    const out = await render(await readJson(req), { views: [png[1]], ...renderQuery(url) });
    return pngResponse(out, png[1]);
  }
  return problem(404, "not-found", "Unknown API endpoint; GET /orthographic/api lists them.");
}

export async function handleApi(req: Request, server: Server<unknown>): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname;
  try {
    if (path === "/orthographic/mcp") {
      const res = await handleMcp(req, contextOf(req));
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    }
    return await route(req, path, server);
  } catch (e) {
    if (e instanceof BadRequest) return problem(400, "bad-request", e.message);
    if (e instanceof Busy) return problem(503, "busy", e.message, { "Retry-After": "5" });
    if (e instanceof StoreError) return problem(e.code === "storage-full" ? 507 : 400, e.code, e.message);
    console.error(e);
    return problem(500, "internal-error", "The request failed.");
  }
}
