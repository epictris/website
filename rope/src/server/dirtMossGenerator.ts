import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export interface DirtMossRequest { polygon: number[][]; seed: number; depth: number; moss: number }

export function validateDirtMossRequest(value: unknown): DirtMossRequest {
  const v = value as DirtMossRequest;
  if (!v || !Array.isArray(v.polygon) || v.polygon.length < 3 || v.polygon.length > 128 ||
      v.polygon.some(p => !Array.isArray(p) || p.length !== 2 ||
        p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100)))
    throw new Error("Use a polygon with 3–128 vertices, within 100 metres of its origin.");
  if (!Number.isInteger(v.seed) || v.seed < 0 || v.seed > 2147483647)
    throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (!Number.isFinite(v.depth) || v.depth < 0.02 || v.depth > 5)
    throw new Error("Visual depth must be between 0.02 and 5 metres.");
  if (!Number.isFinite(v.moss) || v.moss < 0 || v.moss > 1)
    throw new Error("Moss coverage must be between 0 and 1.");
  return v;
}

export function dirtMossGenerator(): Plugin {
  let busy = false;
  return {
    name: "dirt-moss-generator",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.DIRT_MOSS_PROJECT ?? resolve(project, "../asset-generators/dirt_moss");
      server.middlewares.use("/generated-dirt-moss", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(dirt\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        try {
          const file = join(project, "public", "generated-dirt-moss", match[1], match[2]);
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Dirt and moss mesh not found"); }
      });
      server.middlewares.use("/api/dirt-moss", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate dirt and moss." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate dirt and moss from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "Dirt and moss are already generating." });
        let input: DirtMossRequest;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 32000) throw new Error("Dirt and moss request is too large.");
          }
          input = validateDirtMossRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid dirt and moss request." });
        }
        const script = join(source, "dirtgen.py");
        if (!existsSync(script)) return send(503, { error: "Dirt and moss generator not found. Set DIRT_MOSS_PROJECT." });
        if (busy) return send(409, { error: "Dirt and moss are already generating." });
        busy = true;
        let scratch: string | undefined;
        try {
          const id = randomUUID();
          const out = join(project, "public", "generated-dirt-moss", id);
          scratch = await mkdtemp(join(tmpdir(), "trisball-dirt-moss-"));
          const spec = join(scratch, "polygon.json");
          const area = Math.abs(input.polygon.reduce((sum, point, i) => {
            const next = input.polygon[(i + 1) % input.polygon.length];
            return sum + point[0] * next[1] - next[0] * point[1];
          }, 0) / 2);
          if (area < 0.0001) throw new Error("Dirt outline is too small or has zero area.");
          await writeFile(spec, JSON.stringify({
            plane: "CAMERA", units: "metres",
            defaults: {
              depth: input.depth, seed: input.seed, moss: input.moss,
              tolerance: Math.min(0.07, Math.sqrt(area) * 0.09),
              fit_mode: "playable_perimeter",
            },
            blocks: [{ name: "dirt", outer: input.polygon }],
          }));
          await new Promise<void>((done, fail) => {
            execFile(process.env.PYTHON_PATH ?? "python", [script, spec, "--output", scratch!,
              "--no-render", "--samples", "16"],
            { windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error) fail(new Error(`Dirt and moss generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const { size } = await stat(join(scratch, "models", "dirt.glb"));
          await mkdir(out, { recursive: true });
          await copyFile(join(scratch, "models", "dirt.glb"), join(out, "dirt.glb"));
          await copyFile(spec, join(out, "polygon.json"));
          send(200, { mesh: `dirt-moss:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Dirt and moss generation failed." });
        } finally {
          busy = false;
          if (scratch) {
            try { await rm(scratch, { recursive: true, force: true }); }
            catch (e) { server.config.logger.warn(`Could not remove dirt and moss scratch directory: ${e}`); }
          }
        }
      });
    },
  };
}
