import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

// The faces picked in the editor, as a flat triangle soup in the three.js frame
// relative to the patch origin (x right, y up, z toward the camera, metres),
// and the growth settings the Blender node group takes.
export interface MushroomRequest {
  positions: number[];
  seed: number;
  density: number;
  height: number;
  clumping: number;
  detail: number;
}

export const MUSHROOM_MAX_TRIANGLES = 40000;
// The node group's No Overlaps pass is exact and pairwise, so its cost grows
// with the square of the count; past this the bake stops being interactive.
export const MUSHROOM_MAX_ESTIMATE = 3000;

export function soupArea(positions: readonly number[]): number {
  let area = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ux = positions[i + 3]! - positions[i]!, uy = positions[i + 4]! - positions[i + 1]!, uz = positions[i + 5]! - positions[i + 2]!;
    const vx = positions[i + 6]! - positions[i]!, vy = positions[i + 7]! - positions[i + 1]!, vz = positions[i + 8]! - positions[i + 2]!;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

export function validateMushroomRequest(value: unknown): MushroomRequest {
  const v = value as MushroomRequest;
  if (!v || !Array.isArray(v.positions) || v.positions.length < 9 || v.positions.length % 9 !== 0 ||
      v.positions.length > MUSHROOM_MAX_TRIANGLES * 9 ||
      v.positions.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100))
    throw new Error(`Select 1–${MUSHROOM_MAX_TRIANGLES} faces within 100 metres of the patch origin.`);
  if (!Number.isInteger(v.seed) || v.seed < 0 || v.seed > 2147483647)
    throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (!Number.isFinite(v.density) || v.density < 1 || v.density > 2000)
    throw new Error("Density must be between 1 and 2000 per square metre.");
  if (!Number.isFinite(v.height) || v.height < 0.01 || v.height > 2)
    throw new Error("Height must be between 0.01 and 2 metres.");
  if (!Number.isFinite(v.clumping) || v.clumping < 0 || v.clumping > 1)
    throw new Error("Clumping must be between 0 and 1.");
  if (!Number.isFinite(v.detail) || v.detail < 0 || v.detail > 1)
    throw new Error("Detail must be between 0 and 1.");
  const area = soupArea(v.positions);
  if (area < 1e-4) throw new Error("The selected surface is too small or has zero area.");
  if (area * v.density > MUSHROOM_MAX_ESTIMATE)
    throw new Error(`About ${Math.round(area * v.density)} mushrooms (${area.toFixed(2)} m²); ` +
      `lower the density or select less than ${MUSHROOM_MAX_ESTIMATE} / density m².`);
  return v;
}

// The Mushroom Patch add-on (Geometry Nodes, baked textures) lives in
// asset-generators/mushrooms. Generated GLBs are copied into this game's public
// directory so saved levels need no generator at play time.
export function mushroomGenerator(): Plugin {
  let busy = false;
  return {
    name: "mushroom-patch-generator",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.MUSHROOMS_PROJECT ?? resolve(project, "../asset-generators/mushrooms");
      const blender = process.env.BLENDER_PATH ?? (process.platform === "win32"
        ? "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" : "blender");
      server.middlewares.use("/generated-mushrooms", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(mushrooms\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        try {
          const file = join(project, "public", "generated-mushrooms", match[1], match[2]);
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Mushroom mesh not found"); }
      });
      server.middlewares.use("/api/mushrooms", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate mushrooms." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate mushrooms from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "A mushroom patch is already generating." });
        let input: MushroomRequest;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 12_000_000) throw new Error("Mushroom request is too large; select fewer faces.");
          }
          input = validateMushroomRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid mushroom request." });
        }
        const script = join(source, "editor_patch.py");
        if (!existsSync(script)) return send(503, { error: "Mushroom generator not found. Set MUSHROOMS_PROJECT." });
        if (busy) return send(409, { error: "A mushroom patch is already generating." });
        busy = true;
        let scratch: string | undefined;
        try {
          const id = randomUUID();
          scratch = await mkdtemp(join(tmpdir(), "trisball-mushrooms-"));
          const spec = join(scratch, "patch.json");
          await writeFile(spec, JSON.stringify(input));
          await new Promise<void>((done, fail) => {
            execFile(blender, ["--background", "--factory-startup", "--python-exit-code", "1",
              "--python", script, "--", "--spec", spec, "--out", scratch!],
            { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
              const said = /MUSHROOMS: (.*)/.exec(stdout + stderr)?.[1];
              if (error) fail(new Error(said && !said.includes("->") ? said
                : `Mushroom generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const file = join(scratch, "mushrooms.glb");
          const { size } = await stat(file);
          const out = join(project, "public", "generated-mushrooms", id);
          await mkdir(out, { recursive: true });
          await copyFile(file, join(out, "mushrooms.glb"));
          await copyFile(spec, join(out, "patch.json"));
          send(200, { mesh: `mushroom-patch:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Mushroom generation failed." });
        } finally {
          busy = false;
          if (scratch) {
            try { await rm(scratch, { recursive: true, force: true }); }
            catch (e) { server.config.logger.warn(`Could not remove mushroom scratch directory: ${e}`); }
          }
        }
      });
    },
  };
}
