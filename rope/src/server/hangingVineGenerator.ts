import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";

const UUID = /^[a-f0-9-]{36}$/;
const MAX_BODY = 24 * 1024 * 1024;
const MIN_GLB = 20;
const MAX_GLB = 16 * 1024 * 1024;

type RequestBody = { glb?: unknown; recipe?: unknown; hostId?: unknown; hostMesh?: unknown; hostIndex?: unknown };

function validRecipe(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || !r.settings || typeof r.settings !== "object") return false;
  for (const name of ["start", "normal", "direction"])
    if (!Array.isArray(r[name]) || (r[name] as unknown[]).length !== 3 ||
      !(r[name] as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1000)) return false;
  const s = r.settings as Record<string, unknown>;
  const ranges: Record<string, [number, number]> = {
    length: [0.05, 30], radius: [0.001, 0.06], cling: [0, 1], bend: [0, 1],
    leafSpacing: [0.04, 2], leafSize: [0.03, 1], leafAngle: [5, 85],
    variation: [0, 1], seed: [0, 2147483647],
  };
  for (const [name, [min, max]] of Object.entries(ranges))
    if (typeof s[name] !== "number" || !Number.isFinite(s[name]) || (s[name] as number) < min || (s[name] as number) > max) return false;
  return Number.isInteger(s.seed) && typeof s.leafStyle === "string" &&
    /^(mixed|heart|lobed|heart-offset)$/.test(s.leafStyle);
}

export function hangingVineGenerator(): Plugin {
  return {
    name: "hanging-vine-generator",
    configureServer(server) {
      const root = join(server.config.root, "public", "generated-vines");
      server.middlewares.use("/api/hanging-vines", async (req, res) => {
        const send = (code: number, data: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(data));
        };
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET") {
          const id = path.replace(/^\//, "");
          if (!UUID.test(id)) return send(404, { error: "Vine recipe not found." });
          try { return send(200, JSON.parse(await readFile(join(root, id, "recipe.json"), "utf8"))); }
          catch { return send(404, { error: "Vine recipe not found." }); }
        }
        if (req.method !== "POST")
          return send(405, { error: "Use POST to save a hanging vine." });
        if (req.headers.origin) {
          try {
            const origin = new URL(req.headers.origin);
            const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:";
            if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
          }
          catch { return send(403, { error: "Save vines from this editor's origin." }); }
        }
        if (path === "/preview") {
          if (!String(req.headers["content-type"] ?? "").startsWith("model/gltf-binary"))
            return send(415, { error: "Expected a binary GLB preview." });
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > MAX_BODY) return send(413, { error: "Preview GLB is too large." });
              chunks.push(chunk);
            }
            const glb = Buffer.concat(chunks);
            if (glb.length < MIN_GLB || glb.toString("ascii", 0, 4) !== "glTF" ||
              glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length)
              return send(400, { error: "Invalid glTF 2.0 binary preview." });
            const file = "/hanging-vines/rock-with-hanging-vines.glb";
            const directory = join(server.config.root, "public", "hanging-vines");
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "rock-with-hanging-vines.glb"), glb);
            return send(200, { file, bytes: glb.length });
          } catch (error) {
            return send(500, { error: error instanceof Error ? error.message : "Could not save preview." });
          }
        }
        if (path !== "" && path !== "/")
          return send(405, { error: "Use POST to save a hanging vine." });
        try {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
            return send(415, { error: "Expected JSON." });
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) return send(413, { error: "Hanging vine is too large." });
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
          if (!validRecipe(body.recipe) || !Number.isSafeInteger(body.hostId) || (body.hostId as number) < 0)
            return send(400, { error: "Invalid hanging vine recipe." });
          if (typeof body.hostMesh !== "string" || body.hostMesh.length > 300)
            return send(400, { error: "Invalid host reference." });
          if (!Number.isSafeInteger(body.hostIndex) || (body.hostIndex as number) < 0 || (body.hostIndex as number) > 10000)
            return send(400, { error: "Invalid host index." });
          if (typeof body.glb !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.glb))
            return send(400, { error: "Invalid vine mesh." });
          const glb = Buffer.from(body.glb, "base64");
          if (glb.length < MIN_GLB || glb.length > MAX_GLB || glb.toString("ascii", 0, 4) !== "glTF" ||
            glb.readUInt32LE(8) !== glb.length)
            return send(400, { error: "Invalid or oversized GLB." });
          const id = randomUUID();
          const dir = join(root, id);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "vine.glb"), glb);
          await writeFile(join(dir, "recipe.json"), JSON.stringify({ hostId: body.hostId, hostMesh: body.hostMesh,
            hostIndex: body.hostIndex, recipe: body.recipe }));
          return send(200, { mesh: `vine-v3:${id}:${glb.length}` });
        } catch (error) {
          return send(500, { error: error instanceof Error ? error.message : "Could not save vine." });
        }
      });
    },
  };
}
