// 3d.tris.sh: the 3D tools and their APIs.
//
//   /orthographic/              the editor (one self-contained HTML file, built by Vite)
//   /orthographic/llms.txt      guide for agents
//   /orthographic/schema.json   the scene document's JSON Schema
//   /orthographic/mcp           MCP server (api/mcp.ts)
//   /orthographic/api/...       HTTP API (api/http.ts)
//
// Every route is explicit, so no request path reaches the filesystem.
// API_ONLY=1 (scripts/dev.ts) serves just the APIs and spec files while Vite
// serves the editor; EDITOR_URL then points the renderer at Vite.

import { closeBrowser } from "./api/browser";
import { CORS, handleApi } from "./api/http";
import { sweep } from "./api/scenes";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = new URL(".", import.meta.url);
const MAX_BODY = 64 * 1024 * 1024;

const file = (path: string) => Bun.file(new URL(path, ROOT));
const redirect =
  (to: string, status = 301) =>
  () =>
    new Response(null, { status, headers: { Location: to } });

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
  // Renders take seconds before the first byte; event streams opt out per request.
  idleTimeout: 120,
  routes: process.env.API_ONLY ? spec : { ...spec, ...editor },
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/orthographic/api") || path === "/orthographic/mcp") return handleApi(req, server);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`3d listening on http://localhost:${PORT}/orthographic/`);

// Expire old scenes now and daily.
sweep();
setInterval(sweep, 24 * 3600 * 1000).unref();

// Close the renderer's Chromium with the server, or it outlives it.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
