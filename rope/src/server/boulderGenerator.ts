import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
export interface BoulderRequest { polygon: number[][]; seed: number; depth: number }

export function validateBoulderRequest(value: unknown): BoulderRequest {
  const v = value as BoulderRequest;
  if (!v || !Array.isArray(v.polygon) || v.polygon.length < 3 || v.polygon.length > 128 ||
      v.polygon.some(p => !Array.isArray(p) || p.length !== 2 ||
        p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100)))
    throw new Error("Use a polygon with 3–128 vertices, within 100 metres of its origin.");
  if (!Number.isInteger(v.seed) || v.seed < 0 || v.seed > 2147483647)
    throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (!Number.isFinite(v.depth) || v.depth < 0.02 || v.depth > 5)
    throw new Error("Visual depth must be between 0.02 and 5 metres.");
  return v;
}

// The v5 source remains in the local assets project. Generated GLBs are copied
// into this game's public directory so saved levels need no generator at play time.
export function boulderGenerator(): Plugin {
  let busy = false;
  return {
    name: "boulder-generator-v5",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.BOULDERS_V5_PROJECT ??
        resolve(project, "../../../assets/boulders/stylised_rocks_v5");
      server.middlewares.use("/generated-boulders", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(boulder\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        try {
          const file = join(project, "public", "generated-boulders", match[1], match[2]);
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Boulder mesh not found"); }
      });
      server.middlewares.use("/api/boulders", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate a boulder." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate boulders from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "A boulder is already generating." });
        let input: BoulderRequest;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 32000) throw new Error("Boulder request is too large.");
          }
          input = validateBoulderRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid boulder request." });
        }
        const script = join(source, "rockgen.py");
        if (!existsSync(script)) return send(503, { error: "V5 boulder generator not found. Set BOULDERS_V5_PROJECT." });
        if (busy) return send(409, { error: "A boulder is already generating." });
        busy = true;
        let scratch: string | undefined;
        try {
          const id = randomUUID();
          const out = join(project, "public", "generated-boulders", id);
          scratch = await mkdtemp(join(tmpdir(), "trisball-boulder-v5-"));
          const spec = join(scratch, "polygon.json");
          const area = Math.abs(input.polygon.reduce((sum, point, i) => {
            const next = input.polygon[(i + 1) % input.polygon.length];
            return sum + point[0] * next[1] - next[0] * point[1];
          }, 0) / 2);
          if (area < 0.0001) throw new Error("Boulder outline is too small or has zero area.");
          await writeFile(spec, JSON.stringify({
            plane: "CAMERA", units: "metres",
            defaults: {
              depth: input.depth, seed: input.seed, slabs: 24,
              tolerance: Math.min(0.04, Math.sqrt(area) * 0.04),
              fracture_angle: 4, detail: 1, color: [0.13, 0.15, 0.18],
              weathering: 0.38, strata: 0.08, secondary_slabs: 0.12,
              edge_variation: 1, fit_mode: "playable_perimeter",
              chunked_sides: true, hybrid_faces: true, broad_side_chunks: true,
              soften_thin_edges: true, solid_chunk_edges: true, join_undercuts: false,
            },
            rocks: [{ name: "boulder", outer: input.polygon }],
          }));
          await new Promise<void>((done, fail) => {
            execFile(process.env.PYTHON_PATH ?? "python", [script, spec, "--output", scratch!,
              "--no-render", "--samples", "16"],
            { windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error) fail(new Error(`Boulder generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const { size } = await stat(join(scratch, "models", "boulder.glb"));
          await mkdir(out, { recursive: true });
          await copyFile(join(scratch, "models", "boulder.glb"), join(out, "boulder.glb"));
          await copyFile(spec, join(out, "polygon.json"));
          send(200, { mesh: `boulder-v5:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Boulder generation failed." });
        } finally {
          busy = false;
          if (scratch) {
            try { await rm(scratch, { recursive: true, force: true }); }
            catch (e) { server.config.logger.warn(`Could not remove boulder scratch directory: ${e}`); }
          }
        }
      });
    },
  };
}
