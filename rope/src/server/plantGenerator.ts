import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

// The faces picked in the editor, as a flat triangle soup in the three.js frame
// relative to the patch origin (x right, y up, z toward the camera, metres),
// and the growth settings `asset-generators/plants/editor_patch.py` takes.
export const PLANT_TYPES = ["alocasia", "birdsnest", "fern", "creepers", "ivy"] as const;
export type PlantType = (typeof PLANT_TYPES)[number];

export interface PlantRequest {
  positions: number[];
  seed: number;
  density: number;
  size: number;
  ivyLength: number;
  detail: number;
  slope: number;
  types: PlantType[];
}

export const PLANT_MAX_TRIANGLES = 40000;
// Every plant is its own few hundred to thousand triangles and a Blender object
// until the join, so past this the GLB is too heavy to draw and the build too
// slow to wait for.
export const PLANT_MAX_ESTIMATE = 800;
// Ivy vines hang four to a plant's one (see the script's header).
const IVY_PER_DENSITY = 4;

export function soupArea(positions: readonly number[]): number {
  let area = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ux = positions[i + 3]! - positions[i]!, uy = positions[i + 4]! - positions[i + 1]!, uz = positions[i + 5]! - positions[i + 2]!;
    const vx = positions[i + 6]! - positions[i]!, vy = positions[i + 7]! - positions[i + 1]!, vz = positions[i + 8]! - positions[i + 2]!;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

// The most instances the request can ask for: standing plants and creeper
// patches share the up-facing faces, ivy takes the undersides, and the server
// does not know which faces are which, so it takes the larger reading.
export function plantEstimate(area: number, density: number, types: readonly PlantType[]): number {
  const standing = types.some(t => t !== "ivy" && t !== "creepers") ? 1 : 0;
  const creepers = types.includes("creepers") ? 1 : 0;
  const ivy = types.includes("ivy") ? IVY_PER_DENSITY : 0;
  return area * density * Math.max(standing + creepers, ivy);
}

export function validatePlantRequest(value: unknown): PlantRequest {
  const v = value as PlantRequest;
  if (!v || !Array.isArray(v.positions) || v.positions.length < 9 || v.positions.length % 9 !== 0 ||
      v.positions.length > PLANT_MAX_TRIANGLES * 9 ||
      v.positions.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100))
    throw new Error(`Select 1–${PLANT_MAX_TRIANGLES} faces within 100 metres of the patch origin.`);
  if (!Number.isInteger(v.seed) || v.seed < 0 || v.seed > 2147483647)
    throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (!Number.isFinite(v.density) || v.density < 0.05 || v.density > 50)
    throw new Error("Density must be between 0.05 and 50 per square metre.");
  if (!Number.isFinite(v.size) || v.size < 0.1 || v.size > 3)
    throw new Error("Size must be between 0.1 and 3.");
  if (!Number.isFinite(v.ivyLength) || v.ivyLength < 0.2 || v.ivyLength > 4)
    throw new Error("Ivy length must be between 0.2 and 4 metres.");
  if (!Number.isFinite(v.detail) || v.detail < 0 || v.detail > 1)
    throw new Error("Detail must be between 0 and 1.");
  if (!Number.isFinite(v.slope) || v.slope < 0 || v.slope > 90)
    throw new Error("Slope must be between 0 and 90 degrees.");
  if (!Array.isArray(v.types) || !v.types.length || new Set(v.types).size !== v.types.length ||
      v.types.some(t => !PLANT_TYPES.includes(t)))
    throw new Error("Pick at least one plant type.");
  const area = soupArea(v.positions);
  if (area < 1e-4) throw new Error("The selected surface is too small or has zero area.");
  const most = plantEstimate(area, v.density, v.types);
  if (most > PLANT_MAX_ESTIMATE)
    throw new Error(`About ${Math.round(most)} plants (${area.toFixed(2)} m²); ` +
      `lower the density or select less than ${Math.floor(PLANT_MAX_ESTIMATE / most * area)} m².`);
  return v;
}

// The cave foliage generator (`cave_foliage.py` and its editor wrapper) lives in
// asset-generators/plants. Generated GLBs are copied into this game's public
// directory so saved levels need no generator at play time.
export function plantGenerator(): Plugin {
  let busy = false;
  return {
    name: "plant-patch-generator",
    configureServer(server) {
      const project = server.config.root;
      const source = process.env.PLANTS_PROJECT ?? resolve(project, "../asset-generators/plants");
      const blender = process.env.BLENDER_PATH ?? (process.platform === "win32"
        ? "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" : "blender");
      server.middlewares.use("/generated-plants", async (req, res, next) => {
        const match = /^\/([a-f0-9-]{36})\/(plants\.glb)$/.exec((req.url ?? "").split("?")[0]);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        try {
          const file = join(project, "public", "generated-plants", match[1], match[2]);
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.statusCode = 404; res.end("Plant mesh not found"); }
      });
      server.middlewares.use("/api/plants", async (req, res) => {
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.method !== "POST") return send(405, { error: "Use POST to generate plants." });
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch { return send(403, { error: "Generate plants from this editor's origin." }); }
        }
        if (busy) return send(409, { error: "A plant patch is already generating." });
        let input: PlantRequest;
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 12_000_000) throw new Error("Plant request is too large; select fewer faces.");
          }
          input = validatePlantRequest(JSON.parse(body));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : "Invalid plant request." });
        }
        const script = join(source, "editor_patch.py");
        if (!existsSync(script)) return send(503, { error: "Plant generator not found. Set PLANTS_PROJECT." });
        if (busy) return send(409, { error: "A plant patch is already generating." });
        busy = true;
        let scratch: string | undefined;
        try {
          const id = randomUUID();
          scratch = await mkdtemp(join(tmpdir(), "trisball-plants-"));
          const spec = join(scratch, "patch.json");
          await writeFile(spec, JSON.stringify(input));
          await new Promise<void>((done, fail) => {
            execFile(blender, ["--background", "--factory-startup", "--python-exit-code", "1",
              "--python", script, "--", "--spec", spec, "--out", scratch!],
            { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
              const said = /PLANTS: (.*)/.exec(stdout + stderr)?.[1];
              if (error) fail(new Error(said && !said.includes("->") ? said
                : `Plant generation failed: ${(stderr || stdout || error.message).slice(-1800)}`));
              else done();
            });
          });
          const file = join(scratch, "plants.glb");
          const { size } = await stat(file);
          const out = join(project, "public", "generated-plants", id);
          await mkdir(out, { recursive: true });
          await copyFile(file, join(out, "plants.glb"));
          await copyFile(spec, join(out, "patch.json"));
          send(200, { mesh: `plant-patch:${id}:${size}` });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : "Plant generation failed." });
        } finally {
          busy = false;
          if (scratch) {
            try { await rm(scratch, { recursive: true, force: true }); }
            catch (e) { server.config.logger.warn(`Could not remove plant scratch directory: ${e}`); }
          }
        }
      });
    },
  };
}
