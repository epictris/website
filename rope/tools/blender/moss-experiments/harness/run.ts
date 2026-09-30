import { findChromium, grab } from "/home/tris/projects/website/rope/src/tools/shotRunner";
const here = import.meta.dir;
const glb = process.argv[2] ?? "d_hybrid.glb";
const built = await Bun.build({ entrypoints: [here + "/entry.ts"], target: "browser", format: "esm" });
if (!built.success) { console.error(built.logs); process.exit(1); }
const js = await built.outputs[0]!.text();
const server = Bun.serve({ port: 0, async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response(`<!doctype html><html><body><script type="module">${js}</script></body></html>`, { headers: { "content-type": "text/html" } });
  if (u.pathname.startsWith("/out/")) return new Response(Bun.file(here + "/../out/" + u.pathname.slice(5)));
  return new Response("nope", { status: 404 });
} });
const chromium = findChromium(); if (!chromium) throw new Error("no chromium");
const out = here + "/../out/three_" + glb.replace(".glb", "") + (process.argv[3] ? "_nb" + process.argv[3] : "") + (process.argv[4] ? "_mb" + process.argv[4] : "") + (process.argv[5] ? process.argv[5].replace(/[^a-z0-9]/g, "_") : "") + ".png";
const nb = process.argv[3] ?? "0.03"; const mb = process.argv[4] ?? "1"; const extra = process.argv[5] ?? "";
const r = await grab(chromium, { url: `http://localhost:${server.port}/?glb=${glb}&nb=${nb}&mb=${mb}${extra}`, out, gpu: true, width: 1500, height: 500, timeoutMs: 25000 });
for (const l of r.log) if (/materials|info|stress|shadow|rror|warn/i.test(l.text)) console.log(l.level, l.text);
console.log("wrote", out, r.elapsedMs, "ms");
server.stop(true); process.exit(0);
