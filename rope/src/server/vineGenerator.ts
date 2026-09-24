import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { Plugin } from "vite";

const VARIANTS = ["curtain", "cascade", "tangle"] as const;
type VineVariant = typeof VARIANTS[number];

export function vineGenerator(): Plugin {
  let busy = false;
  return {
    name: "vine-generator-v3",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.ROOTS_PROJECT ?? resolve(project, "../../../assets/roots");
      const blender = process.env.BLENDER_PATH ?? (process.platform === "win32"
        ? "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" : "blender");
      server.middlewares.use("/generated-vines", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(vine\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        try {
          const file = join(project, "public", "generated-vines", match[1], match[2]);
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Vine mesh not found"); }
      });
      server.middlewares.use("/api/vines", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate vines." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate vines from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "A vine is already generating. Try again when it finishes." });
        let variant: VineVariant, seed: number;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 4000) throw new Error("Vine request is too large.");
          }
          const value = JSON.parse(body) as { variant?: unknown; seed?: unknown };
          if (!VARIANTS.includes(value.variant as VineVariant)) throw new Error("Choose curtain, cascade, or tangle.");
          if (!Number.isInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 2147483647)
            throw new Error("Seed must be an integer from 0 to 2147483647.");
          variant = value.variant as VineVariant;
          seed = value.seed as number;
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid vine request." });
        }
        const script = join(source, "procedural_vines_v3.py");
        if (!existsSync(script)) return send(503, { error: "Vine generator not found. Set ROOTS_PROJECT to the roots project directory." });
        if (busy) return send(409, { error: "A vine is already generating. Try again when it finishes." });
        busy = true;
        let scratch: string | undefined;
        try {
          const id = randomUUID();
          scratch = await mkdtemp(join(tmpdir(), "trisball-vine-v3-"));
          await new Promise<void>((done, fail) => {
            execFile(blender, ["--background", "--factory-startup", "--python-exit-code", "1",
              "--python", script, "--", "--out", scratch!, "--variant", variant, "--seed", String(seed)],
            { windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error) fail(new Error(`Vine generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const file = join(scratch, `vine_${variant}_LOD0.glb`);
          const { size } = await stat(file);
          const out = join(project, "public", "generated-vines", id);
          await mkdir(out, { recursive: true });
          await copyFile(file, join(out, "vine.glb"));
          send(200, { mesh: `vine-v3:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Vine generation failed." });
        } finally {
          busy = false;
          if (scratch) {
            try { await rm(scratch, { recursive: true, force: true }); }
            catch (e) { server.config.logger.warn(`Could not remove vine scratch directory: ${e}`); }
          }
        }
      });
    },
  };
}
