// Static file host for the built rope app. No game logic runs here — the sim is
// entirely client-side; this just serves dist/ (with an index.html fallback).

import { file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(import.meta.dir, "dist");

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = normalize(decodeURIComponent(url.pathname));
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const full = join(DIST, pathname);
    // Reject path traversal outside DIST.
    if (full !== DIST && !full.startsWith(DIST + "/")) {
      return new Response("forbidden", { status: 403 });
    }

    let f = file(full);
    if (!(await f.exists())) f = file(join(DIST, "index.html"));
    return new Response(f);
  },
});

console.log(`rope serving dist/ on :${PORT}`);
