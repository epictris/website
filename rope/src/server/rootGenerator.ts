import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Plugin } from "vite";

export interface RootRequest { polygon: number[][]; seed: number; depth: number }

export function validateRootRequest(value: unknown): RootRequest {
  const v = value as RootRequest;
  if (!v || !Array.isArray(v.polygon) || v.polygon.length < 3 || v.polygon.length > 128 ||
      v.polygon.some(p => !Array.isArray(p) || p.length !== 2 ||
        p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100))) {
    throw new Error("Use a polygon with 3–128 vertices, within 100 metres of its origin.");
  }
  if (!Number.isInteger(v.seed) || v.seed < 0 || v.seed > 2147483647)
    throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (!Number.isFinite(v.depth) || v.depth < 0.02 || v.depth > 5)
    throw new Error("Visual depth must be between 0.02 and 5 metres.");
  return v;
}

// Generation runs only on the dev server. The exported GLB is a normal public
// asset, so saved levels and production builds do not require Blender.
export function rootGenerator(): Plugin {
  let busy = false;
  return {
    name: "root-generator",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.ROOTS_PROJECT ?? resolve(project, "../../../assets/roots");
      const blender = process.env.BLENDER_PATH ?? (process.platform === "win32"
        ? "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" : "blender");
      // These files are deliberately outside Vite's watcher: exporting a mesh
      // must not reload the editor and discard its unsaved model. Serve them
      // directly because Vite's cached public-file list predates generation.
      server.middlewares.use("/generated-roots", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(roots_LOD[012]\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const file = join(project, "public", "generated-roots", match[1], match[2]);
        try {
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Root mesh not found"); }
      });
      server.middlewares.use("/api/roots", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate roots." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate roots from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "A root is already generating. Try again when it finishes." });
        let input: RootRequest;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 32000) throw new Error("Root request is too large.");
          }
          input = validateRootRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid root request." });
        }
        const script = join(source, "blender_polygon_roots.py");
        if (!existsSync(script)) return send(503, { error: "Root generator not found. Set ROOTS_PROJECT to the roots project directory." });
        // Another request may have finished reading its body while this one
        // was awaiting chunks. Claim the slot only after all awaited reads.
        if (busy) return send(409, { error: "A root is already generating. Try again when it finishes." });
        busy = true;
        try {
          const id = randomUUID();
          const out = join(project, "public", "generated-roots", id);
          await mkdir(out, { recursive: true });
          const blockout = join(out, "blockout.json");
          await writeFile(blockout, JSON.stringify({
            version: 2, units: "meters", up_axis: "Y", gameplay: "2D",
            roots: [{ id: "root", polygon: input.polygon,
              grab_edges: input.polygon.map((_, i) => i), depth: input.depth,
              corner_rounding: 0, broken_edges: [] }],
          }));
          await new Promise<void>((done, fail) => {
            execFile(blender, ["--background", "--factory-startup", "--python-exit-code", "1",
              "--python", script, "--", "--input", blockout, "--out", out,
              "--seed", String(input.seed)],
            { windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error) fail(new Error(`Root generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const { size } = await stat(join(out, "roots_LOD0.glb"));
          await writeFile(join(out, "generation.json"), JSON.stringify({ seed: input.seed, depth: input.depth, source }));
          send(200, { mesh: `root:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Root generation failed." });
        } finally { busy = false; }
      });
    },
  };
}
